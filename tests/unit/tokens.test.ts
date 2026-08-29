import { describe, expect, it } from "vitest";
import { RoomStore } from "../../src/room.js";
import { RoomTokenStore } from "../../src/tokens.js";

function createRooms(): RoomStore {
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Release", hostDisplayName: "Host", now: 1 });
  return rooms;
}

describe("RoomTokenStore", () => {
  it("issues a token without an expiry when the configured lifetime is never", () => {
    const rooms = createRooms();
    rooms.addMember("room-1", { memberId: "member-alice", principalId: "alice", displayName: "Alice", now: 2 });
    const store = new RoomTokenStore(rooms, { ttlMs: null, tokenFactory: () => "room-token" });

    const issued = store.issue({ roomId: "room-1", member: rooms.listMembers("room-1")[1]!, now: 10 });

    expect(issued).toEqual({ token: "room-token", expiresAt: undefined });
    expect(store.verify({ roomId: "room-1", token: issued.token, now: Number.MAX_SAFE_INTEGER })).toMatchObject({ roomId: "room-1", memberId: "member-alice" });
  });
});
