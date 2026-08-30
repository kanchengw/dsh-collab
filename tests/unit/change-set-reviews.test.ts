import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ActiveRoomRegistry } from "../../src/active-rooms.js";
import { ChangeSetReviewService } from "../../src/change-set-reviews.js";
import type { StagedChangeSet } from "../../src/change-set-staging.js";
import { EventLedger } from "../../src/events.js";
import { CollabGateway } from "../../src/gateway.js";
import { createDshCollabHostRuntime } from "../../src/host-runtime.js";
import { InviteStore } from "../../src/invites.js";
import { CHANGE_SET_CAPABILITY, COLLAB_CAPABILITY_HEADER } from "../../src/protocol.js";
import { RoomStore } from "../../src/room.js";
import { WorkspaceService } from "../../src/workspace-service.js";
import { WorkspaceSharingRegistry } from "../../src/workspace-sharing.js";

function stagedChangeSet(roomId = "room-1"): StagedChangeSet {
  return {
    version: 1,
    changeSetId: "a".repeat(64),
    submittedAt: 100,
    draft: {
      version: 1,
      draftId: "a".repeat(64),
      roomId,
      authorId: "member-author",
      baseWorkspaceVersionId: "version-1",
      title: "Fix reconnect",
      summary: "Keep room state after reconnect.",
      files: [{
        path: "src/reconnect.ts",
        operation: "modify",
        baseContentHash: "b".repeat(64),
        resultContentHash: "c".repeat(64),
        baseSize: 10,
        resultSize: 12,
        additions: 2,
        deletions: 1,
      }],
      artifact: {
        kind: "changeset-draft.v1",
        artifactId: "a".repeat(64),
        manifestHash: "d".repeat(64),
        patchHash: "e".repeat(64),
        patchBytes: 48,
        resultBytes: 12,
      },
      createdAt: 90,
    },
  };
}

function setup() {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1",
    hostId: "principal-host",
    hostSessionId: "session-1",
    title: "Room 1",
    hostDisplayName: "Host",
    now: 1,
  });
  rooms.addMember("room-1", { memberId: "member-author", principalId: "principal-author", displayName: "Author", now: 2 });
  rooms.addMember("room-1", { memberId: "member-reviewer", principalId: "principal-reviewer", displayName: "Reviewer", now: 3 });
  rooms.addMember("room-1", { memberId: "member-other", principalId: "principal-other", displayName: "Other", now: 4 });
  rooms.createRoom({
    roomId: "room-2",
    hostId: "principal-host-2",
    hostSessionId: "session-2",
    title: "Room 2",
    hostDisplayName: "Other Host",
    now: 5,
  });
  const changeSet = stagedChangeSet();
  const changeSets = {
    get: async (roomId: string, changeSetId: string) => roomId === changeSet.draft.roomId && changeSetId === changeSet.changeSetId
      ? structuredClone(changeSet)
      : undefined,
  };
  const ledger = new EventLedger();
  let now = 1000;
  const service = new ChangeSetReviewService({ rooms, changeSets, now: () => now++ });
  return { rooms, ledger, changeSets, service };
}

