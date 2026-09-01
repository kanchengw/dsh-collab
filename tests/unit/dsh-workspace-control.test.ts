import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangeSetDraftStore, type ChangeSetDraft } from "../../src/change-sets.js";
import { DshWorkspaceControl } from "../../src/dsh-workspace-control.js";
import { RoomSessionLinkFile, RoomSessionLinkStore } from "../../src/room-session-links.js";
import { RoomWorkspaceMaterializer } from "../../src/room-workspace.js";
import { WorkspaceSnapshotStore } from "../../src/workspace-snapshot-store.js";
import type { WorkspaceVersionRecord } from "../../src/workspace-versions.js";
import { localDshSubprocess } from "../helpers/local-dsh-subprocess.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function participantDraftFixture(root: string): Promise<{
  workspaceRoot: string;
  artifactRoot: string;
  store: ChangeSetDraftStore;
  draft: ChangeSetDraft;
  record: WorkspaceVersionRecord;
}> {
  const workspaceRoot = join(root, "rooms");
  const artifactRoot = join(root, "artifacts");
  const artifacts = new WorkspaceSnapshotStore(artifactRoot);
  const manifestHash = sha256(JSON.stringify([]));
  await artifacts.save({
    snapshotId: "base-1", roomId: "room-1", hostSessionId: "session-owner", roomEventSeq: 1,
    headOid: "a".repeat(40), manifestHash, files: [], createdAt: 10,
  }, new Map());
  const record: WorkspaceVersionRecord = {
    version: { workspaceVersionId: "base-1", roomId: "room-1", headOid: "a".repeat(40), files: [], createdBy: "member-host", createdAt: 10 },
    manifestHash,
    artifact: { kind: "workspace-snapshot.v1", snapshotId: "base-1", manifestHash, totalBytes: 0 },
  };
  const workspace = await new RoomWorkspaceMaterializer({ root: workspaceRoot, artifacts }).materialize({ roomId: "room-1", record });
  await writeFile(join(workspace.workspacePath, "added.txt"), "");
  const patch = "";
  const files = [{
    path: "added.txt", operation: "add" as const, resultContentHash: sha256(""), resultSize: 0, additions: 0, deletions: 0,
  }];
  const identity = {
    roomId: "room-1", authorId: "member-participant", baseWorkspaceVersionId: "base-1", title: "Participant change",
    summary: "Submit once and retain only on failure.", files, patchHash: sha256(patch), patchBytes: 0, resultBytes: 0,
  };
  const draftId = sha256(JSON.stringify(identity));
  const draft: ChangeSetDraft = {
    version: 1, draftId, roomId: identity.roomId, authorId: identity.authorId, baseWorkspaceVersionId: identity.baseWorkspaceVersionId,
    title: identity.title, summary: identity.summary, files,
    artifact: { kind: "changeset-draft.v1", artifactId: draftId, manifestHash: draftId, patchHash: identity.patchHash, patchBytes: 0, resultBytes: 0 },
    createdAt: 20,
  };
  const store = new ChangeSetDraftStore(workspace.draftsPath);
  await store.save(draft, patch, new Map([["added.txt", Buffer.alloc(0)]]));
  return { workspaceRoot, artifactRoot, store, draft, record };
}

function participantPayload() {
  return {
    sessionId: "session-participant",
    room: {
      roomId: "room-1", memberId: "member-participant", role: "participant" as const, connection: "online" as const,
      members: [
        { memberId: "member-host", displayName: "Host" },
        { memberId: "member-participant", displayName: "Participant" },
      ],
      roomEvents: [],
    },
    remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
    action: {},
  };
}

