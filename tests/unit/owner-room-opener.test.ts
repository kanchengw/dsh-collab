import { describe, expect, it, vi } from "vitest";
import { createDshOwnedRoomCreator } from "../../src/dsh-client.js";

describe("createDshOwnedRoomCreator", () => {
  it("creates and opens a Host Room Project through the two-phase Owner RPC", async () => {
    const order: string[] = [];
    const rpc = {
      call: vi.fn(async (_channel: string, endpoint: string, payload: unknown) => {
        order.push(endpoint);
        if (endpoint === "owner/room-project/prepare") {
          expect(payload).toEqual({
            sourcePath: "C:\\work\\atlas",
            sourceSessionId: "source-session",
            roomTitle: "Atlas",
          });
          return { ok: true, value: { roomId: "room-atlas", workspacePath: "C:\\rooms\\atlas", nativeWorkspaceId: "native-atlas" } };
        }
        expect(endpoint).toBe("owner/room-project/complete");
        expect(payload).toEqual({
          roomId: "room-atlas",
          sourceSessionId: "source-session",
          hostPrimarySessionId: "host-primary",
        });
        return { ok: true, value: { roomId: "room-atlas", hostPrimarySessionId: "host-primary" } };
      }),
    };
    const create = createDshOwnedRoomCreator({
      rpc,
      workspaces: {
        create: vi.fn(),
        pickDirectory: async () => "C:\\work\\atlas",
      },
      workspaceNavigation: {
        connectWorkspace: async (workspaceId) => {
          order.push(`connect:${workspaceId}`);
          return "host-primary";
        },
      },
      sessions: { open: (sessionId) => { order.push(`open:${sessionId}`); } },
      panelHost: () => ({
        register: () => () => {},
        open: (target) => { order.push(`panel:${target.sessionId}:${target.cwd ?? ""}`); },
      }),
      getActiveTarget: () => ({ sessionId: "source-session", cwd: "C:\\work\\atlas" }),
      refreshOwnedRooms: async () => { order.push("refresh"); },
    });

    await expect(create("Atlas")).resolves.toBe(true);

    expect(order).toEqual([
      "owner/room-project/prepare",
      "connect:native-atlas",
      "open:host-primary",
      "owner/room-project/complete",
      "panel:host-primary:C:\\rooms\\atlas",
      "refresh",
    ]);
  });

  it("stops when the DSH directory picker is cancelled", async () => {
    const rpc = { call: vi.fn() };
    const create = createDshOwnedRoomCreator({
      rpc,
      workspaces: { create: vi.fn(), pickDirectory: async () => null },
      workspaceNavigation: { connectWorkspace: vi.fn() },
      sessions: { open: vi.fn() },
      panelHost: () => ({ register: () => () => {}, open: vi.fn() }),
      getActiveTarget: () => ({ sessionId: "source-session", cwd: "C:\\work\\atlas" }),
    });

    await expect(create("Atlas")).resolves.toBe(false);
    expect(rpc.call).not.toHaveBeenCalled();
  });
});
