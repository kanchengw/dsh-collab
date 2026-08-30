import { describe, expect, it } from "vitest";
import { EventLedger } from "../../src/events.js";
import { RoomStore } from "../../src/room.js";
import { RoomTokenStore } from "../../src/tokens.js";
import { RoomStreamHub } from "../../src/stream.js";
import { CHANGE_SET_CAPABILITY, SIDECAR_REVIEW_CAPABILITY, type CollaborationEvent } from "../../src/collaboration-types.js";
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

  it("replays every event when the connection gap exceeds one ledger page", () => {
    const { hub, ledger, token1 } = setup();
    for (let seq = 1; seq <= 501; seq += 1) ledger.append(event("room-1", `event-${String(seq)}`, seq));
    const frames: StreamFrame[] = [];

    hub.connect({ connectionId: "connection-a", roomId: "room-1", token: token1, afterSeq: 0, onFrame: (frame) => frames.push(frame) });

    const replayed = frames.filter((frame): frame is Extract<StreamFrame, { kind: "event" }> => frame.kind === "event");
    expect(replayed).toHaveLength(501);
    expect(replayed.at(-1)?.event.seq).toBe(501);
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

  it("broadcasts transient Agent output and replays only its latest snapshot", () => {
    const { hub, ledger, token1 } = setup();
    const firstFrames: StreamFrame[] = [];
    const secondFrames: StreamFrame[] = [];
    const legacyFrames: StreamFrame[] = [];
    hub.connect({ connectionId: "connection-a", roomId: "room-1", token: token1, agentOutput: true, onFrame: (frame) => firstFrames.push(frame) });
    hub.connect({ connectionId: "connection-legacy", roomId: "room-1", token: token1, onFrame: (frame) => legacyFrames.push(frame) });

    hub.publishAgentOutput({ roomId: "room-1", requestId: "request-1", text: "Hel", streaming: true });
    hub.publishAgentOutput({ roomId: "room-1", requestId: "request-1", text: "Hello", streaming: true });
    hub.connect({ connectionId: "connection-b", roomId: "room-1", token: token1, agentOutput: true, onFrame: (frame) => secondFrames.push(frame) });

    expect(firstFrames.filter((frame) => frame.kind === "agent-output")).toEqual([
      { kind: "agent-output", roomId: "room-1", requestId: "request-1", text: "Hel", streaming: true },
      { kind: "agent-output", roomId: "room-1", requestId: "request-1", text: "Hello", streaming: true },
    ]);
    expect(secondFrames).toContainEqual({ kind: "agent-output", roomId: "room-1", requestId: "request-1", text: "Hello", streaming: true });
    expect(legacyFrames.some((frame) => frame.kind === "agent-output")).toBe(false);

    ledger.append({
      eventId: "request-1:output",
      roomId: "room-1",
      type: "agent.state.changed",
      actor: { memberId: "member-host", principalId: "host" },
      createdAt: 21,
      payload: { requestId: "request-1", state: "output", text: "Hello" },
    });
    const thirdFrames: StreamFrame[] = [];
    hub.connect({ connectionId: "connection-c", roomId: "room-1", token: token1, agentOutput: true, onFrame: (frame) => thirdFrames.push(frame) });
    expect(thirdFrames.some((frame) => frame.kind === "agent-output")).toBe(false);
  });

  it("does not replay transient Agent output after a terminal frame or event", () => {
    const { hub, ledger, token1 } = setup();
    hub.publishAgentOutput({ roomId: "room-1", requestId: "request-finished", text: "done", streaming: false });
    hub.publishAgentOutput({ roomId: "room-1", requestId: "request-completed", text: "partial", streaming: true });
    hub.publishAgentOutput({ roomId: "room-1", requestId: "request-rejected", text: "partial", streaming: true });
    ledger.append({
      eventId: "request-completed:completed",
      roomId: "room-1",
      type: "agent.request.completed",
      actor: { memberId: "member-host", principalId: "host" },
      createdAt: 21,
      payload: { requestId: "request-completed" },
    });
    ledger.append({
      eventId: "request-rejected:rejected",
      roomId: "room-1",
      type: "agent.request.rejected",
      actor: { memberId: "member-host", principalId: "host" },
      createdAt: 22,
      payload: { requestId: "request-rejected" },
    });
    const frames: StreamFrame[] = [];

    hub.connect({ connectionId: "connection-a", roomId: "room-1", token: token1, agentOutput: true, onFrame: (frame) => frames.push(frame) });

    expect(frames.some((frame) => frame.kind === "agent-output")).toBe(false);
  });

  it("sends collaboration events only to clients that declared the capability", () => {
    const { hub, token1 } = setup();
    const event: CollaborationEvent = {
      type: "workspace-sharing.changed",
      state: { roomId: "room-1", enabled: false, revision: 2 },
    };
    const legacyEvents: CollaborationEvent[] = [];
    const capableEvents: CollaborationEvent[] = [];

    hub.connect({
      connectionId: "legacy",
      roomId: "room-1",
      token: token1,
      onFrame: () => {},
      onCollaborationEvent: (value) => legacyEvents.push(value),
    });
    hub.connect({
      connectionId: "capable",
      roomId: "room-1",
      token: token1,
      capabilities: [SIDECAR_REVIEW_CAPABILITY],
      onFrame: () => {},
      onCollaborationEvent: (value) => capableEvents.push(value),
    });

    hub.publishCollaborationEvent(event);

    expect(legacyEvents).toEqual([]);
    expect(capableEvents).toEqual([event]);
  });

  it("sends ChangeSet Review notifications only to change-set clients without advancing the room cursor", () => {
    const { hub, ledger, token1 } = setup();
    const event = {
      type: "changeset.review-assigned",
      roomId: "room-1",
      assignment: {
        assignmentId: "b".repeat(64),
        changeSetId: "a".repeat(64),
        assignedBy: "member-author",
        reviewerId: "member-reviewer",
        createdAt: 10,
      },
    } as CollaborationEvent;
    const legacyEvents: CollaborationEvent[] = [];
    const sidecarEvents: CollaborationEvent[] = [];
    const changeSetEvents: CollaborationEvent[] = [];

    hub.connect({ connectionId: "legacy-review", roomId: "room-1", token: token1, onFrame: () => {}, onCollaborationEvent: (value) => legacyEvents.push(value) });
    hub.connect({ connectionId: "sidecar-review", roomId: "room-1", token: token1, capabilities: [SIDECAR_REVIEW_CAPABILITY], onFrame: () => {}, onCollaborationEvent: (value) => sidecarEvents.push(value) });
    hub.connect({ connectionId: "changeset-review", roomId: "room-1", token: token1, capabilities: [CHANGE_SET_CAPABILITY], onFrame: () => {}, onCollaborationEvent: (value) => changeSetEvents.push(value) });

    hub.publishCollaborationEvent(event);

    expect(legacyEvents).toEqual([]);
    expect(sidecarEvents).toEqual([]);
    expect(changeSetEvents).toEqual([event]);
    expect(ledger.latestSeq("room-1")).toBe(0);
  });
});
