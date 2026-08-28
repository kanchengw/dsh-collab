import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ReviewFindingCreateInput, WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { EventLedger } from "../../src/events.js";
import { ReviewPointService } from "../../src/review-points.js";
import { ReviewService } from "../../src/reviews.js";
import { RoomStore } from "../../src/room.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function fixture() {
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Release", hostDisplayName: "Host", now: 1 });
  rooms.addMember("room-1", { memberId: "member-bob", principalId: "bob", displayName: "Bob", now: 2 });
  rooms.addMember("room-1", { memberId: "member-carol", principalId: "carol", displayName: "Carol", now: 3 });
  const ledger = new EventLedger();
  const files = [{ path: "src/parser.ts", contentHash: hash("line 1\nline 2\n"), size: 14, source: "tracked" as const }];
  const snapshot: WorkspaceSnapshotPackage = {
    snapshotId: "snapshot-1", roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 0,
    headOid: "a".repeat(40), manifestHash: hash(JSON.stringify(files)), files, createdAt: 10,
  };
  const reviewPoints = new ReviewPointService({ rooms, ledger, snapshots: { load: async () => snapshot }, now: () => 20 });
  const point = reviewPoints.create({
    roomId: "room-1", principalId: "host", clientRequestId: "point-1", title: "Parser review", snapshot,
    files: [{ path: "src/parser.ts", status: "modified", additions: 2, deletions: 1 }],
    diffs: [{ path: "src/parser.ts", kind: "text", oldText: "line 1\n", newText: "line 1\nline 2\n" }],
  });
  const reviews = new ReviewService({ rooms, reviewPoints, now: () => 30 });
  const findings: ReviewFindingCreateInput[] = [
    { severity: "high", location: { kind: "line", path: "src/parser.ts", line: 2 }, body: "Recovery skips the token." },
    { severity: "note", location: { kind: "general" }, body: "Naming could be clearer." },
  ];
  return { rooms, reviewPoints, reviews, point, findings };
}

