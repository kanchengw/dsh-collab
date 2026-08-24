import { describe, expect, it, vi } from "vitest";
import { CollabGateway } from "../../src/gateway.js";
import { EventLedger } from "../../src/events.js";
import { InviteStore } from "../../src/invites.js";
import { ApprovalStore } from "../../src/approvals.js";
import { RoomStore } from "../../src/room.js";
import type { GatewayRequest, HostAgentPort } from "../../src/types.js";

function setup(agentOverride?: HostAgentPort, withApprovals = false) {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1",
    hostId: "host",
    hostSessionId: "session-host",
    title: "Release",
    hostDisplayName: "Host",
    now: 1,
  });
  rooms.createRoom({
    roomId: "room-2",
    hostId: "other-host",
    hostSessionId: "session-other-host",
    title: "Other",
    hostDisplayName: "Other Host",
    now: 1,
  });
  rooms.addMember("room-1", {
    memberId: "member-alice",
    principalId: "alice",
    displayName: "Alice",
    now: 2,
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
  const approvals = withApprovals ? new ApprovalStore({ rooms, ledger, answerer: {} }) : undefined;
  const gateway = new CollabGateway({ rooms, ledger, invites, agent: agentOverride ?? agent, now: () => 10, approvals });
  return { gateway, calls, rooms, ledger };
}

async function request(gateway: CollabGateway, input: GatewayRequest) {
  return gateway.handle(input);
}

function bearer(token: string) {
  return { authorization: "Bearer " + token };
}

describe("CollabGateway route contract", () => {
  it("creates an invite for the Host and returns a structured forbidden error for a Participant", async () => {
    const { gateway } = setup();

    const created = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/invites",
      auth: { principalId: "host" },
      body: { inviteId: "invite-1", expiresAt: 100 },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ invite: { inviteId: "invite-1" }, token: "invite-token" });

    const forbidden = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/invites",
      auth: { principalId: "alice" },
      body: { inviteId: "invite-2", expiresAt: 100 },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ error: { code: "ACTION_FORBIDDEN" } });
  });

  it("joins with an invite, issues a room-scoped token, and serves snapshot/events", async () => {
    const { gateway, calls } = setup();
    const created = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/invites",
      auth: { principalId: "host" },
      body: { inviteId: "invite-1", expiresAt: 100 },
    });
    const inviteToken = (created.body as { token: string }).token;
    const joined = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/join",
      auth: { principalId: "bob" },
      body: { inviteId: "invite-1", token: inviteToken, memberId: "member-bob", displayName: "Bob" },
    });
    expect(joined.status).toBe(201);
    expect(joined.body).toMatchObject({ room: { roomId: "room-1" }, member: { principalId: "bob", role: "participant" } });
    const roomToken = (joined.body as { roomToken: string }).roomToken;

    const snapshot = await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/snapshot",
      headers: bearer(roomToken),
    });
    expect(snapshot.status).toBe(200);
    expect(snapshot.body).toMatchObject({ room: { roomId: "room-1" }, members: expect.any(Array), lastEventSeq: 1 });

    const human = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: bearer(roomToken),
      body: { messageId: "message-1", text: "hello everyone" },
    });
    expect(human.status).toBe(201);
    expect(calls).toEqual([]);

    const events = await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/events?after=0&limit=10",
      headers: bearer(roomToken),
    });
    expect(events.status).toBe(200);
    expect(events.body).toMatchObject({ events: [
      expect.objectContaining({ type: "member.joined", seq: 1 }),
      expect.objectContaining({ type: "human.message", seq: 2 }),
    ] });
  });

  it("bootstraps the authenticated Host into a room-scoped browser token", async () => {
    const { gateway } = setup(undefined, true);
    const response = await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/bootstrap",
      auth: { principalId: "host" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ member: { memberId: "member-host", role: "host" }, roomToken: expect.any(String) });
  });

  it("preserves a Participant role when an authenticated member bootstraps", async () => {
    const { gateway } = setup();
    const response = await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/bootstrap",
      auth: { principalId: "alice" },
    });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ member: { memberId: "member-alice", role: "participant" } });
  });

  it("routes an explicit DSH request through the one Host dispatcher", async () => {
    const { gateway, calls } = setup();
    const created = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/invites",
      auth: { principalId: "host" },
      body: { inviteId: "invite-1", expiresAt: 100 },
    });
    const joined = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/join",
      auth: { principalId: "bob" },
      body: { inviteId: "invite-1", token: (created.body as { token: string }).token, memberId: "member-bob", displayName: "Bob" },
    });
    const roomToken = (joined.body as { roomToken: string }).roomToken;

    const agentRequest = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: bearer(roomToken),
      body: { messageId: "message-agent", text: "run tests", target: "dsh" },
    });
    expect(agentRequest.status).toBe(202);
    await vi.waitFor(() => {
      expect(calls).toEqual(["message-agent"]);
      expect(gateway.dispatcher.get("message-agent")).toMatchObject({ status: "completed" });
    });
  });

  it("waits for the active DSH turn before dispatching the next request", async () => {
    const calls: string[] = [];
    const idleWaiters: Array<() => void> = [];
    const agent = {
      followup(input: { requestId: string }) { calls.push(input.requestId); },
      steer() {},
      cancel() {},
      whenIdle() { return new Promise<void>((resolve) => idleWaiters.push(resolve)); },
    };
    const { gateway } = setup(agent);
    const bootstrapped = await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/bootstrap",
      auth: { principalId: "host" },
    });
    const roomToken = (bootstrapped.body as { roomToken: string }).roomToken;

    await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: bearer(roomToken),
      body: { messageId: "message-first", text: "first", target: "dsh" },
    });
    await vi.waitFor(() => expect(calls).toEqual(["message-first"]));
    await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: bearer(roomToken),
      body: { messageId: "message-second", text: "second", target: "dsh" },
    });
    expect(calls).toEqual(["message-first"]);

    idleWaiters.shift()?.();
    await vi.waitFor(() => expect(calls).toEqual(["message-first", "message-second"]));
    expect(gateway.dispatcher.get("message-first")).toMatchObject({ status: "completed" });

    idleWaiters.shift()?.();
    await vi.waitFor(() => expect(gateway.dispatcher.get("message-second")).toMatchObject({ status: "completed" }));
  });

  it("rejects missing, invalid, and cross-room credentials with stable errors", async () => {
    const { gateway } = setup();

    const missing = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/snapshot" });
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ error: { code: "AUTH_REQUIRED", message: expect.any(String) } });

    const missingPrincipal = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/invites",
      body: { inviteId: "invite-missing-auth", expiresAt: 100 },
    });
    expect(missingPrincipal.status).toBe(401);
    expect(missingPrincipal.body).toMatchObject({ error: { code: "AUTH_REQUIRED" } });

    const invalid = await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/snapshot",
      headers: bearer("bad-token"),
    });
    expect(invalid.status).toBe(401);
    expect(invalid.body).toMatchObject({ error: { code: "AUTH_INVALID" } });

    const created = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/invites",
      auth: { principalId: "host" },
      body: { inviteId: "invite-1", expiresAt: 100 },
    });
    const joined = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/join",
      auth: { principalId: "bob" },
      body: { inviteId: "invite-1", token: (created.body as { token: string }).token, memberId: "member-bob", displayName: "Bob" },
    });
    const crossRoom = await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-2/snapshot",
      headers: bearer((joined.body as { roomToken: string }).roomToken),
    });
    expect(crossRoom.status).toBe(403);
    expect(crossRoom.body).toMatchObject({ error: { code: "TOKEN_SCOPE" } });
  });

  it("exposes Host-only actions, member management and approval decisions", async () => {
    const { gateway } = setup(undefined, true);
    const bootstrapped = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const hostToken = (bootstrapped.body as { roomToken: string }).roomToken;
    const participantBootstrap = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "alice" } });
    const participantToken = (participantBootstrap.body as { roomToken: string }).roomToken;

    const submitted = await gateway.dispatcher.submit({
      principalId: "host",
      message: { kind: "agent-request", messageId: "message-cancel", requestId: "request-cancel", roomId: "room-1", authorMemberId: "member-host", text: "cancel me", target: "dsh", deliveryMode: "followup" },
    });
    expect(submitted.status).toBe("queued");
    const cancelled = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/actions",
      headers: bearer(hostToken),
      body: { action: "cancel", requestId: "request-cancel", keepInbox: true },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ request: { status: "cancelled" } });

    const forbidden = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/actions",
      headers: bearer(participantToken),
      body: { action: "setMemberStatus", memberId: "member-alice", status: "suspended" },
    });
    expect(forbidden.status).toBe(403);
    expect(forbidden.body).toMatchObject({ error: { code: "ACTION_FORBIDDEN" } });

    const suspended = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/actions",
      headers: bearer(hostToken),
      body: { action: "setMemberStatus", memberId: "member-alice", status: "suspended" },
    });
    expect(suspended.status).toBe(200);
    expect(suspended.body).toMatchObject({ member: { memberId: "member-alice", status: "suspended" } });

    const approval = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/approvals",
      headers: bearer(hostToken),
      body: { approvalId: "approval-1", toolName: "shell", reason: "run tests", expiresAt: 100 },
    });
    expect(approval.status).toBe(201);
    expect(approval.body).toMatchObject({ approval: { approvalId: "approval-1", state: "pending" } });
    const decided = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/actions",
      headers: bearer(hostToken),
      body: { action: "decideApproval", approvalId: "approval-1", outcome: "allowed-once" },
    });
    expect(decided.status).toBe(200);
    expect(decided.body).toMatchObject({ approval: { approvalId: "approval-1", state: "decided", outcome: "allowed-once" } });

  });
});
