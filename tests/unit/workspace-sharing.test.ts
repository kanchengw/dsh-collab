import { describe, expect, it } from "vitest";
import { WorkspaceSharingRegistry } from "../../src/workspace-sharing.js";
import { WorkspaceService } from "../../src/workspace-service.js";
import { RoomStore } from "../../src/room.js";

function setup() {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1",
    hostId: "host",
    hostSessionId: "session-1",
    title: "Room",
    hostDisplayName: "Host",
    now: 1,
  });
  rooms.addMember("room-1", {
    memberId: "member-alice",
    principalId: "alice",
    displayName: "Alice",
    now: 2,
  });
  const registry = new WorkspaceSharingRegistry();
  const service = new WorkspaceService({ rooms, registry, now: () => 10 });
  return { rooms, registry, service };
}

describe("Workspace Sharing", () => {
  it("starts disabled and only emits real state changes", () => {
    const { registry } = setup();
    const changes: unknown[] = [];
    registry.subscribe((event) => changes.push(event));

    expect(registry.get("room-1")).toEqual({ roomId: "room-1", enabled: false, revision: 0 });
    expect(registry.set("room-1", false, "member-host", 9)).toEqual({ roomId: "room-1", enabled: false, revision: 0 });
    expect(registry.set("room-1", true, "member-host", 10)).toEqual({
      roomId: "room-1",
      enabled: true,
      enabledBy: "member-host",
      enabledAt: 10,
      revision: 1,
    });
    registry.set("room-1", true, "member-host", 11);

    expect(changes).toEqual([{
      type: "workspace-sharing.changed",
      state: { roomId: "room-1", enabled: true, enabledBy: "member-host", enabledAt: 10, revision: 1 },
    }]);
  });

  it("allows only the Host to toggle and active members to read when enabled", () => {
    const { rooms, service } = setup();

    expect(() => service.setSharing({ roomId: "room-1", principalId: "alice", enabled: true })).toThrow("Host");
    const enabled = service.setSharing({ roomId: "room-1", principalId: "host", enabled: true });
    expect(service.requireWorkspaceRead({ roomId: "room-1", principalId: "alice" })).toEqual(enabled);

    rooms.setMemberStatus("room-1", "member-alice", "suspended", 11);
    expect(() => service.requireWorkspaceRead({ roomId: "room-1", principalId: "alice" })).toThrow("inactive");
  });

  it("rejects reads while disabled and clears state without persistence", () => {
    const { registry, service } = setup();
    expect(() => service.requireWorkspaceRead({ roomId: "room-1", principalId: "alice" }))
      .toThrowError(expect.objectContaining({ code: "WORKSPACE_SHARING_DISABLED" }));

    service.setSharing({ roomId: "room-1", principalId: "host", enabled: true });
    service.clearRoom("room-1");

    expect(registry.get("room-1")).toEqual({ roomId: "room-1", enabled: false, revision: 0 });
    expect(new WorkspaceSharingRegistry().get("room-1")).toEqual({ roomId: "room-1", enabled: false, revision: 0 });
  });
});
