import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { ActiveRoomRegistry } from "../../src/active-rooms.js";
import { WORKSPACE_VERSION_CAPABILITY, type WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { EventLedger } from "../../src/events.js";
import { CollabGateway } from "../../src/gateway.js";
import { InviteStore } from "../../src/invites.js";
import type { ParticipantGatewayTransport } from "../../src/participant.js";
import { COLLAB_CAPABILITY_HEADER } from "../../src/protocol.js";
import { RoomStore } from "../../src/room.js";
import type { GatewayResponse } from "../../src/types.js";
import { WorkspaceVersionClient } from "../../src/workspace-version-transport.js";
import { WorkspaceVersionService } from "../../src/workspace-versions.js";
import { WorkspaceService, type WorkspaceSnapshotProvider } from "../../src/workspace-service.js";
import { WorkspaceSharingRegistry } from "../../src/workspace-sharing.js";
import { WorkspaceSnapshotStore } from "../../src/workspace-snapshot-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-version-host-"));
  roots.push(root);
  const artifactStore = new WorkspaceSnapshotStore(root);
  const content = Buffer.from("export const value = 1;\n");
  let captures = 0;
  const provider: WorkspaceSnapshotProvider & { readFile(snapshotId: string, path: string): Promise<Uint8Array> } = {
    async capture(input) {
      captures += 1;
      const files = [{ path: "src/value.ts", contentHash: sha256(content), size: content.byteLength, source: "tracked" as const }];
      const snapshot: WorkspaceSnapshotPackage = {
        snapshotId: input.snapshotId,
        roomId: input.roomId,
        hostSessionId: input.hostSessionId,
        roomEventSeq: input.roomEventSeq,
        headOid: "a".repeat(40),
        manifestHash: sha256(JSON.stringify(files)),
        files,
        createdAt: 20,
      };
      await artifactStore.save(snapshot, new Map([["src/value.ts", content]]));
      return snapshot;
    },
    load: (snapshotId) => artifactStore.load(snapshotId),
    readFile: (snapshotId, path) => artifactStore.readFile(snapshotId, path),
    readChunk: (snapshotId, path, offset, length) => artifactStore.readChunk(snapshotId, path, offset, length),
  };
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Room", hostDisplayName: "Host", now: 1 });
  rooms.addMember("room-1", { memberId: "member-alice", principalId: "alice", displayName: "Alice", now: 2 });
  const ledger = new EventLedger();
  const sharing = new WorkspaceSharingRegistry();
  const workspace = new WorkspaceService({ rooms, registry: sharing, snapshots: provider, now: () => 20 });
  const workspaceVersions = new WorkspaceVersionService({ rooms, ledger, artifacts: provider });
  const activeRooms = new ActiveRoomRegistry();
  activeRooms.activate("room-1");
  const gateway = new CollabGateway({
    rooms,
    ledger,
    invites: new InviteStore(rooms),
    agent: { followup() {}, steer() {}, cancel() {} },
    tokenFactory: (() => { let next = 0; return () => `token-${String(++next)}`; })(),
    tokenTtlMs: null,
    activeRooms,
    workspace,
    workspaceVersions,
  });
  const host = await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
  const participant = await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "alice" } });
  return {
    gateway,
    ledger,
    rooms,
    sharing,
    workspaceVersions,
    hostToken: (host.body as { roomToken: string }).roomToken,
    participantToken: (participant.body as { roomToken: string }).roomToken,
    captures: () => captures,
  };
}

function headers(token: string, capability = true): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    ...(capability ? { [COLLAB_CAPABILITY_HEADER]: WORKSPACE_VERSION_CAPABILITY } : {}),
  };
}

async function publish(state: Awaited<ReturnType<typeof setup>>): Promise<GatewayResponse> {
  state.sharing.set("room-1", true, "member-host", 10);
  return await state.gateway.handle({
    method: "POST",
    path: "/v1/rooms/room-1/workspace-versions",
    headers: headers(state.hostToken),
    body: { clientRequestId: "publish-1" },
  });
}

