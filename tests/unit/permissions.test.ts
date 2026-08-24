import { describe, expect, it } from "vitest";
import { RoomStore } from "../../src/room.js";

function createRooms() {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1",
    hostId: "host",
    hostSessionId: "session",
    title: "Release",
    hostDisplayName: "Host",
    now: 1,
  });
  rooms.addMember("room-1", {
    memberId: "member-alice",
    principalId: "alice",
    displayName: "Alice",
    now: 2,
  });
  rooms.addMember("room-1", {
    memberId: "member-observer",
    principalId: "observer",
    displayName: "Observer",
    now: 3,
  });
  rooms.setMemberRole("room-1", "member-observer", "observer");
  return rooms;
}

describe("RoomStore authorization", () => {
  it("allows a participant to read, talk to humans, and request DSH only", () => {
    const rooms = createRooms();

    expect(rooms.authorize("room-1", "alice", "read").memberId).toBe("member-alice");
    expect(rooms.authorize("room-1", "alice", "humanMessage").memberId).toBe("member-alice");
    expect(rooms.authorize("room-1", "alice", "agentRequest").memberId).toBe("member-alice");
    expect(() => rooms.authorize("room-1", "alice", "steer")).toThrowError(expect.objectContaining({ code: "ACTION_FORBIDDEN" }));
    expect(() => rooms.authorize("room-1", "alice", "cancel")).toThrowError(expect.objectContaining({ code: "ACTION_FORBIDDEN" }));
    expect(() => rooms.authorize("room-1", "alice", "approval")).toThrowError(expect.objectContaining({ code: "ACTION_FORBIDDEN" }));
  });

  it("limits an observer to read access", () => {
    const rooms = createRooms();

    expect(rooms.authorize("room-1", "observer", "read").role).toBe("observer");
    expect(() => rooms.authorize("room-1", "observer", "humanMessage")).toThrowError(expect.objectContaining({ code: "ACTION_FORBIDDEN" }));
    expect(() => rooms.authorize("room-1", "observer", "agentRequest")).toThrowError(expect.objectContaining({ code: "ACTION_FORBIDDEN" }));
  });

  it("fails closed for suspended and removed members", () => {
    const rooms = createRooms();
    rooms.setMemberStatus("room-1", "member-alice", "suspended");
    expect(() => rooms.authorize("room-1", "alice", "read")).toThrow(/inactive/i);

    rooms.setMemberStatus("room-1", "member-alice", "active");
    rooms.setMemberStatus("room-1", "member-alice", "removed");
    expect(() => rooms.authorize("room-1", "alice", "read")).toThrow(/inactive/i);
  });

  it("allows Host to manage members but never removes the Host", () => {
    const rooms = createRooms();

    expect(rooms.authorize("room-1", "host", "manageMembers").role).toBe("host");
    expect(() => rooms.setMemberStatus("room-1", "member-host", "removed")).toThrow(/host/i);
  });

  it("allows reading a closed room but blocks all writes", () => {
    const rooms = createRooms();
    rooms.setRoomState("room-1", "closed");

    expect(rooms.authorize("room-1", "alice", "read").memberId).toBe("member-alice");
    expect(() => rooms.authorize("room-1", "alice", "humanMessage")).toThrowError(expect.objectContaining({ code: "ACTION_FORBIDDEN" }));
  });
});