function participantSubmitFetch(fixture: Awaited<ReturnType<typeof participantDraftFixture>>, failProjection: boolean) {
  const uploadId = "f".repeat(64);
  const changeSet = { version: 1 as const, changeSetId: fixture.draft.draftId, draft: fixture.draft, submittedAt: 30 };
  const review = {
    version: 1, roomId: "room-1", changeSetId: fixture.draft.draftId, authorId: "member-participant",
    status: "submitted", assignmentCount: 0, findingCount: 0,
  };
  let projectionAttempts = 0;
  return vi.fn(async (url: string, init: { method: string }) => {
    if (url.endsWith("/workspace-versions/latest")) return { status: 200, json: async () => ({ data: { record: fixture.record } }) };
    if (url.endsWith("/change-sets/uploads") && init.method === "POST") {
      return { status: 201, json: async () => ({ data: { upload: {
        uploadId, changeSetId: fixture.draft.draftId, state: "finalized", patchOffset: 0, resultOffsets: [0],
      } } }) };
    }
    if (url.endsWith(`/change-sets/uploads/${uploadId}/finalize`) && init.method === "POST") {
      return { status: 200, json: async () => ({ data: { changeSet } }) };
    }
    if (url.includes("/change-sets/reviews?")) {
      projectionAttempts += 1;
      if (failProjection && projectionAttempts === 1) throw new Error("projection unavailable");
      return { status: 200, json: async () => ({ data: { items: [{ review, changeSet }] } }) };
    }
    if (url.endsWith(`/change-sets/${fixture.draft.draftId}`)) return { status: 200, json: async () => ({ data: { changeSet } }) };
    if (url.includes(`/change-sets/${fixture.draft.draftId}/findings?`)) return { status: 200, json: async () => ({ data: { findings: [] } }) };
    throw new Error(`unexpected request: ${url}`);
  });
}

