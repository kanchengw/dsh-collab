import { describe, expect, it, vi } from "vitest";
import { createDshOwnedRoomCreator } from "../../src/dsh-client.js";
import { closeDshCollabRoom, getDshCollabRoomSelection } from "../../src/collab-rooms.js";

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
      workspaces: { create: vi.fn() },
      workspaceNavigation: {
        connectWorkspace: async (workspaceId) => {
          order.push(`connect:${workspaceId}`);
          return "host-primary";
        },
        openSession: (sessionId) => { order.push(`open:${sessionId}`); },
      },
      sessions: {
        list: { getSnapshot: () => ({ byId: { "source-session": { cwd: "C:\\work\\atlas" } } }) },
      },
      panelHost: () => ({
        register: () => () => {},
        open: (target) => { order.push(`panel:${target.sessionId}:${target.cwd ?? ""}`); },
      }),
      refreshOwnedRooms: async () => { order.push("refresh"); },
      activateHostRoom: async (input) => { expect(input).toEqual({ roomId: "room-atlas", hostSessionId: "host-primary", title: "Atlas" }); order.push("activate"); },
    });

    await expect(create("Atlas", "C:\\work\\atlas")).resolves.toBe(true);

    expect(getDshCollabRoomSelection("host-primary")).toMatchObject({
      kind: "owned",
      roomId: "room-atlas",
      workspacePath: "C:\\rooms\\atlas",
    });
    closeDshCollabRoom("host-primary");

    expect(order).toEqual([
      "owner/room-project/prepare",
      "connect:native-atlas",
      "open:host-primary",
      "owner/room-project/complete",
      "activate",
      "panel:host-primary:C:\\rooms\\atlas",
      "refresh",
    ]);
  });

  it("creates and connects a DSH workspace when the selected directory has no Session", async () => {
    const order: string[] = [];
    const rpc = {
      call: vi.fn(async (_channel: string, endpoint: string, payload: unknown) => {
        order.push(endpoint);
        if (endpoint === "owner/room-project/prepare") {
          expect(payload).toEqual({
            sourcePath: "C:\\work\\atlas",
            sourceSessionId: "source-session-created",
            roomTitle: "Atlas",
          });
          return { ok: true, value: { roomId: "room-atlas", workspacePath: "C:\\rooms\\atlas", nativeWorkspaceId: "native-atlas" } };
        }
        expect(endpoint).toBe("owner/room-project/complete");
        expect(payload).toEqual({
          roomId: "room-atlas",
          sourceSessionId: "source-session-created",
          hostPrimarySessionId: "host-primary",
        });
        return { ok: true, value: { roomId: "room-atlas", hostPrimarySessionId: "host-primary" } };
      }),
    };
    const createWorkspace = vi.fn(async (input: { path: string }) => {
      order.push(`create:${input.path}`);
      return { workspaceId: "source-workspace" };
    });
    const connectWorkspace = vi.fn(async (workspaceId: string) => {
      order.push(`connect:${workspaceId}`);
      return workspaceId === "source-workspace" ? "source-session-created" : "host-primary";
    });
    const create = createDshOwnedRoomCreator({
      rpc,
      workspaces: { create: createWorkspace },
      workspaceNavigation: { connectWorkspace, openSession: vi.fn() },
      sessions: {
        list: { getSnapshot: () => ({ byId: { "source-session": { cwd: "C:\\work\\other" } } }) },
      },
      panelHost: () => ({ register: () => () => {}, open: (target) => { order.push(`panel:${target.sessionId}`); } }),
      refreshOwnedRooms: async () => { order.push("refresh"); },
    });

    await expect(create("Atlas", "C:\\work\\atlas")).resolves.toBe(true);
    expect(order).toEqual([
      "create:C:\\work\\atlas",
      "connect:source-workspace",
      "owner/room-project/prepare",
      "connect:native-atlas",
      "owner/room-project/complete",
      "panel:host-primary",
      "refresh",
    ]);
    expect(createWorkspace).toHaveBeenCalledWith({ path: "C:\\work\\atlas" });
  });

  it("keeps creation usable without an activation callback", async () => {
    const order: string[] = [];
    const rpc = {
      call: vi.fn(async (_channel: string, endpoint: string) => {
        order.push(endpoint);
        if (endpoint === "owner/room-project/prepare") {
          return { ok: true, value: { roomId: "room-atlas", workspacePath: "C:\\rooms\\atlas", nativeWorkspaceId: "native-atlas" } };
        }
        expect(endpoint).toBe("owner/room-project/complete");
        return { ok: true, value: { roomId: "room-atlas", hostPrimarySessionId: "host-primary" } };
      }),
    };
    const create = createDshOwnedRoomCreator({
      rpc,
      workspaces: { create: vi.fn() },
      workspaceNavigation: { connectWorkspace: async () => "host-primary", openSession: vi.fn() },
      sessions: {
        list: { getSnapshot: () => ({ byId: { "source-session": { cwd: "C:\\work\\atlas" } } }) },
      },
      panelHost: () => ({ register: () => () => {}, open: vi.fn() }),
    });

    await expect(create("Atlas", "C:\\work\\atlas")).resolves.toBe(true);
    expect(order).toEqual(["owner/room-project/prepare", "owner/room-project/complete"]);
  });
});
