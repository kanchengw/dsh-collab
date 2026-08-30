import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeSetClient } from "../../src/collaboration-client.js";
import { CHANGE_SET_CAPABILITY, type WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { ChangeSetDraftService, ChangeSetDraftStore } from "../../src/change-sets.js";
import { ChangeSetStagingService } from "../../src/change-set-staging.js";
import { EventLedger } from "../../src/events.js";
import { CollabGateway } from "../../src/gateway.js";
import { InviteStore } from "../../src/invites.js";
import type { ParticipantGatewayTransport } from "../../src/participant.js";
import { COLLAB_CAPABILITY_HEADER } from "../../src/protocol.js";
import { RoomStore } from "../../src/room.js";
import { RoomWorkspaceMaterializer } from "../../src/room-workspace.js";
import { ActiveRoomRegistry } from "../../src/active-rooms.js";
import { WorkspaceService } from "../../src/workspace-service.js";
import { WorkspaceSharingRegistry } from "../../src/workspace-sharing.js";
import { WorkspaceSnapshotStore } from "../../src/workspace-snapshot-store.js";
import { WorkspaceVersionService } from "../../src/workspace-versions.js";
import { gitCommand, localDshSubprocess } from "../helpers/local-dsh-subprocess.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, [COLLAB_CAPABILITY_HEADER]: CHANGE_SET_CAPABILITY };
}

function transport(gateway: CollabGateway): ParticipantGatewayTransport {
  return {
    request: (input) => gateway.handle({
      method: input.method,
      path: input.path,
      headers: {
        authorization: `Bearer ${input.token}`,
        [COLLAB_CAPABILITY_HEADER]: input.capabilities?.join(",") ?? "",
      },
      body: input.body,
    }),
  };
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-changeset-upload-"));
  roots.push(root);
  const artifacts = new WorkspaceSnapshotStore(join(root, "artifacts"));
  const base = Buffer.from("old\n");
  const snapshot: WorkspaceSnapshotPackage = {
    snapshotId: "base-1",
    roomId: "room-1",
    hostSessionId: "session-host",
    roomEventSeq: 0,
    headOid: "a".repeat(40),
    manifestHash: sha256(JSON.stringify([{ path: "src/value.ts", contentHash: sha256(base), size: base.byteLength, source: "tracked" }])),
    files: [{ path: "src/value.ts", contentHash: sha256(base), size: base.byteLength, source: "tracked" }],
    createdAt: 10,
  };
  await artifacts.save(snapshot, new Map([["src/value.ts", base]]));

  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Room", hostDisplayName: "Host", now: 1 });
  rooms.addMember("room-1", { memberId: "member-alice", principalId: "alice", displayName: "Alice", now: 2 });
  rooms.addMember("room-1", { memberId: "member-observer", principalId: "observer", displayName: "Observer", now: 3 });
  rooms.setMemberRole("room-1", "member-observer", "observer");
  rooms.createRoom({ roomId: "room-2", hostId: "host-2", hostSessionId: "session-host-2", title: "Other", hostDisplayName: "Other Host", now: 4 });
  const ledger = new EventLedger();
  const workspaceVersions = new WorkspaceVersionService({ rooms, ledger, artifacts });
  const created = await workspaceVersions.create({ roomId: "room-1", principalId: "host", snapshotId: snapshot.snapshotId });

  const workspace = await new RoomWorkspaceMaterializer({ root: join(root, "rooms"), artifacts }).materialize({
    roomId: "room-1",
    record: created.record,
  });
  const subprocess = localDshSubprocess();
  await gitCommand(subprocess, workspace.workspacePath, ["init", "--quiet"]);
  await gitCommand(subprocess, workspace.workspacePath, ["add", "--all"]);
  await gitCommand(subprocess, workspace.workspacePath, [
    "-c", "user.name=DSH Collab", "-c", "user.email=dsh-collab@localhost",
    "commit", "--quiet", "--no-gpg-sign", "--no-verify", "-m", "baseline",
  ]);
  await writeFile(join(workspace.workspacePath, "src/value.ts"), "new\nmore\n");
  await writeFile(join(workspace.workspacePath, "added.txt"), "added\n");
  const draftStore = new ChangeSetDraftStore(workspace.draftsPath);
  const bundle = await new ChangeSetDraftService({ artifacts, subprocess, now: () => 20 }).create({
    workspace,
    authorId: "member-alice",
    title: "Update value",
    summary: "Changes value and adds a file.",
  });

  const canonical = join(root, "owner-canonical");
  await mkdir(join(canonical, "src"), { recursive: true });
  await writeFile(join(canonical, "src/value.ts"), base);
  let stagingNow = 29;
  const stagingOptions = {
    root: join(root, "staging"),
    rooms,
    workspaceVersions,
    artifacts,
    subprocess,
    now: () => ++stagingNow,
  };
  const staging = new ChangeSetStagingService(stagingOptions);
  const sharing = new WorkspaceSharingRegistry();
  sharing.set("room-1", true, "member-host", 5);
  const workspaceService = new WorkspaceService({
    rooms,
    registry: sharing,
    snapshots: {
      capture: async () => { throw new Error("capture is not used by this test"); },
      load: (snapshotId) => artifacts.load(snapshotId),
      readFile: (snapshotId, path) => artifacts.readFile(snapshotId, path),
      readChunk: (snapshotId, path, offset, length) => artifacts.readChunk(snapshotId, path, offset, length),
    },
  });
  const activeRooms = new ActiveRoomRegistry();
  activeRooms.activate("room-1");
  activeRooms.activate("room-2");
  const gateway = new CollabGateway({
    rooms,
    ledger,
    invites: new InviteStore(rooms),
    agent: { followup() {}, steer() {}, cancel() {} },
    tokenFactory: (() => { let value = 0; return () => `token-${String(++value)}`; })(),
    tokenTtlMs: null,
    activeRooms,
    workspace: workspaceService,
    workspaceVersions,
    changeSets: staging,
  });
  const host = await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
  const alice = await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "alice" } });
  const observer = await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "observer" } });
  return {
    root, gateway, staging, stagingOptions, sharing, bundle, draftStore, canonical,
    client: new ChangeSetClient({ transport: transport(gateway), chunkBytes: 7 }),
    hostToken: (host.body as { roomToken: string }).roomToken,
    aliceToken: (alice.body as { roomToken: string }).roomToken,
    observerToken: (observer.body as { roomToken: string }).roomToken,
  };
}

