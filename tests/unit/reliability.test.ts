import { describe, expect, it } from "vitest";
import { CollabGateway } from "../../src/gateway.js";
import { EventLedger } from "../../src/events.js";
import { InviteStore } from "../../src/invites.js";
import { RoomStore } from "../../src/room.js";
import { RoomTokenStore } from "../../src/tokens.js";
import { RoomStreamHub } from "../../src/stream.js";
import { EventCursor, RoomClient } from "../../src/room-client.js";
import type { GatewayRequest, HostAgentPort, RoomEvent } from "../../src/types.js";

function setupGateway() {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1",
    hostId: "host",
    hostSessionId: "session-host",
    title: "Release",
    hostDisplayName: "Host",
    now: 1,
  });
  const ledger = new EventLedger();
  const calls: string[] = [];
  const agent: HostAgentPort = {
    followup(input) {
      calls.push(input.requestId);
    },
    steer() {},
    cancel() {},
  };
  const invites = new InviteStore(rooms, { tokenFactory: () => "invite-token" });
  return { gateway: new CollabGateway({ rooms, ledger, invites, agent, now: () => 10 }), calls };
}

async function joinBob(gateway: CollabGateway) {
  const created = await gateway.handle({
    method: "POST",
    path: "/v1/rooms/room-1/invites",
    auth: { principalId: "host" },
    body: { inviteId: "invite-1", expiresAt: 100 },
  });
  return gateway.handle({
    method: "POST",
    path: "/v1/rooms/room-1/join",
    auth: { principalId: "bob" },
    body: { inviteId: "invite-1", token: (created.body as { token: string }).token, memberId: "member-bob", displayName: "Bob", resumeCredential: "bob-resume" },
  });
}

function bearer(token: string) {
  return { authorization: "Bearer " + token };
}

function event(seq: number, eventId = "event-" + seq): RoomEvent {
  return {
    eventId,
    roomId: "room-1",
    seq,
    type: "human.message",
    actor: { memberId: "member-host", principalId: "host" },
    createdAt: seq,
    payload: { seq },
  };
}

describe("P1 idempotency and cursor compensation", () => {
  it("deduplicates clientMessageId and rejects reuse with different data", async () => {
    const { gateway } = setupGateway();
    const joined = await joinBob(gateway);
    const token = (joined.body as { roomToken: string }).roomToken;
    const input: GatewayRequest = {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: bearer(token),
      body: { clientMessageId: "client-1", text: "hello" },
    };

    const first = await gateway.handle(input);
    const retry = await gateway.handle(input);
    expect(retry).toEqual(first);

    const conflict = await gateway.handle({
      ...input,
      body: { clientMessageId: "client-1", text: "tampered" },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: "REQUEST_CONFLICT" } });
    const events = await gateway.handle({
      method: "GET",
      path: "/v1/rooms/room-1/events?after=0",
      headers: bearer(token),
    });
    expect((events.body as { events: RoomEvent[] }).events.filter((event) => event.type === "human.message")).toHaveLength(1);
  });

  it("keeps transport clientMessageId separate from Agent messageId and requestId", async () => {
    const { gateway, calls } = setupGateway();
    const joined = await joinBob(gateway);
    const token = (joined.body as { roomToken: string }).roomToken;
    const request = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: bearer(token),
      body: { clientMessageId: "client-agent", text: "run tests", target: "dsh" },
    });
    const record = (request.body as { request: { requestId: string; message: { messageId: string } } }).request;
    expect(request.status).toBe(202);
    expect(record.requestId).not.toBe(record.message.messageId);
    expect(record.requestId).toContain("client-agent");

    const retry = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: bearer(token),
      body: { clientMessageId: "client-agent", text: "run tests", target: "dsh" },
    });
    expect(retry).toEqual(request);
    expect(gateway.dispatcher.queued()).toHaveLength(0);
    expect(calls).toEqual([record.requestId]);
  });

  it("buffers an event gap and drains it once the missing cursor arrives", () => {
    const cursor = new EventCursor();

    expect(cursor.apply(event(2))).toBe("gap");
    expect(cursor.lastEventSeq).toBe(0);
    expect(cursor.apply(event(1))).toBe("applied");
    expect(cursor.lastEventSeq).toBe(2);
    expect(cursor.events.map((item) => item.seq)).toEqual([1, 2]);
    expect(cursor.apply(event(2))).toBe("duplicate");
  });

  it("reconnects a RoomClient from its last confirmed cursor without replaying duplicates", async () => {
    const rooms = new RoomStore();
    rooms.createRoom({
      roomId: "room-1",
      hostId: "host",
      hostSessionId: "session-host",
      title: "Release",
      hostDisplayName: "Host",
      now: 1,
    });
    const ledger = new EventLedger();
    const tokens = new RoomTokenStore(rooms, { tokenFactory: (() => {
      let count = 0;
      return () => "token-" + (++count);
    })() });
    const token = tokens.issue({ roomId: "room-1", member: rooms.listMembers("room-1")[0]!, now: 10 }).token;
    const hub = new RoomStreamHub({ rooms, tokens, ledger, now: () => 20 });
    const client = new RoomClient({ connectionId: "client-1", roomId: "room-1", token, hub });

    ledger.append(event(1));
    await ledger.commit();
    client.connect();
    expect(client.lastEventSeq).toBe(1);
    client.close();
    ledger.append(event(2));
    await ledger.commit();
    client.connect();

    expect(client.lastEventSeq).toBe(2);
    expect(client.events.map((item) => item.eventId)).toEqual(["event-1", "event-2"]);
  });
});
