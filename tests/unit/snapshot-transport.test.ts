import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ActiveRoomRegistry } from "../../src/active-rooms.js";
import type { WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { CollaborationWorkspaceClient } from "../../src/collaboration-client.js";
import { EventLedger } from "../../src/events.js";
import { CollabGateway } from "../../src/gateway.js";
import { InviteStore } from "../../src/invites.js";
import { RoomStore } from "../../src/room.js";
import { SnapshotWorkspaceMaterializer } from "../../src/snapshot-workspace.js";
import type { GatewayResponse } from "../../src/types.js";
import { WorkspaceService, type WorkspaceSnapshotProvider } from "../../src/workspace-service.js";
import { WorkspaceSharingRegistry } from "../../src/workspace-sharing.js";
import { WorkspaceSnapshotError } from "../../src/workspace-snapshot.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function snapshot(content = Buffer.from("export const value = 1;\n")): WorkspaceSnapshotPackage {
  const files = [{ path: "src/value.ts", contentHash: sha256(content), size: content.byteLength, source: "tracked" as const }];
  return {
    snapshotId: "snapshot-1",
    roomId: "room-1",
    hostSessionId: "session-1",
    roomEventSeq: 3,
    headOid: "0123456789abcdef0123456789abcdef01234567",
    manifestHash: sha256(JSON.stringify(files)),
    files,
    createdAt: 20,
  };
}

function gatewaySetup() {
  const content = Buffer.from("export const value = 1;\n");
  const packageValue = snapshot(content);
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", now: 1 });
  rooms.addMember("room-1", { memberId: "member-alice", principalId: "alice", displayName: "Alice", now: 2 });
  const activeRooms = new ActiveRoomRegistry();
  activeRooms.activate("room-1");
  const captured = new Map<string, WorkspaceSnapshotPackage>();
  const snapshots: WorkspaceSnapshotProvider = {
    capture: vi.fn(async (input) => {
      const result = { ...packageValue, snapshotId: input.snapshotId, roomEventSeq: input.roomEventSeq };
      captured.set(result.snapshotId, result);
      return result;
    }),
    load: async (snapshotId) => captured.get(snapshotId),
    readChunk: async (_snapshotId, _path, offset, length) => content.subarray(offset, offset + length),
  };
  const registry = new WorkspaceSharingRegistry();
  const workspace = new WorkspaceService({ rooms, registry, snapshots, now: () => 10 });
  const gateway = new CollabGateway({
    rooms,
    ledger: new EventLedger(),
    invites: new InviteStore(rooms),
    agent: { followup() {}, steer() {}, cancel() {} },
    tokenFactory: () => "room-token",
    now: () => 20,
    activeRooms,
    workspace,
  });
  return { gateway, registry, rooms, snapshots };
}

const capabilityHeaders = {
  authorization: "Bearer room-token",
  "x-dsh-collab-capabilities": "sidecar-review.v1",
};

