import { describe, expect, it } from "vitest";
import { CollabGateway } from "../../src/gateway.js";
import { EventLedger } from "../../src/events.js";
import { InviteStore } from "../../src/invites.js";
import { RoomClient } from "../../src/room-client.js";
import { RoomStore } from "../../src/room.js";
import { RoomStreamHub } from "../../src/stream.js";
import type { GatewayResponse, HostAgentPort, RoomEvent } from "../../src/types.js";

function body<T>(response: GatewayResponse): T {
  return response.body as T;
}

describe("P1 two-participant collaboration flow", () => {
  it("shares one Host session, fans out messages/output, and recovers after reconnect", async () => {
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
    const inviteTokens = ["invite-alice", "invite-bob"];
    const roomTokens = ["room-alice", "room-bob"];
    let gateway!: CollabGateway;
    const agent: HostAgentPort = {
      followup(input) {
        ledger.append({
          eventId: input.requestId + ":output",
          roomId: input.roomId,
          type: "agent.state.changed",
          actor: { memberId: "member-host", principalId: "host" },
          createdAt: 20,
          payload: { state: "output", text: "Host Agent completed the request", hostSessionId: input.hostSessionId },
        });
      },
      steer() {},
      cancel() {},
    };
    const invites = new InviteStore(rooms, { tokenFactory: () => inviteTokens.shift() ?? "invite-fallback" });
    gateway = new CollabGateway({
      rooms,
      ledger,
      invites,
      agent,
      tokenFactory: () => roomTokens.shift() ?? "room-fallback",
      now: () => 20,
    });
    const hub = new RoomStreamHub({ rooms, tokens: gateway.tokens, ledger, now: () => 20 });

    const inviteAlice = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/invites",
      auth: { principalId: "host" },
      body: { inviteId: "invite-alice", expiresAt: 100 },
    });
    const inviteBob = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/invites",
      auth: { principalId: "host" },
      body: { inviteId: "invite-bob", expiresAt: 100 },
    });
    const joinedAlice = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/join",
      auth: { principalId: "alice" },
      body: { inviteId: "invite-alice", token: body<{ token: string }>(inviteAlice).token, memberId: "member-alice", displayName: "Alice" },
    });
    const joinedBob = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/join",
      auth: { principalId: "bob" },
      body: { inviteId: "invite-bob", token: body<{ token: string }>(inviteBob).token, memberId: "member-bob", displayName: "Bob" },
    });
    const alice = new RoomClient({ connectionId: "connection-alice", roomId: "room-1", token: body<{ roomToken: string }>(joinedAlice).roomToken, hub });
    const bob = new RoomClient({ connectionId: "connection-bob", roomId: "room-1", token: body<{ roomToken: string }>(joinedBob).roomToken, hub });
    alice.connect();
    bob.connect();

    const human = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: { authorization: "Bearer " + body<{ roomToken: string }>(joinedAlice).roomToken },
      body: { clientMessageId: "client-human", text: "Alice asks Bob a question" },
    });
    expect(human.status).toBe(201);
    expect(alice.events).toEqual(bob.events);
    expect(alice.events).toContainEqual(expect.objectContaining({ type: "human.message" }));

    const agentRequest = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: { authorization: "Bearer " + body<{ roomToken: string }>(joinedBob).roomToken },
      body: { clientMessageId: "client-agent", text: "Run the release tests", target: "dsh" },
    });
    expect(agentRequest.status).toBe(202);
    const requestId = body<{ request: { requestId: string } }>(agentRequest).request.requestId;
    await gateway.dispatcher.drainOne();
    await gateway.dispatcher.complete(requestId);

    expect(alice.events).toEqual(bob.events);
    expect(alice.events).toContainEqual(expect.objectContaining({
      type: "agent.state.changed",
      payload: expect.objectContaining({ state: "output", hostSessionId: "session-host" }),
    }));

    const beforeDisconnect = alice.lastEventSeq;
    alice.close();
    const later = await gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: { authorization: "Bearer " + body<{ roomToken: string }>(joinedBob).roomToken },
      body: { clientMessageId: "client-later", text: "Bob sends this while Alice reconnects" },
    });
    expect(later.status).toBe(201);
    expect(alice.lastEventSeq).toBe(beforeDisconnect);
    alice.connect();

    expect(alice.lastEventSeq).toBe(bob.lastEventSeq);
    expect(alice.events).toEqual(bob.events);
    expect(alice.events.filter((event: RoomEvent) => event.type === "human.message")).toHaveLength(2);
  });
});
