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
    const rpc = {
      call: vi.fn(async () => ({
        ok: true,
        value: {
          roomId: "room-1",
          memberId: "member-1",
          roomTitle: "Release",
          workspacePath: "C:\\rooms\\room-1\\workspace",
          nativeWorkspaceId: "native-room-1",
        },
      })),
    };

    const opener = createDshJoinedRoomOpener({
      settings: {
        connectJoinedRoom: vi.fn(async (ref) => {
          connected = true;
          await connectJoinedRoom(ref);
        }),
        getRoomSnapshot,
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
    });

    expect(connectJoinedRoom).toHaveBeenCalledWith({
      gatewayEndpoint: "ws://127.0.0.1:4310/collab",
      roomId: "room-1",
    });
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
  });
});