describe("ChangeSetReviewService", () => {
  it("lets the ChangeSet author assign one active reviewer and the Host reassign it durably", async () => {
    const { service } = setup();
    const events: unknown[] = [];
    service.subscribe((event) => events.push(event));

    const first = await service.assignReviewer({
      roomId: "room-1",
      principalId: "principal-author",
      changeSetId: "a".repeat(64),
      reviewerId: "member-reviewer",
      clientRequestId: "assign-1",
    });
    const retry = await service.assignReviewer({
      roomId: "room-1",
      principalId: "principal-author",
      changeSetId: "a".repeat(64),
      reviewerId: "member-reviewer",
      clientRequestId: "assign-1",
    });

    expect(retry).toEqual(first);
    expect(first.review.requiredReviewerId).toBe("member-reviewer");
    await expect(service.assignReviewer({
      roomId: "room-1",
      principalId: "principal-other",
      changeSetId: "a".repeat(64),
      reviewerId: "member-other",
      clientRequestId: "assign-forbidden",
    })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });

    const reassigned = await service.assignReviewer({
      roomId: "room-1",
      principalId: "principal-host",
      changeSetId: "a".repeat(64),
      reviewerId: "member-host",
      clientRequestId: "assign-2",
    });
    expect(reassigned.assignment.previousReviewerId).toBe("member-reviewer");
    expect(reassigned.review.requiredReviewerId).toBe("member-host");
    expect(events.map((event) => (event as { type: string }).type)).toEqual([
      "changeset.review-assigned",
      "changeset.review-assigned",
    ]);
  });

  it("rejects inactive or foreign reviewers and ChangeSets from another room", async () => {
    const { rooms, service } = setup();
    rooms.setMemberStatus("room-1", "member-reviewer", "suspended", 10);

    await expect(service.assignReviewer({
      roomId: "room-1",
      principalId: "principal-author",
      changeSetId: "a".repeat(64),
      reviewerId: "member-reviewer",
      clientRequestId: "inactive",
    })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
    await expect(service.assignReviewer({
      roomId: "room-1",
      principalId: "principal-author",
      changeSetId: "a".repeat(64),
      reviewerId: "member-foreign",
      clientRequestId: "foreign",
    })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
    await expect(service.getReview({
      roomId: "room-2",
      principalId: "principal-host-2",
      changeSetId: "a".repeat(64),
    })).rejects.toMatchObject({ code: "CHANGE_SET_NOT_FOUND" });
  });

  it("allows every active member to add immutable file or line Findings without using assignment as an ACL", async () => {
    const { rooms, service } = setup();
    const events: unknown[] = [];
    service.subscribe((event) => events.push(event));
    await service.assignReviewer({
      roomId: "room-1",
      principalId: "principal-author",
      changeSetId: "a".repeat(64),
      reviewerId: "member-reviewer",
      clientRequestId: "assign",
    });

    const finding = await service.createFinding({
      roomId: "room-1",
      principalId: "principal-other",
      changeSetId: "a".repeat(64),
      clientRequestId: "finding-1",
      severity: "high",
      location: { kind: "line", path: "src/reconnect.ts", line: 2 },
      body: "Reconnect can still race with restore.",
    });
    expect(finding.finding.authorId).toBe("member-other");
    expect(events.at(-1)).toMatchObject({
      type: "changeset.finding-created",
      roomId: "room-1",
      finding: {
        findingId: finding.finding.findingId,
        changeSetId: finding.finding.changeSetId,
        authorId: finding.finding.authorId,
        severity: finding.finding.severity,
        location: finding.finding.location,
        body: finding.finding.body,
        createdAt: finding.finding.createdAt,
      },
    });

    await expect(service.createFinding({
      roomId: "room-1",
      principalId: "principal-other",
      changeSetId: "a".repeat(64),
      clientRequestId: "bad-path",
      severity: "low",
      location: { kind: "file", path: "src/not-in-change.ts" },
      body: "Wrong file.",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(service.createFinding({
      roomId: "room-1",
      principalId: "principal-other",
      changeSetId: "a".repeat(64),
      clientRequestId: "bad-line",
      severity: "low",
      location: { kind: "line", path: "src/reconnect.ts", line: 0 },
      body: "Wrong line.",
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });

    rooms.setMemberStatus("room-1", "member-other", "removed", 20);
    await expect(service.listFindings({
      roomId: "room-1",
      principalId: "principal-other",
      changeSetId: "a".repeat(64),
    })).rejects.toMatchObject({ code: "MEMBER_INACTIVE" });
  });

  it("makes Finding request IDs idempotent, rejects mutations, and restores append-only history", async () => {
    const { changeSets, ledger, rooms, service } = setup();
    const input = {
      roomId: "room-1",
      principalId: "principal-reviewer",
      changeSetId: "a".repeat(64),
      clientRequestId: "finding-1",
      severity: "medium" as const,
      location: { kind: "general" as const },
      body: "Please add a regression test.",
    };
    const created = await service.createFinding(input);
    expect(await service.createFinding(input)).toEqual(created);
    await expect(service.createFinding({ ...input, body: "Changed body." })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });

    const restored = ChangeSetReviewService.fromSnapshot({ rooms, changeSets, now: () => 2000 }, service.snapshot());
    const page = await restored.listFindings({
      roomId: "room-1",
      principalId: "principal-host",
      changeSetId: "a".repeat(64),
    });
    expect(page.findings).toEqual([created.finding]);
    page.findings[0]!.body = "mutated copy";
    expect((await restored.listFindings({
      roomId: "room-1",
      principalId: "principal-host",
      changeSetId: "a".repeat(64),
    })).findings[0]!.body).toBe("Please add a regression test.");

    const corrupted = service.snapshot();
    corrupted.reviews[0]!.findings[0]!.body = "";
    expect(() => ChangeSetReviewService.fromSnapshot({ rooms, changeSets }, corrupted))
      .toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));

    const mismatched = service.snapshot();
    mismatched.reviews[0]!.findings[0]!.location = { kind: "file", path: "src/not-in-change-set.ts" };
    const mismatchedService = ChangeSetReviewService.fromSnapshot({ rooms, changeSets }, mismatched);
    await expect(mismatchedService.listFindings({
      roomId: "room-1",
      principalId: "principal-host",
      changeSetId: "a".repeat(64),
    })).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
  });

  it("exposes assignment and Finding routes through the authenticated ChangeSet capability", async () => {
    const { changeSets, ledger, rooms, service } = setup();
    const activeRooms = new ActiveRoomRegistry();
    activeRooms.activate("room-1");
    const workspace = new WorkspaceService({ rooms, registry: new WorkspaceSharingRegistry(), now: () => 1000 });
    workspace.setSharing({ roomId: "room-1", principalId: "principal-host", enabled: true });
    const collaborationEvents: unknown[] = [];
    service.subscribe((event) => collaborationEvents.push(event));
    let commits = 0;
    let failNextCommit = true;
    const gateway = new CollabGateway({
      rooms,
      ledger,
      invites: new InviteStore(rooms),
      agent: { followup() {}, steer() {}, cancel() {} },
      workspace,
      activeRooms,
      changeSets: changeSets as never,
      changeSetReviews: service,
      commitCriticalState: async () => {
        commits += 1;
        if (failNextCommit) {
          failNextCommit = false;
          throw new Error("persistence unavailable");
        }
      },
      hostPrincipalId: "principal-host",
      hostDisplayName: "Host",
      ownsHostSession: () => true,
    });
    const author = await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "principal-author" } });
    const other = await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "principal-other" } });
    const headers = (response: typeof author) => ({
      authorization: `Bearer ${(response.body as { roomToken: string }).roomToken}`,
      [COLLAB_CAPABILITY_HEADER]: CHANGE_SET_CAPABILITY,
    });

    const assignRequest = {
      method: "PUT",
      path: `/v1/rooms/room-1/change-sets/${"a".repeat(64)}/reviewer`,
      headers: headers(author),
      body: { clientRequestId: "assign-1", reviewerId: "member-reviewer" },
    } as const;
    await expect(gateway.handle(assignRequest)).resolves.toMatchObject({ status: 500 });
    await expect(gateway.handle(assignRequest)).resolves.toMatchObject({ status: 200, body: { review: { requiredReviewerId: "member-reviewer" } } });
    await expect(gateway.handle({
      method: "GET",
      path: "/v1/rooms/room-1/change-sets/reviews",
      headers: headers(author),
    })).resolves.toMatchObject({
      status: 200,
      body: { reviews: [{ changeSetId: "a".repeat(64), requiredReviewerId: "member-reviewer" }] },
    });
    await expect(gateway.handle({
      method: "POST",
      path: `/v1/rooms/room-1/change-sets/${"a".repeat(64)}/findings`,
      headers: headers(other),
      body: {
        clientRequestId: "finding-1",
        severity: "high",
        location: { kind: "file", path: "src/reconnect.ts" },
        body: "Please cover the reconnect race.",
      },
    })).resolves.toMatchObject({ status: 201, body: { finding: { authorId: "member-other" } } });
    await expect(gateway.handle({
      method: "GET",
      path: `/v1/rooms/room-1/change-sets/${"a".repeat(64)}/findings`,
      headers: headers(author),
    })).resolves.toMatchObject({ status: 200, body: { findings: [{ body: "Please cover the reconnect race." }] } });
    expect(commits).toBe(3);
    expect(collaborationEvents.map((event) => (event as { type: string }).type)).toEqual([
      "changeset.review-assigned",
      "changeset.finding-created",
    ]);
    expect(ledger.readAfter("room-1", 0, 10)).toEqual([]);

    await expect(gateway.handle({
      method: "GET",
      path: `/v1/rooms/room-1/change-sets/${"a".repeat(64)}/review`,
      headers: { authorization: headers(author).authorization },
    })).resolves.toMatchObject({ status: 404 });
  });

  it("wires ChangeSet Review state into the Host runtime snapshot only when staging is available", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-change-set-review-"));
    const runtime = createDshCollabHostRuntime({
      roomId: "room-1",
      hostId: "principal-host",
      hostSessionId: "session-1",
      title: "Room",
      hostDisplayName: "Host",
      sessions: { owns: () => true, followup() {}, steer() {}, cancel() {} },
      workspaceSnapshots: {
        capture: async () => { throw new Error("not used"); },
        load: async () => undefined,
        readChunk: async () => new Uint8Array(),
        readFile: async () => new Uint8Array(),
      },
      changeSetRoot: root,
      changeSetSubprocess: {} as never,
    });
    try {
      expect(runtime.changeSetReviews).toBeDefined();
      expect(runtime.snapshot().changeSetReviews).toEqual({ version: 1, reviews: [] });
    } finally {
      await runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
});
