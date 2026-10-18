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

  it("rejects retired Agent requests before queue limits", async () => {
    const { gateway } = setup(new ResourceLimiter({ maxQueuedRequestsPerRoom: 1 }));
    const token = await joinParticipant(gateway, "invite-queue", "bob", "member-bob");
    for (const clientMessageId of ["agent-1", "agent-2", "agent-3"]) {
      await expect(gateway.handle({ method: "POST", path: "/v1/rooms/room-1/messages", headers: { authorization: `Bearer ${token}` }, body: { clientMessageId, text: clientMessageId, target: "dsh" } }))
        .resolves.toMatchObject({ status: 422, body: { error: { code: "INVALID_INPUT" } } });
    }
    expect(gateway.dispatcher.queued()).toHaveLength(0);
  });

  it("does not create retired Agent requests in any room", async () => {
    let tokenSequence = 0;
    const { gateway, rooms } = setup(new ResourceLimiter({ maxQueuedRequestsPerRoom: 1 }), () => `room-token-${String(++tokenSequence)}`);
    rooms.createRoom({ roomId: "room-2", hostId: "host", hostSessionId: "session-host", title: "Other", hostDisplayName: "Host", now: 2 });
    const room1Token = ((await gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } })).body as { roomToken: string }).roomToken;
    const room2Token = ((await gateway.handle({ method: "GET", path: "/v1/rooms/room-2/bootstrap", auth: { principalId: "host" } })).body as { roomToken: string }).roomToken;
    for (const [roomId, token] of [["room-1", room1Token], ["room-2", room2Token]] as const) {
      await expect(gateway.handle({ method: "POST", path: `/v1/rooms/${roomId}/messages`, headers: { authorization: `Bearer ${token}` }, body: { clientMessageId: roomId, text: roomId, target: "dsh" } }))
        .resolves.toMatchObject({ status: 422, body: { error: { code: "INVALID_INPUT" } } });
    }
    expect(gateway.dispatcher.queued()).toHaveLength(0);
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
