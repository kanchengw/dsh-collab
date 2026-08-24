import { describe, expect, it } from "vitest";
import { RoomStore } from "../../src/room.js";

describe("RoomStore", () => {
  it("creates a room with one host member and a stable revision", () => {
    const rooms = new RoomStore();

    const room = rooms.createRoom({
      roomId: "room-1",
      hostId: "principal-host",
      hostSessionId: "session-host",
      title: "Release",
      hostDisplayName: "Host",
    });

    expect(room).toMatchObject({
      roomId: "room-1",
      hostId: "principal-host",
      hostSessionId: "session-host",
      title: "Release",
      state: "open",
      revision: 1,
    });
    expect(rooms.listMembers("room-1")).toEqual([
      expect.objectContaining({
        memberId: "member-host",
        principalId: "principal-host",
        role: "host",
        status: "active",
      }),
    ]);
  });

  it("rejects blank titles and duplicate room ids", () => {
    const rooms = new RoomStore();
    expect(() => rooms.createRoom({
      roomId: "room-1",
      hostId: "host",
      hostSessionId: "session",
      title: "   ",
      hostDisplayName: "Host",
    })).toThrow(/title/i);

    rooms.createRoom({
      roomId: "room-1",
      hostId: "host",
      hostSessionId: "session",
      title: "Release",
      hostDisplayName: "Host",
    });
    expect(() => rooms.createRoom({
      roomId: "room-1",
      hostId: "host-2",
      hostSessionId: "session-2",
      title: "Other",
      hostDisplayName: "Other host",
    })).toThrow(/room/i);
  });

  it("adds a participant with a participant role and increments revision", () => {
    const rooms = new RoomStore();
    rooms.createRoom({
      roomId: "room-1",
      hostId: "host",
      hostSessionId: "session",
      title: "Release",
      hostDisplayName: "Host",
    });

    const member = rooms.addMember("room-1", {
      memberId: "member-alice",
      principalId: "alice",
      displayName: "Alice",
    });

    expect(member).toMatchObject({
      memberId: "member-alice",
      principalId: "alice",
      role: "participant",
      status: "active",
    });
    expect(rooms.getRoom("room-1").revision).toBe(2);
  });

  it("does not allow the same principal to join twice", () => {
    const rooms = new RoomStore();
    rooms.createRoom({
      roomId: "room-1",
      hostId: "host",
      hostSessionId: "session",
      title: "Release",
      hostDisplayName: "Host",
    });
    rooms.addMember("room-1", {
      memberId: "member-alice",
      principalId: "alice",
      displayName: "Alice",
    });

    expect(() => rooms.addMember("room-1", {
      memberId: "member-alice-2",
      principalId: "alice",
      displayName: "Alice again",
    })).toThrow(/member|principal|already/i);
  });
});
