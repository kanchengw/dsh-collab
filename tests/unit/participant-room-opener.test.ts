import { describe, expect, it, vi } from "vitest";
import { createDshJoinedRoomOpener } from "../../src/dsh-client.js";

describe("createDshJoinedRoomOpener", () => {
  it("connects the joined room, registers its local project, then opens the native workspace", async () => {
    const connectJoinedRoom = vi.fn(async (_ref: { gatewayEndpoint: string; roomId: string }) => {});
    let connected = false;
    const getRoomSnapshot = vi.fn(() => ({
      roomId: connected ? "room-1" : "other-room",
      gatewayEndpoint: "ws://127.0.0.1:4310/collab",
      memberId: connected ? "member-1" : "other-member",
      roomTitle: "Release",
      hostDisplayName: "Host",
      role: "participant" as const,
      connection: connected ? "online" as const : "offline" as const,
    }));
    const openWorkspace = vi.fn(async () => {});
    const setJoinedRoomWorkspacePath = vi.fn(async (_ref: { gatewayEndpoint: string; roomId: string }, _path: string, _summary?: { fileCount: number; totalBytes: number }) => {});
    const setJoinedRoomWorkspaceSummary = vi.fn(async (_ref: { gatewayEndpoint: string; roomId: string }, _summary: { fileCount: number; totalBytes: number }) => {});
    const onWorkspaceSummary = vi.fn();
    const rpc = {
      call: vi.fn(async (_channel: string, endpoint: string) => endpoint.endsWith("/summary")
        ? { ok: true, value: { roomId: "room-1", fileCount: 3, totalBytes: 4096 } }
        : {
            ok: true,
            value: {
              roomId: "room-1",
              memberId: "member-1",
              roomTitle: "Release",
              workspacePath: "C:\\rooms\\room-1\\workspace",
              nativeWorkspaceId: "native-room-1",
              fileCount: 3,
              totalBytes: 4096,
            },
          }),
    };

    const opener = createDshJoinedRoomOpener({
      settings: {
        connectJoinedRoom: vi.fn(async (ref) => {
          connected = true;
          await connectJoinedRoom(ref);
        }),
        getRoomSnapshot,
        setJoinedRoomWorkspacePath,
        setJoinedRoomWorkspaceSummary,
        getLocalSnapshotAccess: (_roomId: string) => ({
          gatewayEndpoint: "ws://127.0.0.1:4310/collab",
          roomToken: "room-token",
        }),
      },
      rpc,
      openWorkspace,
    });

    await opener({
      roomId: "room-1",
      gatewayEndpoint: "ws://127.0.0.1:4310/collab",
      roomTitle: "Release",
      hostDisplayName: "Host",
      onWorkspaceSummary,
    });

    expect(connectJoinedRoom).toHaveBeenCalledWith({
      gatewayEndpoint: "ws://127.0.0.1:4310/collab",
      roomId: "room-1",
    });
    expect(rpc.call).toHaveBeenCalledWith(
      "/dsh-collab",
      "participant/room-project/summary",
      {
        roomId: "room-1",
        gatewayEndpoint: "ws://127.0.0.1:4310/collab",
        roomToken: "room-token",
      },
    );
    expect(setJoinedRoomWorkspaceSummary).toHaveBeenCalledWith(
      { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomId: "room-1" },
      { fileCount: 3, totalBytes: 4096 },
    );
    expect(onWorkspaceSummary).toHaveBeenCalledWith({ fileCount: 3, totalBytes: 4096 });
    expect(rpc.call).toHaveBeenCalledWith(
      "/dsh-collab",
      "participant/room-project/join",
      {
        roomId: "room-1",
        memberId: "member-1",
        roomTitle: "Release",
        gatewayEndpoint: "ws://127.0.0.1:4310/collab",
        roomToken: "room-token",
      },
    );
    expect(openWorkspace).toHaveBeenCalledWith({
      roomId: "room-1",
      path: "C:\\rooms\\room-1\\workspace",
      nativeWorkspaceId: "native-room-1",
      gatewayEndpoint: "ws://127.0.0.1:4310/collab",
      roomTitle: "Release",
      hostDisplayName: "Host",
    });
    expect(setJoinedRoomWorkspacePath).toHaveBeenCalledWith(
      { gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomId: "room-1" },
      "C:\\rooms\\room-1\\workspace",
      { fileCount: 3, totalBytes: 4096 },
    );
  });

  it("reopens an existing local workspace without downloading or rematerializing it", async () => {
    const connectJoinedRoom = vi.fn(async () => {});
    const openWorkspace = vi.fn(async () => {});
    const rpc = { call: vi.fn(async () => { throw new Error("RPC should not be called for an existing local workspace"); }) };
    const opener = createDshJoinedRoomOpener({
      settings: {
        connectJoinedRoom,
        getRoomSnapshot: () => ({
          roomId: "room-1",
          gatewayEndpoint: "ws://127.0.0.1:4310/collab",
          memberId: "member-1",
          roomTitle: "Release",
          hostDisplayName: "Host",
          role: "participant" as const,
          connection: "online" as const,
        }),
        getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://127.0.0.1:4310/collab", roomToken: "room-token" }),
      },
      rpc,
      openWorkspace,
    });

    await opener({
      roomId: "room-1",
      gatewayEndpoint: "ws://127.0.0.1:4310/collab",
      roomTitle: "Release",
      hostDisplayName: "Host",
      workspacePath: "C:\\rooms\\room-1\\workspace",
    });

    expect(connectJoinedRoom).not.toHaveBeenCalled();
    expect(rpc.call).not.toHaveBeenCalled();
    expect(openWorkspace).toHaveBeenCalledWith({
      roomId: "room-1",
      path: "C:\\rooms\\room-1\\workspace",
      gatewayEndpoint: "ws://127.0.0.1:4310/collab",
      roomTitle: "Release",
      hostDisplayName: "Host",
    });
  });
});