describe("Workspace Snapshot transport", () => {
  it("captures idempotently and serves authenticated content chunks only while Workspace Sharing is enabled", async () => {
    const { gateway, registry, rooms, snapshots } = gatewaySetup();
    await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "alice" } });
    registry.set("room-1", true, "member-host", 10);

    const capture = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/workspace-snapshots",
      headers: capabilityHeaders,
      body: { clientRequestId: "capture-1" },
    });
    expect(capture).toMatchObject({ status: 201, body: { snapshot: { roomId: "room-1", files: [{ path: "src/value.ts" }] } } });
    const captured = (capture.body as { snapshot: WorkspaceSnapshotPackage }).snapshot;

    const repeated = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/workspace-snapshots",
      headers: capabilityHeaders,
      body: { clientRequestId: "capture-1" },
    });
    expect(repeated.body).toEqual(capture.body);
    expect(snapshots.capture).toHaveBeenCalledTimes(1);
    const restoredService = new WorkspaceService({ rooms, registry, snapshots });
    await expect(restoredService.captureLatest({ roomId: "room-1", principalId: "alice", clientRequestId: "capture-1", roomEventSeq: 99 }))
      .resolves.toEqual(captured);
    expect(snapshots.capture).toHaveBeenCalledTimes(1);

    const chunk = await gateway.handle({
      method: "GET",
      path: `/v1/rooms/room-1/workspace-snapshots/${captured.snapshotId}/files/0?offset=0&limit=8`,
      headers: capabilityHeaders,
    });
    expect(chunk).toMatchObject({
      status: 200,
      body: { chunk: { snapshotId: captured.snapshotId, fileIndex: 0, offset: 0, byteLength: 8, eof: false } },
    });
    await expect(gateway.handle({
      method: "GET",
      path: `/v1/rooms/room-1/workspace-snapshots/${captured.snapshotId}/files/0?offset=0&limit=8`,
      headers: capabilityHeaders,
    })).resolves.toEqual(chunk);

    registry.clear("room-1");
    await expect(gateway.handle({
      method: "GET",
      path: `/v1/rooms/room-1/workspace-snapshots/${captured.snapshotId}`,
      headers: capabilityHeaders,
    })).resolves.toMatchObject({ status: 409, body: { error: { code: "WORKSPACE_SHARING_DISABLED" } } });
    await expect(gateway.handle({
      method: "GET",
      path: `/v1/rooms/room-1/workspace-snapshots/${captured.snapshotId}`,
      headers: { authorization: "Bearer room-token" },
    })).resolves.toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });

    registry.set("room-1", true, "member-host", 11);
    await expect(gateway.handle({
      method: "GET",
      path: "/v1/rooms/room-1/workspace-snapshots/not-a-snapshot",
      headers: capabilityHeaders,
    })).resolves.toMatchObject({ status: 422, body: { error: { code: "INVALID_INPUT" } } });
  });

  it("returns stable public errors instead of leaking Host capture failures", async () => {
    const { gateway, registry, snapshots } = gatewaySetup();
    await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "alice" } });
    registry.set("room-1", true, "member-host", 10);
    vi.mocked(snapshots.capture).mockRejectedValueOnce(new WorkspaceSnapshotError("WORKSPACE_NOT_GIT", "private Host path is not Git"));

    await expect(gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/workspace-snapshots", headers: capabilityHeaders, body: { clientRequestId: "not-git" },
    })).resolves.toMatchObject({ status: 422, body: { error: { code: "SNAPSHOT_INVALID", message: "Unable to capture Workspace Snapshot" } } });

    vi.mocked(snapshots.capture).mockRejectedValueOnce(new WorkspaceSnapshotError("WORKSPACE_LIMIT", "private file is too large"));
    await expect(gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/workspace-snapshots", headers: capabilityHeaders, body: { clientRequestId: "too-large" },
    })).resolves.toMatchObject({ status: 429, body: { error: { code: "RESOURCE_LIMIT", message: "Workspace Snapshot exceeds the configured limit" } } });
  });

  it("downloads, verifies and idempotently materializes a read-only local workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-"));
    temporaryDirectories.push(root);
    const content = Buffer.from("export const value = 1;\n");
    const packageValue = snapshot(content);
    let online = true;
    const transport = {
      async request(input: { method: "GET" | "POST"; path: string; token: string; body?: unknown }): Promise<GatewayResponse> {
        if (!online) throw new Error("Host is offline");
        if (input.method === "POST") return { status: 201, body: { snapshot: packageValue } };
        if (!input.path.includes("/files/")) return { status: 200, body: { snapshot: packageValue } };
        const url = new URL(input.path, "http://collab.local");
        const offset = Number(url.searchParams.get("offset"));
        const limit = Number(url.searchParams.get("limit"));
        const bytes = content.subarray(offset, offset + limit);
        return { status: 200, body: { chunk: {
          snapshotId: packageValue.snapshotId,
          fileIndex: 0,
          offset,
          byteLength: bytes.byteLength,
          chunkHash: sha256(bytes),
          data: bytes.toString("base64"),
          eof: offset + bytes.byteLength === content.byteLength,
        } } };
      },
    };
    const materializer = new SnapshotWorkspaceMaterializer({ root });
    const client = new CollaborationWorkspaceClient({ transport, materializer, chunkBytes: 8, clientRequestIdFactory: () => "capture-1" });

    const first = await client.downloadLatest({ roomId: "room-1", token: "room-token" });
    const second = await client.downloadSnapshot({ roomId: "room-1", token: "room-token", snapshotId: packageValue.snapshotId });
    expect(second.root).toBe(first.root);
    expect((await stat(join(first.root, "src", "value.ts"))).mode & 0o222).toBe(0);
    online = false;
    await expect(first.readFile("src/value.ts")).resolves.toEqual(content);
  });

  it("rejects tampered chunks, unsafe manifests and download limits before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-workspace-"));
    temporaryDirectories.push(root);
    const content = Buffer.from("safe");
    const packageValue = snapshot(content);
    const transport = {
      async request(input: { method: "GET" | "POST"; path: string }): Promise<GatewayResponse> {
        if (input.method === "POST") return { status: 201, body: { snapshot: packageValue } };
        return { status: 200, body: { chunk: {
          snapshotId: packageValue.snapshotId,
          fileIndex: 0,
          offset: 0,
          byteLength: 4,
          chunkHash: sha256("different"),
          data: content.toString("base64"),
          eof: true,
        } } };
      },
    };
    const client = new CollaborationWorkspaceClient({
      transport,
      materializer: new SnapshotWorkspaceMaterializer({ root }),
      maxTotalBytes: 1024,
      clientRequestIdFactory: () => "capture-1",
    });
    await expect(client.downloadLatest({ roomId: "room-1", token: "room-token" })).rejects.toThrow("chunk hash");

    const unsafeFiles = [{ ...packageValue.files[0]!, path: "../secret.ts" }];
    const unsafe = { ...packageValue, files: unsafeFiles, manifestHash: sha256(JSON.stringify(unsafeFiles)) };
    const unsafeClient = new CollaborationWorkspaceClient({
      transport: { request: async () => ({ status: 201, body: { snapshot: unsafe } }) },
      materializer: new SnapshotWorkspaceMaterializer({ root }),
      clientRequestIdFactory: () => "capture-2",
    });
    await expect(unsafeClient.downloadLatest({ roomId: "room-1", token: "room-token" })).rejects.toThrow("manifest");

    const limitedClient = new CollaborationWorkspaceClient({
      transport: { request: async () => ({ status: 201, body: { snapshot: packageValue } }) },
      materializer: new SnapshotWorkspaceMaterializer({ root }),
      maxTotalBytes: 1,
      clientRequestIdFactory: () => "capture-3",
    });
    await expect(limitedClient.downloadLatest({ roomId: "room-1", token: "room-token" })).rejects.toThrow("limit");
  });
});