function transport(gateway: CollabGateway, mutate?: (response: GatewayResponse, path: string) => GatewayResponse): ParticipantGatewayTransport {
  return {
    async request(input) {
      if (input.signal?.aborted) throw input.signal.reason;
      const response = await gateway.handle({
        method: input.method,
        path: input.path,
        headers: {
          authorization: `Bearer ${input.token}`,
          [COLLAB_CAPABILITY_HEADER]: input.capabilities?.join(",") ?? "",
        },
        body: input.body,
      });
      return mutate?.(response, input.path) ?? response;
    },
  };
}

describe("WorkspaceVersion publish/download transport", () => {
  it("requires explicit sharing, the version capability, and Owner publication while keeping retries idempotent", async () => {
    const state = await setup();
    await expect(state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/workspace-versions", headers: headers(state.hostToken), body: { clientRequestId: "publish-1" },
    })).resolves.toMatchObject({ status: 409, body: { error: { code: "WORKSPACE_SHARING_DISABLED" } } });
    state.sharing.set("room-1", true, "member-host", 10);
    await expect(state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/workspace-versions", headers: headers(state.hostToken, false), body: { clientRequestId: "publish-1" },
    })).resolves.toMatchObject({ status: 404 });
    await expect(state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/workspace-versions", headers: headers(state.participantToken), body: { clientRequestId: "publish-1" },
    })).resolves.toMatchObject({ status: 403, body: { error: { code: "ACTION_FORBIDDEN" } } });
    expect(state.captures()).toBe(0);

    const first = await state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/workspace-versions", headers: headers(state.hostToken), body: { clientRequestId: "publish-1" },
    });
    expect(first).toMatchObject({ status: 201, body: { record: { version: { roomId: "room-1", createdBy: "member-host" } } } });
    const repeated = await state.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/workspace-versions", headers: headers(state.hostToken), body: { clientRequestId: "publish-1" },
    });
    expect(repeated).toMatchObject({ status: 200, body: first.body });
    expect(state.captures()).toBe(1);
    expect(state.ledger.latestSeq("room-1")).toBe(1);
  });

  it("downloads an authenticated version into the local artifact store only after complete verification", async () => {
    const state = await setup();
    const published = await publish(state);
    const workspaceVersionId = (published.body as { record: { version: { workspaceVersionId: string } } }).record.version.workspaceVersionId;
    const localRoot = await mkdtemp(join(tmpdir(), "dsh-collab-version-client-"));
    roots.push(localRoot);
    const artifacts = new WorkspaceSnapshotStore(localRoot);
    const client = new WorkspaceVersionClient({ transport: transport(state.gateway), artifacts, chunkBytes: 7 });

    const first = await client.download({ roomId: "room-1", token: state.participantToken, workspaceVersionId });
    expect(first.stored).toBe(true);
    expect(first.record.version.workspaceVersionId).toBe(workspaceVersionId);
    expect(await artifacts.readFile(workspaceVersionId, "src/value.ts")).toEqual(Buffer.from("export const value = 1;\n"));
    await expect(client.downloadLatest({ roomId: "room-1", token: state.participantToken })).resolves.toMatchObject({ stored: false });
  });

  it("rejects a valid but different version returned for an exact download request", async () => {
    const state = await setup();
    await publish(state);
    const localRoot = await mkdtemp(join(tmpdir(), "dsh-collab-version-client-"));
    roots.push(localRoot);
    const artifacts = new WorkspaceSnapshotStore(localRoot);
    const base = transport(state.gateway);
    const misdirected: ParticipantGatewayTransport = {
      request: (input) => base.request({ ...input, path: "/v1/rooms/room-1/workspace-versions/latest" }),
    };

    await expect(new WorkspaceVersionClient({ transport: misdirected, artifacts }).download({
      roomId: "room-1",
      token: state.participantToken,
      workspaceVersionId: "f".repeat(64),
    })).rejects.toThrow("identity");
    await expect(artifacts.load("f".repeat(64))).resolves.toBeUndefined();
  });

  it.each([
    ["interrupted", (_response: GatewayResponse) => { throw new Error("connection lost"); }],
    ["out-of-order", (response: GatewayResponse) => ({ ...response, body: { chunk: { ...(response.body as { chunk: object }).chunk, offset: 99 } } })],
    ["tampered", (response: GatewayResponse) => ({ ...response, body: { chunk: { ...(response.body as { chunk: object }).chunk, chunkHash: "0".repeat(64) } } })],
  ])("rejects %s chunks without exposing a partial local version, then retries cleanly", async (_name, corrupt) => {
    const state = await setup();
    const published = await publish(state);
    const workspaceVersionId = (published.body as { record: { version: { workspaceVersionId: string } } }).record.version.workspaceVersionId;
    const localRoot = await mkdtemp(join(tmpdir(), "dsh-collab-version-client-"));
    roots.push(localRoot);
    const artifacts = new WorkspaceSnapshotStore(localRoot);
    let corrupted = false;
    const badTransport = transport(state.gateway, (response, path) => {
      if (!corrupted && path.includes("/files/")) {
        corrupted = true;
        return corrupt(response);
      }
      return response;
    });

    await expect(new WorkspaceVersionClient({ transport: badTransport, artifacts, chunkBytes: 7 })
      .download({ roomId: "room-1", token: state.participantToken, workspaceVersionId })).rejects.toThrow();
    await expect(artifacts.load(workspaceVersionId)).resolves.toBeUndefined();
    await expect(new WorkspaceVersionClient({ transport: transport(state.gateway), artifacts, chunkBytes: 7 })
      .download({ roomId: "room-1", token: state.participantToken, workspaceVersionId })).resolves.toMatchObject({ stored: true });
  });

  it("rejects private fields smuggled into the Snapshot manifest", async () => {
    const state = await setup();
    const published = await publish(state);
    const workspaceVersionId = (published.body as { record: { version: { workspaceVersionId: string } } }).record.version.workspaceVersionId;
    const localRoot = await mkdtemp(join(tmpdir(), "dsh-collab-version-client-"));
    roots.push(localRoot);
    const artifacts = new WorkspaceSnapshotStore(localRoot);
    const leaky = transport(state.gateway, (response, path) => path.includes("/workspace-versions/") && !path.includes("/files/")
      ? { ...response, body: { ...(response.body as object), snapshot: { ...(response.body as { snapshot: object }).snapshot, transcript: "private" } } }
      : response);

    await expect(new WorkspaceVersionClient({ transport: leaky, artifacts })
      .download({ roomId: "room-1", token: state.participantToken, workspaceVersionId })).rejects.toThrow("unsupported");
    await expect(artifacts.load(workspaceVersionId)).resolves.toBeUndefined();
  });

  it("revokes download access when sharing stops or membership becomes inactive", async () => {
    const state = await setup();
    const published = await publish(state);
    const workspaceVersionId = (published.body as { record: { version: { workspaceVersionId: string } } }).record.version.workspaceVersionId;
    state.sharing.set("room-1", false, "member-host", 30);
    await expect(state.gateway.handle({
      method: "GET", path: `/v1/rooms/room-1/workspace-versions/${workspaceVersionId}`, headers: headers(state.participantToken),
    })).resolves.toMatchObject({ status: 409, body: { error: { code: "WORKSPACE_SHARING_DISABLED" } } });
    state.sharing.set("room-1", true, "member-host", 31);
    state.rooms.setMemberStatus("room-1", "member-alice", "suspended");
    await expect(state.gateway.handle({
      method: "GET", path: `/v1/rooms/room-1/workspace-versions/${workspaceVersionId}`, headers: headers(state.participantToken),
    })).resolves.toMatchObject({ status: 403, body: { error: { code: "MEMBER_INACTIVE" } } });
  });
});
