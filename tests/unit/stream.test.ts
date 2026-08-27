import { describe, expect, it } from "vitest";
import { EventLedger } from "../../src/events.js";
import { RoomStore } from "../../src/room.js";
import { RoomTokenStore } from "../../src/tokens.js";
import { RoomStreamHub } from "../../src/stream.js";
import type { StreamFrame } from "../../src/types.js";

function setup() {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1",
    hostId: "host",
    hostSessionId: "session-host",
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
  rooms.createRoom({
    roomId: "room-2",
    hostId: "other-host",
    hostSessionId: "session-other-host",
    title: "Other",
    hostDisplayName: "Other Host",
    now: 1,
  });
  const ledger = new EventLedger();
  const tokens = new RoomTokenStore(rooms, { tokenFactory: (() => {
    let count = 0;
    return () => "room-token-" + (++count);
  })() });
  const token1 = tokens.issue({ roomId: "room-1", member: rooms.listMembers("room-1")[1]!, now: 10 }).token;
  const token2 = tokens.issue({ roomId: "room-2", member: rooms.listMembers("room-2")[0]!, now: 10 }).token;
  const hub = new RoomStreamHub({ rooms, tokens, ledger, now: () => 20 });
  return { rooms, ledger, tokens, hub, token1, token2 };
}

function event(roomId: string, eventId: string, seqExpected: number) {
  return {
    eventId,
    roomId,
    type: "human.message" as const,
    actor: { memberId: roomId === "room-1" ? "member-host" : "member-host", principalId: roomId === "room-1" ? "host" : "other-host" },
    createdAt: 20,
    payload: { seqExpected },
  };
}

describe("RoomStreamHub", () => {
  it("replays by cursor and fans out live events only within the same room", () => {
    const { hub, ledger, token1, token2 } = setup();
    ledger.append(event("room-1", "event-1", 1));
    const framesA: StreamFrame[] = [];
    const framesB: StreamFrame[] = [];
    hub.connect({ connectionId: "connection-a", roomId: "room-1", token: token1, afterSeq: 0, onFrame: (frame) => framesA.push(frame) });
    hub.connect({ connectionId: "connection-b", roomId: "room-2", token: token2, afterSeq: 0, onFrame: (frame) => framesB.push(frame) });

    expect(framesA).toEqual([
      expect.objectContaining({ kind: "connected", lastEventSeq: 0 }),
      expect.objectContaining({ kind: "event", event: expect.objectContaining({ eventId: "event-1", seq: 1 }) }),
      expect.objectContaining({ kind: "presence", onlineMemberCount: 1 }),
    ]);
    ledger.append(event("room-1", "event-2", 2));

    expect(framesA.at(-1)).toMatchObject({ kind: "event", event: { eventId: "event-2", seq: 2 } });
    expect(framesB).toHaveLength(2);
    expect(framesB[0]).toMatchObject({ kind: "connected", lastEventSeq: 0 });
    expect(framesB[1]).toMatchObject({ kind: "presence", onlineMemberCount: 1 });
  });

  it("sends heartbeat frames and closes a connection when membership is revoked", () => {
    const { hub, rooms, token1 } = setup();
    const frames: StreamFrame[] = [];
    hub.connect({ connectionId: "connection-a", roomId: "room-1", token: token1, onFrame: (frame) => frames.push(frame) });

    expect(hub.heartbeat("connection-a")).toMatchObject({ connectionId: "connection-a", serverTime: 20 });
    expect(frames.at(-1)).toMatchObject({ kind: "heartbeat", serverTime: 20 });

    rooms.setMemberStatus("room-1", "member-alice", "suspended", 21);
    expect(() => hub.heartbeat("connection-a")).toThrowError(expect.objectContaining({ code: "MEMBER_INACTIVE" }));
    expect(frames.at(-1)).toMatchObject({ kind: "closed", reason: "member_inactive" });
    expect(() => hub.heartbeat("connection-a")).toThrowError(expect.objectContaining({ code: "CONNECTION_NOT_FOUND" }));
  });

  it("rejects duplicate connection ids and cross-room tokens", () => {
    const { hub, token1 } = setup();
    hub.connect({ connectionId: "connection-a", roomId: "room-1", token: token1, onFrame: () => {} });

    expect(() => hub.connect({ connectionId: "connection-a", roomId: "room-1", token: token1, onFrame: () => {} }))
      .toThrowError(expect.objectContaining({ code: "CONNECTION_EXISTS" }));
    expect(() => hub.connect({ connectionId: "connection-b", roomId: "room-2", token: token1, onFrame: () => {} }))
      .toThrowError(expect.objectContaining({ code: "TOKEN_SCOPE" }));
  });

  it("broadcasts the number of distinct online members when connections change", () => {
    const { hub, rooms, tokens, token1 } = setup();
    const hostToken = tokens.issue({ roomId: "room-1", member: rooms.listMembers("room-1")[0]!, now: 10 }).token;
    const aliceFrames: StreamFrame[] = [];
    const aliceSecondTabFrames: StreamFrame[] = [];
    const hostFrames: StreamFrame[] = [];

    const alice = hub.connect({ connectionId: "alice-a", roomId: "room-1", token: token1, onFrame: (frame) => aliceFrames.push(frame) });
    const aliceSecondTab = hub.connect({ connectionId: "alice-b", roomId: "room-1", token: token1, onFrame: (frame) => aliceSecondTabFrames.push(frame) });
    const host = hub.connect({ connectionId: "host-a", roomId: "room-1", token: hostToken, onFrame: (frame) => hostFrames.push(frame) });

    expect(aliceFrames.at(-1)).toMatchObject({ kind: "presence", roomId: "room-1", onlineMemberCount: 2 });
    expect(aliceSecondTabFrames.at(-1)).toMatchObject({ kind: "presence", onlineMemberCount: 2 });
    expect(hostFrames.at(-1)).toMatchObject({ kind: "presence", onlineMemberCount: 2 });

    host.close();
    expect(aliceFrames.at(-1)).toMatchObject({ kind: "presence", onlineMemberCount: 1 });
    aliceSecondTab.close();
    alice.close();
  });
});
