import { describe, expect, it } from "vitest";
import { CollabError } from "../../src/errors.js";
import { RoomStore } from "../../src/room.js";
import { RoomTokenStore } from "../../src/tokens.js";
import { EventLedger } from "../../src/events.js";
import { RoomStreamHub } from "../../src/stream.js";

function setup() {
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Release", hostDisplayName: "Host", now: 1 });
  rooms.addMember("room-1", { memberId: "member-bob", principalId: "bob", displayName: "Bob", now: 2 });
  const tokens = new RoomTokenStore(rooms, { tokenFactory: (() => { let count = 0; return () => `token-${++count}`; })(), ttlMs: 1000 });
  return { rooms, tokens };
}

describe("room token revocation", () => {
  it("revokes one token and all tokens for a member", () => {
    const { rooms, tokens } = setup();
    const member = rooms.authorize("room-1", "bob", "read");
    const first = tokens.issue({ roomId: "room-1", member, deviceId: "device-1", now: 10 });
    const second = tokens.issue({ roomId: "room-1", member, deviceId: "device-2", now: 10 });
    tokens.revokeToken(first.token, 11);
    expect(() => tokens.verify({ roomId: "room-1", token: first.token, now: 11 })).toThrowError(CollabError);
    expect(tokens.verify({ roomId: "room-1", token: second.token, now: 11 }).deviceId).toBe("device-2");
    expect(tokens.revokeMember("room-1", "member-bob", 12)).toBe(1);
    expect(() => tokens.verify({ roomId: "room-1", token: second.token, now: 12 })).toThrow("revoked");
  });

  it("revokes every token registered to a device without affecting another device", () => {
    const { rooms, tokens } = setup();
    const member = rooms.authorize("room-1", "bob", "read");
    const laptop = tokens.issue({ roomId: "room-1", member, deviceId: "device-laptop", now: 10 });
    const phone = tokens.issue({ roomId: "room-1", member, deviceId: "device-phone", now: 10 });
    expect(tokens.revokeDevice("device-laptop", 11)).toBe(1);
    expect(() => tokens.verify({ roomId: "room-1", token: laptop.token, now: 11 })).toThrow("revoked");
    expect(tokens.verify({ roomId: "room-1", token: phone.token, now: 11 }).deviceId).toBe("device-phone");
  });

  it("closes an existing stream on the next heartbeat after member revocation", () => {
    const { rooms, tokens } = setup();
    const member = rooms.authorize("room-1", "bob", "read");
    const issued = tokens.issue({ roomId: "room-1", member, now: 10 });
    const hub = new RoomStreamHub({ rooms, tokens, ledger: new EventLedger(), now: () => 10 });
    const frames: string[] = [];
    const connection = hub.connect({ connectionId: "conn-1", roomId: "room-1", token: issued.token, onFrame: (frame) => frames.push(frame.kind) });
    tokens.revokeMember("room-1", "member-bob", 11);
    expect(() => connection.heartbeat()).toThrow("revoked");
    expect(frames).toContain("closed");
  });
});