describe("DshWorkspaceControl", () => {
  it("retires a local draft only after submission and the resulting projection are confirmed", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-submit-confirmed-"));
    roots.push(root);
    const fixture = await participantDraftFixture(root);
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(), roomWorkspaceRoot: fixture.workspaceRoot, artifactRoot: fixture.artifactRoot,
      fetch: participantSubmitFetch(fixture, false), sessionLinkFile: false,
    });

    const result = await control.handle("workspace/changes/submit", participantPayload());

    expect("changes" in result && result.changes.draft).toBeUndefined();
    await expect(fixture.store.list()).resolves.toEqual([]);
    await control.dispose();
  });

  it("retains a local draft when submission is durable but its resulting projection is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-submit-unconfirmed-"));
    roots.push(root);
    const fixture = await participantDraftFixture(root);
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(), roomWorkspaceRoot: fixture.workspaceRoot, artifactRoot: fixture.artifactRoot,
      fetch: participantSubmitFetch(fixture, true), sessionLinkFile: false,
    });

    await expect(control.handle("workspace/changes/submit", participantPayload())).rejects.toThrow("projection unavailable");

    await expect(fixture.store.list()).resolves.toEqual([{ draft: fixture.draft, patch: "" }]);
    await control.dispose();
  });

  it("reuses a review mutation request id after a lost response", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-retry-"));
    roots.push(root);
    const requestIds: string[] = [];
    let attempts = 0;
    const fetch = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      if (init.method === "PUT") {
        attempts += 1;
        requestIds.push((JSON.parse(init.body!) as { clientRequestId: string }).clientRequestId);
        if (attempts === 1) throw new Error("response lost");
        return { status: 200, json: async () => ({ data: {} }) };
      }
      if (url.endsWith("/workspace-versions/latest")) return { status: 404, json: async () => ({ error: { message: "not found" } }) };
      if (url.includes("change-sets/reviews")) return { status: 200, json: async () => ({ data: { items: [] } }) };
      throw new Error(`unexpected request: ${url}`);
    });
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(), roomWorkspaceRoot: join(root, "rooms"), artifactRoot: join(root, "artifacts"), fetch, sessionLinkFile: false,
    });
    const payload = {
      sessionId: "session-owner",
      room: { roomId: "room-1", memberId: "member-host", role: "host", connection: "online", members: [{ memberId: "member-host", displayName: "Host" }], roomEvents: [] },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
      action: { changeSetId: "a".repeat(64), reviewerId: "member-host" },
    } as const;

    await expect(control.handle("workspace/reviews/assign", payload)).rejects.toThrow("response lost");
    await expect(control.handle("workspace/reviews/assign", payload)).resolves.toMatchObject({ changes: { roomId: "room-1" } });
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).toBe(requestIds[0]);
    await control.dispose();
  });

  it("reuses a successful review mutation request id when the following projection fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-projection-retry-"));
    roots.push(root);
    const requestIds: string[] = [];
    const durableAssignments = new Set<string>();
    let reviewListAttempts = 0;
    const fetch = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      if (init.method === "PUT") {
        const requestId = (JSON.parse(init.body!) as { clientRequestId: string }).clientRequestId;
        requestIds.push(requestId);
        durableAssignments.add(requestId);
        return { status: 200, json: async () => ({ data: {} }) };
      }
      if (url.endsWith("/workspace-versions/latest")) return { status: 404, json: async () => ({ error: { message: "not found" } }) };
      if (url.includes("change-sets/reviews")) {
        reviewListAttempts += 1;
        if (reviewListAttempts === 1) throw new Error("projection unavailable");
        return { status: 200, json: async () => ({ data: { items: [] } }) };
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(), roomWorkspaceRoot: join(root, "rooms"), artifactRoot: join(root, "artifacts"), fetch, sessionLinkFile: false,
    });
    const payload = {
      sessionId: "session-owner",
      room: { roomId: "room-1", memberId: "member-host", role: "host", connection: "online", members: [{ memberId: "member-host", displayName: "Host" }], roomEvents: [] },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
      action: { changeSetId: "a".repeat(64), reviewerId: "member-host" },
    } as const;

    await expect(control.handle("workspace/reviews/assign", payload)).rejects.toThrow("projection unavailable");
    await expect(control.handle("workspace/reviews/assign", payload)).resolves.toMatchObject({ changes: { roomId: "room-1" } });
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).toBe(requestIds[0]);
    expect(durableAssignments.size).toBe(1);
    await control.dispose();
  });

  it("reuses the original request id and parent after a published Workspace response is lost", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-publish-retry-"));
    roots.push(root);
    const requestBodies: Array<{ clientRequestId: string; parentVersionId?: string }> = [];
    const durableVersions = new Map<string, { version: { workspaceVersionId: string; roomId: string; files: never[]; createdBy: string; createdAt: number }; manifestHash: string; artifact: { kind: "workspace-snapshot.v1"; snapshotId: string; manifestHash: string; totalBytes: number } }>();
    const manifestHash = createHash("sha256").update("[]").digest("hex");
    let latest: ReturnType<typeof durableVersions.get>;
    let publishAttempts = 0;
    const fetch = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      if (init.method === "POST") {
        publishAttempts += 1;
        const requestBody = JSON.parse(init.body!) as { clientRequestId: string; parentVersionId?: string };
        requestBodies.push(requestBody);
        let record = durableVersions.get(requestBody.clientRequestId);
        if (!record) {
          record = {
            version: { workspaceVersionId: `snapshot-${durableVersions.size + 1}`, roomId: "room-1", files: [], createdBy: "member-host", createdAt: 10 },
            manifestHash,
            artifact: { kind: "workspace-snapshot.v1", snapshotId: `snapshot-${durableVersions.size + 1}`, manifestHash, totalBytes: 0 },
          };
          durableVersions.set(requestBody.clientRequestId, record);
        }
        latest = record;
        if (publishAttempts === 1) throw new Error("publish response lost");
        return { status: 201, json: async () => ({ data: { record } }) };
      }
      if (url.endsWith("/workspace-versions/latest")) {
        return latest
          ? { status: 200, json: async () => ({ data: { record: latest, snapshot: { files: [] } } }) }
          : { status: 404, json: async () => ({ error: { message: "not found" } }) };
      }
      if (url.includes("change-sets/reviews")) return { status: 200, json: async () => ({ data: { items: [] } }) };
      throw new Error(`unexpected request: ${url}`);
    });
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(), roomWorkspaceRoot: join(root, "rooms"), artifactRoot: join(root, "artifacts"), fetch, sessionLinkFile: false,
    });
    const payload = {
      sessionId: "session-owner",
      room: { roomId: "room-1", memberId: "member-host", role: "host", connection: "online", members: [{ memberId: "member-host", displayName: "Host" }], roomEvents: [] },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
      action: {},
    } as const;

    await expect(control.handle("workspace/changes/sync", payload)).rejects.toThrow("publish response lost");
    await expect(control.handle("workspace/changes/sync", payload)).resolves.toMatchObject({ changes: { workspace: { kind: "owner", latestVersionId: "snapshot-1" } } });
    expect(requestBodies).toHaveLength(2);
    expect(requestBodies[1]).toEqual(requestBodies[0]);
    expect(requestBodies[0]).not.toHaveProperty("parentVersionId");
    expect(durableVersions.size).toBe(1);
    await control.dispose();
  });

  it("does not clear a shared retry id while an identical concurrent review action can still fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-concurrent-retry-"));
    roots.push(root);
    const requestIds: string[] = [];
    const durableAssignments = new Set<string>();
    let putAttempts = 0;
    let markSecondStarted: (() => void) | undefined;
    let releaseSecondFailure: (() => void) | undefined;
    const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
    const secondFailure = new Promise<void>((resolve) => { releaseSecondFailure = resolve; });
    const fetch = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      if (init.method === "PUT") {
        putAttempts += 1;
        const requestId = (JSON.parse(init.body!) as { clientRequestId: string }).clientRequestId;
        requestIds.push(requestId);
        durableAssignments.add(requestId);
        if (putAttempts === 2) {
          markSecondStarted?.();
          await secondFailure;
          throw new Error("concurrent response lost");
        }
        return { status: 200, json: async () => ({ data: {} }) };
      }
      if (url.endsWith("/workspace-versions/latest")) return { status: 404, json: async () => ({ error: { message: "not found" } }) };
      if (url.includes("change-sets/reviews")) return { status: 200, json: async () => ({ data: { items: [] } }) };
      throw new Error(`unexpected request: ${url}`);
    });
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(), roomWorkspaceRoot: join(root, "rooms"), artifactRoot: join(root, "artifacts"), fetch, sessionLinkFile: false,
    });
    const payload = {
      sessionId: "session-owner",
      room: { roomId: "room-1", memberId: "member-host", role: "host", connection: "online", members: [{ memberId: "member-host", displayName: "Host" }], roomEvents: [] },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
      action: { changeSetId: "a".repeat(64), reviewerId: "member-host" },
    } as const;

    const successful = control.handle("workspace/reviews/assign", payload);
    const failed = control.handle("workspace/reviews/assign", payload);
    await secondStarted;
    await expect(successful).resolves.toMatchObject({ changes: { roomId: "room-1" } });
    releaseSecondFailure?.();
    await expect(failed).rejects.toThrow("concurrent response lost");
    await expect(control.handle("workspace/reviews/assign", payload)).resolves.toMatchObject({ changes: { roomId: "room-1" } });

    expect(requestIds).toHaveLength(3);
    expect(new Set(requestIds).size).toBe(1);
    expect(durableAssignments.size).toBe(1);
    await control.dispose();
  });

  it("starts a fresh Workspace publication after the Gateway definitively rejects a stale parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-parent-conflict-"));
    roots.push(root);
    const manifestHash = createHash("sha256").update("[]").digest("hex");
    const record = (workspaceVersionId: string, parentVersionId?: string) => ({
      version: { workspaceVersionId, roomId: "room-1", ...(parentVersionId ? { parentVersionId } : {}), files: [], createdBy: "member-host", createdAt: 10 },
      manifestHash,
      artifact: { kind: "workspace-snapshot.v1" as const, snapshotId: workspaceVersionId, manifestHash, totalBytes: 0 },
    });
    let latest = record("a".repeat(64));
    const requestBodies: Array<{ clientRequestId: string; parentVersionId?: string }> = [];
    let publishAttempts = 0;
    const fetch = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      if (init.method === "POST") {
        publishAttempts += 1;
        const requestBody = JSON.parse(init.body!) as { clientRequestId: string; parentVersionId?: string };
        requestBodies.push(requestBody);
        if (publishAttempts === 1) {
          latest = record("b".repeat(64), "a".repeat(64));
          return { status: 409, json: async () => ({ error: { code: "REQUEST_CONFLICT", message: "Workspace Version parent is no longer latest" } }) };
        }
        latest = record("c".repeat(64), "b".repeat(64));
        return { status: 201, json: async () => ({ data: { record: latest } }) };
      }
      if (url.endsWith("/workspace-versions/latest")) return { status: 200, json: async () => ({ data: { record: latest, snapshot: { files: [] } } }) };
      if (url.includes("change-sets/reviews")) return { status: 200, json: async () => ({ data: { items: [] } }) };
      throw new Error(`unexpected request: ${url}`);
    });
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(), roomWorkspaceRoot: join(root, "rooms"), artifactRoot: join(root, "artifacts"), fetch, sessionLinkFile: false,
    });
    const payload = {
      sessionId: "session-owner",
      room: { roomId: "room-1", memberId: "member-host", role: "host", connection: "online", members: [{ memberId: "member-host", displayName: "Host" }], roomEvents: [] },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" }, action: {},
    } as const;

    await expect(control.handle("workspace/changes/sync", payload)).rejects.toThrow("parent is no longer latest");
    await expect(control.handle("workspace/changes/sync", payload)).resolves.toMatchObject({ changes: { workspace: { latestVersionId: "c".repeat(64) } } });

    expect(requestBodies[0]?.parentVersionId).toBe("a".repeat(64));
    expect(requestBodies[1]?.parentVersionId).toBe("b".repeat(64));
    expect(requestBodies[1]?.clientRequestId).not.toBe(requestBodies[0]?.clientRequestId);
    await control.dispose();
  });

  it("retires a retry id after an early retry succeeds while its original sibling is still active", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-overlap-retry-"));
    roots.push(root);
    const requestIds: string[] = [];
    let putAttempts = 0;
    let releaseFirst: (() => void) | undefined;
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const fetch = vi.fn(async (url: string, init: { method: string; body?: string }) => {
      if (init.method === "PUT") {
        putAttempts += 1;
        requestIds.push((JSON.parse(init.body!) as { clientRequestId: string }).clientRequestId);
        if (putAttempts === 1) await firstReleased;
        if (putAttempts === 2) throw new Error("second response lost");
        return { status: 200, json: async () => ({ data: {} }) };
      }
      if (url.endsWith("/workspace-versions/latest")) return { status: 404, json: async () => ({ error: { message: "not found" } }) };
      if (url.includes("change-sets/reviews")) return { status: 200, json: async () => ({ data: { items: [] } }) };
      throw new Error(`unexpected request: ${url}`);
    });
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(), roomWorkspaceRoot: join(root, "rooms"), artifactRoot: join(root, "artifacts"), fetch, sessionLinkFile: false,
    });
    const payload = {
      sessionId: "session-owner",
      room: { roomId: "room-1", memberId: "member-host", role: "host", connection: "online", members: [{ memberId: "member-host", displayName: "Host" }], roomEvents: [] },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
      action: { changeSetId: "a".repeat(64), reviewerId: "member-host" },
    } as const;

    const first = control.handle("workspace/reviews/assign", payload);
    await expect(control.handle("workspace/reviews/assign", payload)).rejects.toThrow("second response lost");
    await expect(control.handle("workspace/reviews/assign", payload)).resolves.toMatchObject({ changes: { roomId: "room-1" } });
    releaseFirst?.();
    await expect(first).resolves.toMatchObject({ changes: { roomId: "room-1" } });
    await expect(control.handle("workspace/reviews/assign", payload)).resolves.toMatchObject({ changes: { roomId: "room-1" } });

    expect(new Set(requestIds.slice(0, 3)).size).toBe(1);
    expect(requestIds[3]).not.toBe(requestIds[0]);
    await control.dispose();
  });

  it("does not report a committed workspace action as failed when Room Context delivery is blocked", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-context-failure-"));
    roots.push(root);
    let posted = 0;
    const fetch = vi.fn(async (url: string, init: { method: string }) => {
      if (init.method === "POST" || init.method === "PUT") { posted += 1; return { status: 200, json: async () => ({ data: {} }) }; }
      if (url.endsWith("/workspace-versions/latest")) return { status: 404, json: async () => ({ error: { message: "not found" } }) };
      if (url.includes("change-sets/reviews")) return { status: 200, json: async () => ({ data: { items: [] } }) };
      throw new Error(`unexpected request: ${url}`);
    });
    const agent = { session: { events: [], header: { cwd: root, seedLength: 0 } }, inject: () => { throw new Error("context inbox busy"); } };
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(), roomWorkspaceRoot: join(root, "rooms"), artifactRoot: join(root, "artifacts"), fetch,
      agents: { get: () => agent }, onSessionEvent: () => () => {}, sessionLinkFile: false,
    });

    await expect(control.handle("workspace/reviews/assign", {
      sessionId: "session-owner",
      room: {
        roomId: "room-1", memberId: "member-host", role: "host", connection: "online", members: [{ memberId: "member-host", displayName: "Host" }],
        roomEvents: [{
          eventId: "message:1", roomId: "room-1", seq: 1, type: "human.message", createdAt: 5,
          actor: { memberId: "member-host", principalId: "principal-host" },
          payload: { kind: "human", visibility: "room", messageId: "message-1", roomId: "room-1", authorMemberId: "member-host", text: "Ship it" },
        }],
      },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
      action: { changeSetId: "a".repeat(64), reviewerId: "member-host" },
    })).resolves.toMatchObject({ changes: { roomId: "room-1" } });
    expect(posted).toBe(1);
    await control.dispose();
  });

  it("loads ChangeSet metadata without eagerly downloading every unselected patch", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-lazy-"));
    roots.push(root);
    const files = [{
      path: "src/fix.ts", operation: "modify" as const, baseContentHash: "d".repeat(64), resultContentHash: "e".repeat(64),
      baseSize: 1, resultSize: 1, additions: 1, deletions: 1,
    }];
    const patchHash = "c".repeat(64);
    const patchBytes = 16 * 1024 * 1024;
    const resultBytes = 1;
    const changeSetId = createHash("sha256").update(JSON.stringify({
      roomId: "room-1", authorId: "member-host", baseWorkspaceVersionId: "version-1", title: "Fix", summary: "Fix it",
      files, patchHash, patchBytes, resultBytes,
    })).digest("hex");
    const changeSet = {
      version: 1, changeSetId, submittedAt: 100,
      draft: {
        version: 1, draftId: changeSetId, roomId: "room-1", authorId: "member-host", baseWorkspaceVersionId: "version-1",
        title: "Fix", summary: "Fix it", files,
        artifact: { kind: "changeset-draft.v1", artifactId: changeSetId, manifestHash: changeSetId, patchHash, patchBytes, resultBytes },
        createdAt: 90,
      },
    };
    const review = { version: 1, roomId: "room-1", changeSetId, authorId: "member-host", status: "submitted", assignmentCount: 0, findingCount: 0 };
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/workspace-versions/latest")) return { status: 404, json: async () => ({ error: { message: "not found" } }) };
      if (url.includes("change-sets/reviews")) return { status: 200, json: async () => ({ data: { items: [{ review, changeSet }] } }) };
      throw new Error(`unexpected eager request: ${url}`);
    });
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(), roomWorkspaceRoot: join(root, "rooms"), artifactRoot: join(root, "artifacts"), fetch, sessionLinkFile: false,
    });

    const result = await control.handle("workspace/refresh", {
      sessionId: "session-owner",
      room: { roomId: "room-1", memberId: "member-host", role: "host", connection: "online", members: [{ memberId: "member-host", displayName: "Host" }], roomEvents: [] },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" }, action: {},
    });

    expect("changes" in result && result.changes.staged).toHaveLength(1);
    expect(fetch.mock.calls.map(([url]) => url)).not.toEqual(expect.arrayContaining([expect.stringMatching(/\/change-sets\/[a-f0-9]{64}$/)]));
    expect(fetch.mock.calls.map(([url]) => url)).not.toEqual(expect.arrayContaining([expect.stringContaining("/patch?")]));
    await control.dispose();
  });

  it("binds Room Context without loading or mutating workspace projections", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-context-"));
    roots.push(root);
    const inject = vi.fn();
    const fetch = vi.fn(async () => { throw new Error("context sync must not call the remote workspace API"); });
    const agent = { session: { events: [], header: { cwd: root, seedLength: 0 } }, inject };
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(),
      roomWorkspaceRoot: join(root, "rooms"),
      artifactRoot: join(root, "artifacts"),
      fetch,
      agents: { get: () => agent },
      onSessionEvent: () => () => {},
      sessionLinkFile: false,
    });

    const result = await control.handle("workspace/context-sync", {
      sessionId: "session-owner",
      room: {
        roomId: "room-1", memberId: "member-host", role: "host", connection: "online", members: [{ memberId: "member-host", displayName: "Host" }],
        roomEvents: [{
          eventId: "message:1", roomId: "room-1", seq: 1, type: "human.message", createdAt: 5,
          actor: { memberId: "member-host", principalId: "principal-host" },
          payload: { kind: "human", visibility: "room", messageId: "message-1", roomId: "room-1", authorMemberId: "member-host", text: "Ship it" },
        }],
      },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
      action: {},
    });

    expect(result).toEqual({ synced: true });
    expect(fetch).not.toHaveBeenCalled();
    expect(inject).toHaveBeenCalledOnce();
    await control.dispose();
  });

  it("rebinds a participant Room Workspace Session to the current member after rejoining the same room", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-rejoin-"));
    roots.push(root);
    const workspaceRoot = join(root, "rooms");
    const artifactRoot = join(root, "artifacts");
    const artifacts = new WorkspaceSnapshotStore(artifactRoot);
    const manifestHash = sha256(JSON.stringify([]));
    const record: WorkspaceVersionRecord = {
      version: { workspaceVersionId: "base-1", roomId: "room-1", headOid: "a".repeat(40), files: [], createdBy: "member-host", createdAt: 10 },
      manifestHash,
      artifact: { kind: "workspace-snapshot.v1", snapshotId: "base-1", manifestHash, totalBytes: 0 },
    };
    await artifacts.save({
      snapshotId: "base-1", roomId: "room-1", hostSessionId: "session-owner", roomEventSeq: 1,
      headOid: "a".repeat(40), manifestHash, files: [], createdAt: 10,
    }, new Map());
    const workspace = await new RoomWorkspaceMaterializer({ root: workspaceRoot, artifacts }).materialize({ roomId: "room-1", record });
    const linkPath = join(root, "session-links.json");
    const links = new RoomSessionLinkStore();
    const linkedWorkspacePath = await realpath(workspace.workspacePath);
    links.bind({
      roomId: "room-1", memberId: "member-old", sessionId: "session-participant",
      workspacePath: linkedWorkspacePath, sessionCwd: linkedWorkspacePath,
    });
    links.advanceCursor("session-participant", 9);
    await new RoomSessionLinkFile(linkPath).save(links.snapshot());

    const inject = vi.fn();
    const attachSession = vi.fn(async () => undefined);
    const agent = { session: { events: [], header: { cwd: workspace.workspacePath, seedLength: 0 } }, inject };
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(), roomWorkspaceRoot: workspaceRoot, artifactRoot,
      agents: { get: () => agent },
      onSessionEvent: () => () => {},
      nativeWorkspaces: {
        create: async (path) => ({ id: "workspace-room-1", path, attachSession, detachSession: async () => undefined }),
        resolveByPath: async () => undefined,
      },
      fetch: async () => { throw new Error("context sync must not call the remote workspace API"); },
      sessionLinkFile: linkPath,
    });

    await control.handle("workspace/context-sync", {
      sessionId: "session-participant",
      room: {
        roomId: "room-1", memberId: "member-current", role: "participant", connection: "online",
        members: [{ memberId: "member-current", displayName: "Participant" }],
        roomEvents: [{
          eventId: "message:1", roomId: "room-1", seq: 1, type: "human.message", createdAt: 5,
          actor: { memberId: "member-host", principalId: "principal-host" },
          payload: { kind: "human", visibility: "room", messageId: "message-1", roomId: "room-1", authorMemberId: "member-host", text: "Current context" },
        }],
      },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
      action: {},
    });
    await control.dispose();

    expect(attachSession).toHaveBeenCalledWith("session-participant");
    expect(inject).toHaveBeenCalledOnce();
    await expect(new RoomSessionLinkFile(linkPath).load()).resolves.toMatchObject({
      links: [{ roomId: "room-1", memberId: "member-current", sessionId: "session-participant", lastInjectedRoomSeq: 0, active: true }],
    });
  });

  it("delivers events that arrived behind a pending Room Context after its durable claim", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-context-catchup-"));
    roots.push(root);
    let sessionListener: ((session: { id: string }, event: { seq: number; type: string; data: unknown }) => void) | undefined;
    let sessionSeq = 0;
    const sessionEvents: Array<{ seq: number; type: string; data: unknown }> = [];
    const injected: unknown[] = [];
    const agent = {
      id: "session-owner",
      session: { events: sessionEvents, header: { cwd: root, seedLength: 0 } },
      inject(message: unknown) {
        injected.push(message);
        const event = { seq: sessionSeq++, type: "agent/inbox/spliced", data: { target: "next-step", start: 0, inserted: [message] } };
        sessionEvents.push(event);
        sessionListener?.({ id: "session-owner" }, event);
      },
    };
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(),
      roomWorkspaceRoot: join(root, "rooms"),
      artifactRoot: join(root, "artifacts"),
      fetch: async () => { throw new Error("context sync must not call the remote workspace API"); },
      agents: { get: () => agent },
      onSessionEvent: (listener) => { sessionListener = listener; return () => { sessionListener = undefined; }; },
      sessionLinkFile: false,
    });
    const roomEvent = (seq: number, text: string) => ({
      eventId: `message:${seq}`, roomId: "room-1", seq, type: "human.message" as const, createdAt: seq,
      actor: { memberId: "member-host", principalId: "principal-host" },
      payload: { kind: "human", visibility: "room", messageId: `message-${seq}`, roomId: "room-1", authorMemberId: "member-host", text },
    });
    const request = (roomEvents: ReturnType<typeof roomEvent>[]) => ({
      sessionId: "session-owner",
      room: {
        roomId: "room-1", memberId: "member-host", role: "host" as const, connection: "online" as const,
        members: [{ memberId: "member-host", displayName: "Host" }], roomEvents,
      },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
      action: {},
    });

    await control.handle("workspace/context-sync", request([roomEvent(1, "First")]));
    await expect(control.handle("workspace/context-sync", request([roomEvent(1, "First"), roomEvent(2, "Second")])))
      .rejects.toThrow("pending");
    expect(injected).toHaveLength(1);

    const acknowledgement = {
      seq: sessionSeq++, type: "agent/inbox/spliced", data: { target: "next-step", start: 0, removedCount: 1, inserted: [] },
    };
    sessionEvents.push(acknowledgement);
    sessionListener?.({ id: "session-owner" }, acknowledgement);

    await vi.waitFor(() => expect(injected).toHaveLength(2));
    const delivered = injected[1] as { content: Array<{ text: string }> };
    expect(JSON.parse(delivered.content[0]!.text)).toMatchObject({
      fromSeq: 2,
      toSeq: 2,
      entries: [{ kind: "message", text: "Second" }],
    });
    await control.dispose();
  });

  it("publishes an Owner Workspace Version only through an explicit Changes action", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-control-"));
    roots.push(root);
    const manifestHash = createHash("sha256").update("[]").digest("hex");
    const record = {
      version: { workspaceVersionId: "snapshot-1", roomId: "room-1", files: [], createdBy: "member-host", createdAt: 10 },
      manifestHash,
      artifact: { kind: "workspace-snapshot.v1" as const, snapshotId: "snapshot-1", manifestHash, totalBytes: 0 },
    };
    let published = false;
    const inject = vi.fn();
    const agent = { session: { events: [], header: { cwd: root, seedLength: 0 } }, inject };
    const fetch = vi.fn(async (_url: string, init: { method: string }) => {
      if (init.method === "POST") {
        published = true;
        return { status: 201, json: async () => ({ data: { record } }) };
      }
      if (!published) return { status: 404, json: async () => ({ error: { message: "not found" } }) };
      if (_url.includes("change-sets/reviews")) return { status: 200, json: async () => ({ data: { items: [] } }) };
      return { status: 200, json: async () => ({ data: { record, snapshot: { files: [] } } }) };
    });
    const control = new DshWorkspaceControl({
      subprocess: localDshSubprocess(),
      roomWorkspaceRoot: join(root, "rooms"),
      artifactRoot: join(root, "artifacts"),
      fetch,
      agents: { get: () => agent },
      onSessionEvent: () => () => {},
      sessionLinkFile: false,
    });

    const result = await control.handle("workspace/changes/sync", {
      sessionId: "session-owner",
      room: {
        roomId: "room-1", memberId: "member-host", role: "host", connection: "online", members: [{ memberId: "member-host", displayName: "Host" }],
        roomEvents: [{
          eventId: "message:1", roomId: "room-1", seq: 1, type: "human.message", createdAt: 5,
          actor: { memberId: "member-host", principalId: "principal-host" },
          payload: { kind: "human", visibility: "room", messageId: "message-1", roomId: "room-1", authorMemberId: "member-host", text: "Ship it" },
        }],
      },
      remote: { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" },
      action: {},
    });

    expect("changes" in result && result.changes).toMatchObject({ role: "owner", workspace: { kind: "owner", latestVersionId: "snapshot-1" } });
    expect(fetch.mock.calls.filter(([, init]) => init.method === "POST")).toHaveLength(1);
    expect(inject).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: "plugin", plugin: "dsh-collab" } }));
  });
});
