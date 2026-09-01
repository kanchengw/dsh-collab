import { describe, expect, it } from "vitest";
import { WorkspaceSharingRegistry } from "../../src/workspace-sharing.js";
import { WorkspaceService } from "../../src/workspace-service.js";
import { RoomStore } from "../../src/room.js";
import { EventLedger } from "../../src/events.js";

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
  const ledger = new EventLedger();
  const service = new WorkspaceService({ rooms, ledger, registry, now: () => 10 });
  return { ledger, rooms, registry, service };
}

describe("Workspace Sharing", () => {
  it("starts disabled and only records real state changes", () => {
    const { registry } = setup();

    expect(registry.get("room-1")).toEqual({ roomId: "room-1", enabled: false, revision: 0 });
    expect(registry.set("room-1", false, "member-host", 9, 1)).toEqual({ roomId: "room-1", enabled: false, revision: 0 });
    expect(registry.set("room-1", true, "member-host", 10, 1)).toEqual({
      roomId: "room-1",
      enabled: true,
      enabledBy: "member-host",
      enabledAt: 10,
      revision: 1,
    });
    registry.set("room-1", true, "member-host", 11, 2);

  });

  it("allows only the Host to toggle and active members to read when enabled", () => {
    const { ledger, rooms, service } = setup();

    expect(() => service.setSharing({ roomId: "room-1", principalId: "alice", enabled: true })).toThrow("Host");
    const enabled = service.setSharing({ roomId: "room-1", principalId: "host", enabled: true });
    expect(service.requireWorkspaceRead({ roomId: "room-1", principalId: "alice" })).toEqual(enabled);
    expect(ledger.readAfter("room-1", 0)).toEqual([expect.objectContaining({
      type: "workspace-sharing.changed",
      actor: { memberId: "member-host", principalId: "host" },
      payload: enabled,
    })]);

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

  it("keeps durable event revisions monotonic when current sharing state resets after restart", () => {
    const first = setup();
    first.service.setSharing({ roomId: "room-1", principalId: "host", enabled: true });

    const ledger = EventLedger.fromSnapshot(first.ledger.snapshot());
    const service = new WorkspaceService({
      rooms: first.rooms,
      ledger,
      registry: new WorkspaceSharingRegistry(),
      now: () => 20,
    });
    expect(service.getState({ roomId: "room-1", principalId: "host" })).toEqual({
      roomId: "room-1",
      enabled: false,
      revision: 1,
    });
    const enabled = service.setSharing({ roomId: "room-1", principalId: "host", enabled: true });

    expect(enabled.revision).toBe(2);
    expect(ledger.readAfter("room-1", 0).map((event) => event.eventId)).toEqual([
      "workspace-sharing:room-1:1",
      "workspace-sharing:room-1:2",
    ]);
  });
});
