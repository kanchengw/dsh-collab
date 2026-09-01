import { describe, expect, it } from "vitest";
import { CollabGateway } from "../../src/gateway.js";
import { EventLedger } from "../../src/events.js";
import { InviteStore } from "../../src/invites.js";
import { ResourceLimiter } from "../../src/limits.js";
import { RoomStore } from "../../src/room.js";
import { RoomStreamHub } from "../../src/stream.js";
import type { HostAgentPort } from "../../src/types.js";

function setup(limits: ResourceLimiter, tokenFactory: () => string = () => "room-token") {
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Release", hostDisplayName: "Host", now: 1 });
  const ledger = new EventLedger();
  const invites = new InviteStore(rooms, { tokenFactory: () => "invite-token" });
  const agent: HostAgentPort = { followup() {}, steer() {}, cancel() {}, whenIdle: () => new Promise(() => {}) };
  const gateway = new CollabGateway({ rooms, ledger, invites, agent, tokenFactory, now: () => 10, limits });
  return { gateway, ledger, rooms };
}

async function joinParticipant(gateway: CollabGateway, inviteId: string, principalId: string, memberId: string, roomId = "room-1"): Promise<string> {
  const invite = await gateway.handle({ method: "POST", path: `/v1/rooms/${roomId}/invites`, auth: { principalId: "host" }, body: { inviteId, expiresAt: 100 } });
  const accepted = await gateway.handle({ method: "POST", path: `/v1/rooms/${roomId}/join`, auth: { principalId }, body: { inviteId, token: (invite.body as { token: string }).token, memberId, displayName: principalId, resumeCredential: `${memberId}-resume` } });
  return (accepted.body as { roomToken: string }).roomToken;
}

describe("resource limits at transport/domain boundaries", () => {
  it("limits repeated messages per member", async () => {
    const { gateway } = setup(new ResourceLimiter({ maxMessagesPerMemberPerWindow: 1, messageWindowMs: 100 }));
    const token = await joinParticipant(gateway, "invite-message", "bob", "member-bob");
    const first = await gateway.handle({ method: "POST", path: "/v1/rooms/room-1/messages", headers: { authorization: `Bearer ${token}` }, body: { clientMessageId: "human-1", text: "hello" } });
    const second = await gateway.handle({ method: "POST", path: "/v1/rooms/room-1/messages", headers: { authorization: `Bearer ${token}` }, body: { clientMessageId: "human-2", text: "again" } });
    expect(first.status).toBe(201);
    expect(second.status).toBe(429);
  });

  it("limits queued Agent requests per room", async () => {
    const { gateway } = setup(new ResourceLimiter({ maxQueuedRequestsPerRoom: 1 }));
    const token = await joinParticipant(gateway, "invite-queue", "bob", "member-bob");
    const first = await gateway.handle({ method: "POST", path: "/v1/rooms/room-1/messages", headers: { authorization: `Bearer ${token}` }, body: { clientMessageId: "agent-1", text: "first", target: "dsh" } });
    const second = await gateway.handle({ method: "POST", path: "/v1/rooms/room-1/messages", headers: { authorization: `Bearer ${token}` }, body: { clientMessageId: "agent-2", text: "second", target: "dsh" } });
    const third = await gateway.handle({ method: "POST", path: "/v1/rooms/room-1/messages", headers: { authorization: `Bearer ${token}` }, body: { clientMessageId: "agent-3", text: "third", target: "dsh" } });
    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    expect(third.status).toBe(429);
    expect(gateway.dispatcher.queued()).toHaveLength(1);
  });

  it("does not apply one room's queued-request limit to another room", async () => {
    let tokenSequence = 0;
    const { gateway, rooms } = setup(new ResourceLimiter({ maxQueuedRequestsPerRoom: 1 }), () => `room-token-${String(++tokenSequence)}`);
    rooms.createRoom({ roomId: "room-2", hostId: "host", hostSessionId: "session-host", title: "Other", hostDisplayName: "Host", now: 2 });
    const room1Token = ((await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } })).body as { roomToken: string }).roomToken;
    const room2Token = ((await gateway.handle({ method: "GET", path: "/v1/rooms/room-2/bootstrap", auth: { principalId: "host" } })).body as { roomToken: string }).roomToken;
    const send = (roomId: string, token: string, clientMessageId: string) => gateway.handle({
      method: "POST",
      path: `/v1/rooms/${roomId}/messages`,
      headers: { authorization: `Bearer ${token}` },
      body: { clientMessageId, text: clientMessageId, target: "dsh" },
    });

    const active = await send("room-1", room1Token, "room-1-active");
    expect(active, JSON.stringify(active.body)).toMatchObject({ status: 202 });
    const queued = await send("room-1", room1Token, "room-1-queued");
    expect(queued, JSON.stringify(queued.body)).toMatchObject({ status: 202 });
    expect((await send("room-2", room2Token, "room-2-queued")).status).toBe(202);
    expect(gateway.dispatcher.queued().map((record) => record.roomId)).toEqual(["room-1", "room-2"]);
  });

  it("limits concurrent stream connections", async () => {
    const limits = new ResourceLimiter({ maxConnectionsPerRoom: 1 });
    const { gateway, ledger, rooms } = setup(limits);
    const token = await joinParticipant(gateway, "invite-stream", "bob", "member-bob");
    const hub = new RoomStreamHub({ rooms, tokens: gateway.tokens, ledger, limits, now: () => 10 });
    const first = hub.connect({ connectionId: "conn-1", roomId: "room-1", token, onFrame: () => {} });
    expect(() => hub.connect({ connectionId: "conn-2", roomId: "room-1", token, onFrame: () => {} })).toThrow("connection resource limit");
    first.close();
    expect(() => hub.connect({ connectionId: "conn-3", roomId: "room-1", token, onFrame: () => {} })).not.toThrow();
    hub.dispose();
  });
});