describe("ChangeSet atomic upload and Owner Staging Area", () => {
  it("keeps partial uploads invisible and publishes only after complete verification", async () => {
    const state = await setup();
    const created = await state.gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/change-sets/uploads",
      headers: headers(state.aliceToken),
      body: { clientRequestId: "upload-1", draft: state.bundle.draft },
    });
    const uploadId = (created.body as { upload: { uploadId: string } }).upload.uploadId;
    const first = Buffer.from(state.bundle.patch).subarray(0, 7);
    await expect(state.gateway.handle({
      method: "POST",
      path: `/v1/rooms/room-1/change-sets/uploads/${uploadId}/chunks`,
      headers: headers(state.aliceToken),
      body: { target: "patch", offset: 7, byteLength: first.byteLength, chunkHash: sha256(first), data: first.toString("base64") },
    })).resolves.toMatchObject({ status: 422 });
    await expect(state.gateway.handle({
      method: "POST",
      path: `/v1/rooms/room-1/change-sets/uploads/${uploadId}/chunks`,
      headers: headers(state.aliceToken),
      body: { target: "patch", offset: 0, byteLength: first.byteLength, chunkHash: sha256(first), data: first.toString("base64") },
    })).resolves.toMatchObject({ status: 200 });

    await expect(state.gateway.handle({
      method: "GET",
      path: `/v1/rooms/room-1/change-sets/${state.bundle.draft.draftId}`,
      headers: headers(state.hostToken),
    })).resolves.toMatchObject({ status: 404 });
    await expect(state.staging.get("room-1", state.bundle.draft.draftId)).resolves.toBeUndefined();
    await expect(new ChangeSetStagingService(state.stagingOptions).get("room-1", state.bundle.draft.draftId)).resolves.toBeUndefined();
    const resumed = await new ChangeSetClient({ transport: transport(state.gateway), chunkBytes: 64 }).submit({
      roomId: "room-1", token: state.aliceToken, clientRequestId: "upload-1",
      draftId: state.bundle.draft.draftId, drafts: state.draftStore,
    });
    await expect(new ChangeSetStagingService(state.stagingOptions).get("room-1", resumed.changeSetId)).resolves.toEqual(resumed);
  }, 10_000);

  it("retries idempotently and lets Owner and Participant read the exact same immutable diff", async () => {
    const state = await setup();
    const first = await state.client.submit({
      roomId: "room-1", token: state.aliceToken, clientRequestId: "upload-1",
      draftId: state.bundle.draft.draftId, drafts: state.draftStore,
    });
    const repeated = await state.client.submit({
      roomId: "room-1", token: state.aliceToken, clientRequestId: "upload-1",
      draftId: state.bundle.draft.draftId, drafts: state.draftStore,
    });
    const sameContentNewRequest = await state.client.submit({
      roomId: "room-1", token: state.aliceToken, clientRequestId: "upload-2",
      draftId: state.bundle.draft.draftId, drafts: state.draftStore,
    });
    expect(repeated).toEqual(first);
    expect(sameContentNewRequest).toEqual(first);
    await expect(new ChangeSetStagingService(state.stagingOptions).createUpload({
      roomId: "room-1", principalId: "alice", clientRequestId: "upload-1", draft: state.bundle.draft,
    })).resolves.toMatchObject({ state: "finalized", changeSetId: first.changeSetId });
    expect(await state.client.readPatch({ roomId: "room-1", token: state.hostToken, changeSetId: first.changeSetId })).toBe(state.bundle.patch);
    expect(await state.client.readPatch({ roomId: "room-1", token: state.aliceToken, changeSetId: first.changeSetId })).toBe(state.bundle.patch);
    expect(await readFile(join(state.canonical, "src/value.ts"), "utf8")).toBe("old\n");
    expect((await readdir(join(state.root, "staging", "staged"), { recursive: true })).filter((path) => path.endsWith("manifest.json"))).toHaveLength(1);
  }, 10_000);

  it("rejects reuse of one idempotency key with different content", async () => {
    const state = await setup();
    await state.client.submit({
      roomId: "room-1", token: state.aliceToken, clientRequestId: "upload-1",
      draftId: state.bundle.draft.draftId, drafts: state.draftStore,
    });
    const conflicting = structuredClone(state.bundle.draft);
    conflicting.summary = "different";
    await expect(state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/change-sets/uploads", headers: headers(state.aliceToken),
      body: { clientRequestId: "upload-1", draft: conflicting },
    })).resolves.toMatchObject({ status: 409, body: { error: { code: "REQUEST_CONFLICT" } } });
  }, 10_000);

  it("rejects tampered artifacts at finalize without exposing a ChangeSet", async () => {
    const state = await setup();
    const created = await state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/change-sets/uploads", headers: headers(state.aliceToken),
      body: { clientRequestId: "upload-1", draft: state.bundle.draft },
    });
    const uploadId = (created.body as { upload: { uploadId: string } }).upload.uploadId;
    const patch = Buffer.from(state.bundle.patch.replace("new", "BAD"));
    await state.gateway.handle({
      method: "POST", path: `/v1/rooms/room-1/change-sets/uploads/${uploadId}/chunks`, headers: headers(state.aliceToken),
      body: { target: "patch", offset: 0, byteLength: patch.byteLength, chunkHash: sha256(patch), data: patch.toString("base64") },
    });
    for (let fileIndex = 0; fileIndex < state.bundle.draft.files.length; fileIndex += 1) {
      const file = state.bundle.draft.files[fileIndex]!;
      if (!file.resultContentHash) continue;
      const bytes = Buffer.from(await state.draftStore.readResult(state.bundle.draft.draftId, file.path));
      await state.gateway.handle({
        method: "POST", path: `/v1/rooms/room-1/change-sets/uploads/${uploadId}/chunks`, headers: headers(state.aliceToken),
        body: { target: "result", fileIndex, offset: 0, byteLength: bytes.byteLength, chunkHash: sha256(bytes), data: bytes.toString("base64") },
      });
    }
    await expect(state.gateway.handle({
      method: "POST", path: `/v1/rooms/room-1/change-sets/uploads/${uploadId}/finalize`, headers: headers(state.aliceToken), body: {},
    })).resolves.toMatchObject({ status: 422 });
    await expect(state.staging.get("room-1", state.bundle.draft.draftId)).resolves.toBeUndefined();
  }, 10_000);

  it("recomputes every result blob instead of trusting its uploaded chunk hash", async () => {
    const state = await setup();
    const created = await state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/change-sets/uploads", headers: headers(state.aliceToken),
      body: { clientRequestId: "tampered-result", draft: state.bundle.draft },
    });
    const uploadId = (created.body as { upload: { uploadId: string } }).upload.uploadId;
    const patch = Buffer.from(state.bundle.patch);
    await state.gateway.handle({
      method: "POST", path: `/v1/rooms/room-1/change-sets/uploads/${uploadId}/chunks`, headers: headers(state.aliceToken),
      body: { target: "patch", offset: 0, byteLength: patch.byteLength, chunkHash: sha256(patch), data: patch.toString("base64") },
    });
    let tampered = false;
    for (let fileIndex = 0; fileIndex < state.bundle.draft.files.length; fileIndex += 1) {
      const file = state.bundle.draft.files[fileIndex]!;
      if (!file.resultContentHash) continue;
      const bytes = Buffer.from(await state.draftStore.readResult(state.bundle.draft.draftId, file.path));
      if (!tampered && bytes.byteLength > 0) {
        bytes[0] = bytes[0] === 65 ? 66 : 65;
        tampered = true;
      }
      await state.gateway.handle({
        method: "POST", path: `/v1/rooms/room-1/change-sets/uploads/${uploadId}/chunks`, headers: headers(state.aliceToken),
        body: { target: "result", fileIndex, offset: 0, byteLength: bytes.byteLength, chunkHash: sha256(bytes), data: bytes.toString("base64") },
      });
    }
    await expect(state.gateway.handle({
      method: "POST", path: `/v1/rooms/room-1/change-sets/uploads/${uploadId}/finalize`, headers: headers(state.aliceToken), body: {},
    })).resolves.toMatchObject({ status: 422 });
    await expect(state.staging.get("room-1", state.bundle.draft.draftId)).resolves.toBeUndefined();
  }, 10_000);

  it("binds author, room membership, base version and capability at the Gateway boundary", async () => {
    const state = await setup();
    await expect(state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/change-sets/uploads", headers: headers(state.observerToken),
      body: { clientRequestId: "observer-upload", draft: state.bundle.draft },
    })).resolves.toMatchObject({ status: 403 });
    await expect(state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/change-sets/uploads", headers: { authorization: `Bearer ${state.aliceToken}` },
      body: { clientRequestId: "no-capability", draft: state.bundle.draft },
    })).resolves.toMatchObject({ status: 404 });
    await expect(state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-2/change-sets/uploads", headers: headers(state.aliceToken),
      body: { clientRequestId: "wrong-room", draft: state.bundle.draft },
    })).resolves.toMatchObject({ status: 403, body: { error: { code: "TOKEN_SCOPE" } } });
    const wrongAuthor = structuredClone(state.bundle.draft);
    wrongAuthor.authorId = "member-host";
    await expect(state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/change-sets/uploads", headers: headers(state.aliceToken),
      body: { clientRequestId: "wrong-author", draft: wrongAuthor },
    })).resolves.toMatchObject({ status: 422 });
    state.sharing.set("room-1", false, "member-host", 40);
    await expect(state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/change-sets/uploads", headers: headers(state.aliceToken),
      body: { clientRequestId: "sharing-disabled", draft: state.bundle.draft },
    })).resolves.toMatchObject({ status: 409, body: { error: { code: "WORKSPACE_SHARING_DISABLED" } } });
  }, 10_000);
});