describe("ReviewService SideTask publications", () => {
  it("publishes only the requester-selected findings as one immutable idempotent group", () => {
    const { reviews, point, findings } = fixture();
    const input = {
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId,
      taskId: "task-review-1", workspaceSnapshotId: point.workspaceSnapshotId,
      summary: "One actionable issue.", findings: [findings[0]!],
    };

    expect(reviews.listPublications({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId })).toEqual({ publications: [] });
    const publication = reviews.publishSideTaskResult(input);

    expect(publication).toMatchObject({
      roomId: "room-1", reviewPointId: point.reviewPointId, taskId: "task-review-1",
      workspaceSnapshotId: point.workspaceSnapshotId, publishedBy: "member-bob",
      summary: "One actionable issue.", state: "published", findingIds: [expect.stringMatching(/^[a-f0-9]{64}$/)],
    });
    expect(reviews.publishSideTaskResult(input)).toEqual(publication);
    expect(reviews.listFindings({ roomId: "room-1", principalId: "carol", reviewPointId: point.reviewPointId })).toMatchObject({
      findings: [{ body: findings[0]!.body, authorId: "member-bob", state: "open" }],
    });
    expect(() => reviews.publishSideTaskResult({ ...input, summary: "Changed summary." })).toThrow("conflicts");
    expect(() => reviews.publishSideTaskResult({ ...input, findings: [findings[1]!] })).toThrow("conflicts");
  });

  it("derives publication identity from the authenticated member and validates the fixed Review Point snapshot", () => {
    const { reviews, point, findings } = fixture();
    const bob = reviews.publishSideTaskResult({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId,
      taskId: "same-local-id", workspaceSnapshotId: point.workspaceSnapshotId, summary: "Bob review.", findings: [findings[0]!],
    });
    const carol = reviews.publishSideTaskResult({
      roomId: "room-1", principalId: "carol", reviewPointId: point.reviewPointId,
      taskId: "same-local-id", workspaceSnapshotId: point.workspaceSnapshotId, summary: "Carol review.", findings: [findings[1]!],
    });

    expect(carol.publicationId).not.toBe(bob.publicationId);
    expect(carol.publishedBy).toBe("member-carol");
    expect(() => reviews.publishSideTaskResult({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId,
      taskId: "wrong-snapshot", workspaceSnapshotId: "snapshot-other", summary: "Wrong snapshot.", findings: [findings[0]!],
    })).toThrow("snapshot");
  });

  it("lets only the Host accept a publication once and accepts its findings atomically", () => {
    const { reviews, point, findings } = fixture();
    const publication = reviews.publishSideTaskResult({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId,
      taskId: "task-review-1", workspaceSnapshotId: point.workspaceSnapshotId,
      summary: "Two issues.", findings,
    });

    expect(() => reviews.acceptSideTaskPublication({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, publicationId: publication.publicationId,
    }, () => {})).toThrow("Host");
    expect(() => reviews.setFindingState({
      roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId,
      findingId: publication.findingIds[0]!, state: "accepted",
    })).toThrow("one publication");
    expect(() => reviews.acceptSideTaskPublication({
      roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, publicationId: publication.publicationId,
    }, () => { throw new Error("integration request conflict"); })).toThrow("integration request conflict");
    expect(reviews.listPublications({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId }))
      .toMatchObject({ publications: [{ state: "published" }] });
    expect(reviews.listFindings({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId }))
      .toMatchObject({ findings: [{ state: "open" }, { state: "open" }] });
    const committed: string[] = [];
    const accepted = reviews.acceptSideTaskPublication({
      roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, publicationId: publication.publicationId,
    }, (prepared) => { committed.push(prepared.publication.integrationRequestId!); });

    expect(accepted.publication).toMatchObject({
      state: "accepted", acceptedBy: "member-host", acceptedAt: 30,
      integrationRequestId: expect.stringMatching(/^internal:mainline:[a-f0-9]{64}$/),
    });
    expect(accepted.findings).toHaveLength(2);
    expect(accepted.findings.every((finding) => finding.state === "accepted" && finding.decidedBy === "member-host")).toBe(true);
    expect(reviews.acceptSideTaskPublication({
      roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, publicationId: publication.publicationId,
    }, (prepared) => { committed.push(prepared.publication.integrationRequestId!); })).toEqual(accepted);
    expect(committed).toEqual([accepted.publication.integrationRequestId, accepted.publication.integrationRequestId]);
  });

  it("restores publications and their Mainline linkage without duplication", () => {
    const { rooms, reviewPoints, reviews, point, findings } = fixture();
    const publication = reviews.publishSideTaskResult({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId,
      taskId: "task-review-1", workspaceSnapshotId: point.workspaceSnapshotId,
      summary: "One issue.", findings: [findings[0]!],
    });
    reviews.acceptSideTaskPublication({
      roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, publicationId: publication.publicationId,
    }, () => {});

    const restored = ReviewService.fromSnapshot({ rooms, reviewPoints, now: () => 40 }, reviews.snapshot());
    expect(restored.listPublications({ roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId })).toMatchObject({
      publications: [{ publicationId: publication.publicationId, state: "accepted", integrationRequestId: expect.any(String) }],
    });
    expect(restored.snapshot()).toEqual(reviews.snapshot());

    const legacy = reviews.snapshot();
    legacy.publications![0] = {
      ...legacy.publications![0]!,
      integrationRequestId: hash(`room-1\0${publication.publicationId}\0mainline-integration`),
    };
    const restoredLegacy = ReviewService.fromSnapshot({ rooms, reviewPoints, now: () => 40 }, legacy);
    expect(restoredLegacy.snapshot()).toEqual(legacy);

    const malformed = reviews.snapshot();
    malformed.publications![0] = { ...malformed.publications![0]!, acceptedAt: 41 };
    expect(() => ReviewService.fromSnapshot({ rooms, reviewPoints }, malformed)).toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
  });
});
