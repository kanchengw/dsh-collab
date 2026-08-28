import { describe, expect, it, vi } from "vitest";
import { CollabGateway } from "../../src/gateway.js";
import { EventLedger } from "../../src/events.js";
import { InviteStore } from "../../src/invites.js";
import { ApprovalStore } from "../../src/approvals.js";
import { RoomStore } from "../../src/room.js";
import type { GatewayRequest, HostAgentPort } from "../../src/types.js";
import { ActiveRoomRegistry } from "../../src/active-rooms.js";
import { WorkspaceSharingRegistry } from "../../src/workspace-sharing.js";
import { WorkspaceService } from "../../src/workspace-service.js";
import { COLLAB_CAPABILITY_HEADER, SIDECAR_REVIEW_CAPABILITY } from "../../src/protocol.js";
import { ResourceLimiter } from "../../src/limits.js";

function setup(
  agentOverride?: HostAgentPort,
  withApprovals = false,
  commitCriticalState?: () => Promise<void>,
  limits?: ResourceLimiter,
  now: () => number = () => 10,
) {
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
  const activeRooms = new ActiveRoomRegistry();
  activeRooms.activate("room-1");
  activeRooms.activate("room-2");
  const workspaceSharing = new WorkspaceSharingRegistry();
  const workspace = new WorkspaceService({ rooms, registry: workspaceSharing, now: () => 10 });
  const gateway = new CollabGateway({
    rooms, ledger, invites, agent: agentOverride ?? agent, now, approvals,
    hostPrincipalId: "host",
    hostDisplayName: "Host",
    ownsHostSession: (sessionId) => sessionId !== "session-missing",
    activeRooms,
    workspace,
    ...(commitCriticalState ? { commitCriticalState } : {}),
    ...(limits ? { limits } : {}),
  });
  return { gateway, calls, rooms, ledger, approvals, workspaceSharing, activeRooms };
}

async function request(gateway: CollabGateway, input: GatewayRequest) {
  return gateway.handle(input);
}

function bearer(token: string) {
  return { authorization: "Bearer " + token };
}

describe("CollabGateway route contract", () => {
  it("gates Workspace Sharing routes by capability and Host role", async () => {
    const { gateway, activeRooms } = setup();
    const host = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const participant = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "alice" } });
    const capability = { [COLLAB_CAPABILITY_HEADER]: SIDECAR_REVIEW_CAPABILITY };
    const hostHeaders = { ...bearer((host.body as { roomToken: string }).roomToken), ...capability };
    const participantHeaders = { ...bearer((participant.body as { roomToken: string }).roomToken), ...capability };

    expect(await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/workspace-sharing",
      headers: bearer((host.body as { roomToken: string }).roomToken),
    })).toMatchObject({ status: 404 });
    expect(await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/workspace-sharing",
      headers: participantHeaders,
    })).toMatchObject({ status: 200, body: { state: { enabled: false, revision: 0 } } });
    expect(await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/workspace-sharing",
      headers: participantHeaders,
      body: { enabled: true },
    })).toMatchObject({ status: 403, body: { error: { code: "ACTION_FORBIDDEN" } } });
    expect(await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/workspace-sharing",
      headers: hostHeaders,
      body: { enabled: true, principalId: "alice" },
    })).toMatchObject({ status: 200, body: { state: { enabled: true, enabledBy: "member-host", revision: 1 } } });
    expect(await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/workspace-sharing",
      headers: participantHeaders,
    })).toMatchObject({ status: 200, body: { state: { enabled: true, enabledBy: "member-host" } } });

    activeRooms.deactivate("room-1");
    expect(await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/workspace-sharing",
      headers: bearer((host.body as { roomToken: string }).roomToken),
    })).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
  });
  it("shares only an owned current session and updates its Room name idempotently", async () => {
    const { gateway, rooms } = setup();

    const created = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/session-new/host",
      auth: { principalId: "host" },
      body: { hostSessionId: "session-new", title: "  Release room  " },
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      room: { roomId: "session-new", hostSessionId: "session-new", title: "Release room" },
      member: { role: "host", principalId: "host" },
      roomToken: expect.any(String),
    });

    const resumed = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/session-new/host",
      auth: { principalId: "host" },
      body: { hostSessionId: "session-new", title: "Planning room" },
    });
    expect(resumed.status).toBe(200);
    expect(rooms.getRoom("session-new")).toMatchObject({ title: "Planning room", revision: 2 });
    expect(rooms.listMembers("session-new")).toHaveLength(1);
  });

  it("rejects Participant, unowned, mismatched and invalid Host share requests", async () => {
    const { gateway } = setup();
    const send = (auth: string | undefined, roomId: string, hostSessionId: string, title: string) => request(gateway, {
      method: "POST",
      path: `/v1/rooms/${roomId}/host`,
      ...(auth ? { auth: { principalId: auth } } : {}),
      body: { hostSessionId, title },
    });

    await expect(send(undefined, "session-new", "session-new", "Room")).resolves.toMatchObject({ status: 401 });
    await expect(send("alice", "session-new", "session-new", "Room")).resolves.toMatchObject({ status: 403 });
    await expect(send("host", "session-missing", "session-missing", "Room")).resolves.toMatchObject({ status: 403 });
    await expect(send("host", "session-new", "session-other", "Room")).resolves.toMatchObject({ status: 422 });
    await expect(send("host", "session-new", "session-new", "   ")).resolves.toMatchObject({ status: 422 });
    await expect(send("host", "session-new", "session-new", "x".repeat(81))).resolves.toMatchObject({ status: 422 });
  });

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
    expect(joined.body).toMatchObject({ room: { roomId: "room-1" }, member: { principalId: "invite:invite-1", role: "participant" } });
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

  it("persists a client-owned resume credential before completing an exact Join retry", async () => {
    let persistenceFails = true;
    const commitCriticalState = vi.fn(async () => {
      if (persistenceFails) throw new Error("state write failed");
    });
    const { gateway, rooms, ledger } = setup(undefined, false, commitCriticalState, new ResourceLimiter({ maxMembersPerRoom: 3 }));
    const created = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/invites",
      auth: { principalId: "host" },
      body: { inviteId: "invite-retry", expiresAt: 100 },
    });
    const join = {
      method: "POST" as const,
      path: "/v1/rooms/room-1/join",
      body: {
        inviteId: "invite-retry",
        token: (created.body as { token: string }).token,
        memberId: "member-retry",
        displayName: "Retry User",
        resumeCredential: "client-owned-resume-secret",
      },
    };

    expect(await request(gateway, join)).toMatchObject({ status: 500, body: { error: { code: "INTERNAL_ERROR" } } });
    expect(rooms.listMembers("room-1").filter((member) => member.memberId === "member-retry")).toHaveLength(1);
    expect(ledger.readAfter("room-1", 0, 500).filter((event) => event.type === "member.joined")).toHaveLength(1);

    persistenceFails = false;
    const retried = await request(gateway, join);
    expect(retried).toMatchObject({
      status: 201,
      body: { member: { memberId: "member-retry" }, resumeCredential: "client-owned-resume-secret" },
    });
    expect(commitCriticalState).toHaveBeenCalledTimes(2);
    expect(rooms.listMembers("room-1").filter((member) => member.memberId === "member-retry")).toHaveLength(1);
    expect(ledger.readAfter("room-1", 0, 500).filter((event) => event.type === "member.joined")).toHaveLength(1);

    expect(await request(gateway, {
      ...join,
      body: { ...join.body, resumeCredential: "different-resume-secret" },
    })).toMatchObject({ status: 409, body: { error: { code: "REQUEST_CONFLICT" } } });

    const resumed = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/resume",
      body: { credential: "client-owned-resume-secret" },
    });
    expect(resumed).toMatchObject({ status: 200, body: { member: { memberId: "member-retry" } } });
  });

  it("does not let a room-scoped token act on requests or approvals from another owned room", async () => {
    const { gateway, rooms, activeRooms } = setup(undefined, true);
    rooms.createRoom({
      roomId: "room-3",
      hostId: "host",
      hostSessionId: "session-host-3",
      title: "Other owned room",
      hostDisplayName: "Host",
      now: 1,
    });
    activeRooms.activate("room-3");
    const roomOneBootstrap = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const roomThreeBootstrap = await request(gateway, { method: "GET", path: "/v1/rooms/room-3/bootstrap", auth: { principalId: "host" } });
    const roomOneToken = (roomOneBootstrap.body as { roomToken: string }).roomToken;
    const roomThreeToken = (roomThreeBootstrap.body as { roomToken: string }).roomToken;
    await gateway.dispatcher.submit({
      principalId: "host",
      message: { kind: "agent-request", messageId: "message-room-3", requestId: "request-room-3", roomId: "room-3", authorMemberId: "member-host", text: "room three", target: "dsh", deliveryMode: "followup" },
    });
    const approval = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-3/approvals",
      headers: bearer(roomThreeToken),
      body: { approvalId: "approval-room-3", toolName: "shell", reason: "room three", expiresAt: 100 },
    });
    expect(approval.status).toBe(201);

    const crossRoomCancel = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/actions",
      headers: bearer(roomOneToken),
      body: { action: "cancel", requestId: "request-room-3", keepInbox: true },
    });
    expect(crossRoomCancel.status).toBe(403);
    expect(crossRoomCancel.body).toMatchObject({ error: { code: "TOKEN_SCOPE" } });
    expect(gateway.dispatcher.get("request-room-3")).toMatchObject({ status: "queued", roomId: "room-3" });

    const crossRoomApproval = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/actions",
      headers: bearer(roomOneToken),
      body: { action: "decideApproval", approvalId: "approval-room-3", outcome: "allowed-once" },
    });
    expect(crossRoomApproval.status).toBe(403);
    expect(crossRoomApproval.body).toMatchObject({ error: { code: "TOKEN_SCOPE" } });
    const correctlyScopedDecision = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-3/actions",
      headers: bearer(roomThreeToken),
      body: { action: "decideApproval", approvalId: "approval-room-3", outcome: "allowed-once" },
    });
    expect(correctlyScopedDecision.status).toBe(200);
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

  it("reports the authoritative latest event sequence beyond one replay page", async () => {
    const { gateway, ledger } = setup();
    for (let index = 1; index <= 501; index += 1) {
      ledger.append({
        eventId: `history-${String(index)}`,
        roomId: "room-1",
        type: "human.message",
        actor: { memberId: "host", principalId: "host" },
        createdAt: index,
        payload: { text: String(index) },
      });
    }

    const bootstrapped = await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/bootstrap",
      auth: { principalId: "host" },
    });
    const snapshot = await request(gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/snapshot",
      headers: bearer((bootstrapped.body as { roomToken: string }).roomToken),
    });

    expect(snapshot.body).toMatchObject({ lastEventSeq: 501 });
  });

  it("revokes a Participant resume credential when the Host suspends that member", async () => {
    const { gateway } = setup();
    const host = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const created = await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/invites", auth: { principalId: "host" },
      body: { inviteId: "invite-bob", expiresAt: 100 },
    });
    const joined = await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/join",
      body: { inviteId: "invite-bob", token: (created.body as { token: string }).token, memberId: "member-bob", displayName: "Bob" },
    });
    const resumeCredential = (joined.body as { resumeCredential: string }).resumeCredential;

    await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/actions",
      headers: bearer((host.body as { roomToken: string }).roomToken),
      body: { action: "setMemberStatus", memberId: "member-bob", status: "suspended" },
    });
    const resumed = await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/resume", body: { credential: resumeCredential },
    });
    expect(resumed.status).toBe(401);
    expect(resumed.body).toMatchObject({ error: { code: "AUTH_INVALID" } });
  });

  it("confirms member authority changes in persistent state before reporting success", async () => {
    let persistenceFails = true;
    let clock = 10;
    let rooms: RoomStore | undefined;
    const statusAtCommit: string[] = [];
    const commitCriticalState = vi.fn(async () => {
      statusAtCommit.push(rooms?.listMembers("room-1").find((member) => member.memberId === "member-alice")?.status ?? "missing");
      if (persistenceFails) throw new Error("state write failed");
    });
    const runtime = setup(undefined, false, commitCriticalState, undefined, () => clock++);
    rooms = runtime.rooms;
    const { gateway, ledger } = runtime;
    const host = await request(gateway, {
      method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" },
    });
    const action = {
      method: "POST" as const,
      path: "/v1/rooms/room-1/actions",
      headers: bearer((host.body as { roomToken: string }).roomToken),
      body: { action: "setMemberStatus", memberId: "member-alice", status: "suspended" },
    };

    expect(await request(gateway, action)).toMatchObject({ status: 500, body: { error: { code: "INTERNAL_ERROR" } } });
    persistenceFails = false;
    expect(await request(gateway, action)).toMatchObject({ status: 200, body: { member: { status: "suspended" } } });

    expect(commitCriticalState).toHaveBeenCalledTimes(2);
    expect(statusAtCommit).toEqual(["suspended", "suspended"]);
    expect(ledger.readAfter("room-1", 0, 500).filter((event) => event.type === "member.suspended")).toHaveLength(1);
  });

  it("confirms member role changes in persistent state before reporting success", async () => {
    let persistenceFails = true;
    let clock = 10;
    let rooms: RoomStore | undefined;
    const roleAtCommit: string[] = [];
    const commitCriticalState = vi.fn(async () => {
      roleAtCommit.push(rooms?.listMembers("room-1").find((member) => member.memberId === "member-alice")?.role ?? "missing");
      if (persistenceFails) throw new Error("state write failed");
    });
    const runtime = setup(undefined, false, commitCriticalState, undefined, () => clock++);
    rooms = runtime.rooms;
    const { gateway, ledger } = runtime;
    const host = await request(gateway, {
      method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" },
    });
    const action = {
      method: "POST" as const,
      path: "/v1/rooms/room-1/actions",
      headers: bearer((host.body as { roomToken: string }).roomToken),
      body: { action: "setMemberRole", memberId: "member-alice", role: "observer" },
    };

    expect(await request(gateway, action)).toMatchObject({ status: 500, body: { error: { code: "INTERNAL_ERROR" } } });
    persistenceFails = false;
    expect(await request(gateway, action)).toMatchObject({ status: 200, body: { member: { role: "observer" } } });

    expect(commitCriticalState).toHaveBeenCalledTimes(2);
    expect(roleAtCommit).toEqual(["observer", "observer"]);
    expect(ledger.readAfter("room-1", 0, 500).filter((event) => event.type === "member.roleChanged")).toHaveLength(1);
  });

  it("confirms approval requests in persistent state before reporting success", async () => {
    let persistenceFails = true;
    let approvals: ApprovalStore | undefined;
    const stateAtCommit: string[] = [];
    const commitCriticalState = vi.fn(async () => {
      stateAtCommit.push(approvals?.snapshot().records.find((record) => record.approvalId === "approval-persist")?.state ?? "missing");
      if (persistenceFails) throw new Error("state write failed");
    });
    const runtime = setup(undefined, true, commitCriticalState);
    approvals = runtime.approvals;
    const host = await request(runtime.gateway, {
      method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" },
    });
    const approvalRequest = {
      method: "POST" as const,
      path: "/v1/rooms/room-1/approvals",
      headers: bearer((host.body as { roomToken: string }).roomToken),
      body: { approvalId: "approval-persist", toolName: "shell", reason: "run tests", expiresAt: 100 },
    };

    expect(await request(runtime.gateway, approvalRequest)).toMatchObject({ status: 500, body: { error: { code: "INTERNAL_ERROR" } } });
    persistenceFails = false;
    expect(await request(runtime.gateway, approvalRequest)).toMatchObject({ status: 201, body: { approval: { state: "pending" } } });

    expect(commitCriticalState).toHaveBeenCalledTimes(2);
    expect(stateAtCommit).toEqual(["pending", "pending"]);
    expect(runtime.ledger.readAfter("room-1", 0, 500).filter((event) => event.type === "approval.requested")).toHaveLength(1);
  });

  it("confirms approval decisions in persistent state before reporting success", async () => {
    let persistenceFails = false;
    let approvals: ApprovalStore | undefined;
    const stateAtCommit: string[] = [];
    const commitCriticalState = vi.fn(async () => {
      const approval = approvals?.snapshot().records.find((record) => record.approvalId === "approval-persist");
      stateAtCommit.push(approval?.state === "decided" ? `${approval.state}:${approval.outcome}` : approval?.state ?? "missing");
      if (persistenceFails) throw new Error("state write failed");
    });
    const runtime = setup(undefined, true, commitCriticalState);
    approvals = runtime.approvals;
    const host = await request(runtime.gateway, {
      method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" },
    });
    const headers = bearer((host.body as { roomToken: string }).roomToken);
    await request(runtime.gateway, {
      method: "POST", path: "/v1/rooms/room-1/approvals", headers,
      body: { approvalId: "approval-persist", toolName: "shell", reason: "run tests", expiresAt: 100 },
    });
    const decision = {
      method: "POST" as const,
      path: "/v1/rooms/room-1/actions",
      headers,
      body: { action: "decideApproval", approvalId: "approval-persist", outcome: "allowed-once" },
    };

    persistenceFails = true;
    expect(await request(runtime.gateway, decision)).toMatchObject({ status: 500, body: { error: { code: "INTERNAL_ERROR" } } });
    persistenceFails = false;
    expect(await request(runtime.gateway, decision)).toMatchObject({ status: 200, body: { approval: { state: "decided", outcome: "allowed-once" } } });

    expect(commitCriticalState).toHaveBeenCalledTimes(3);
    expect(stateAtCommit).toEqual(["pending", "decided:allowed-once", "decided:allowed-once"]);
    expect(runtime.ledger.readAfter("room-1", 0, 500).filter((event) => event.type === "approval.decided")).toHaveLength(1);
  });

  it("confirms a human message in persistent state before reporting success", async () => {
    let persistenceFails = true;
    let ledger: EventLedger | undefined;
    const eventCountAtCommit: number[] = [];
    const commitCriticalState = vi.fn(async () => {
      eventCountAtCommit.push(ledger?.readAfter("room-1", 0, 500).filter((event) => event.type === "human.message").length ?? -1);
      if (persistenceFails) throw new Error("state write failed");
    });
    const runtime = setup(undefined, false, commitCriticalState, new ResourceLimiter({
      maxMessagesPerMemberPerWindow: 1,
      messageWindowMs: 60_000,
    }));
    ledger = runtime.ledger;
    const host = await request(runtime.gateway, {
      method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" },
    });
    const message = {
      method: "POST" as const,
      path: "/v1/rooms/room-1/messages",
      headers: bearer((host.body as { roomToken: string }).roomToken),
      body: { clientMessageId: "human-persist", text: "hello team", target: "room" },
    };

    expect(await request(runtime.gateway, message)).toMatchObject({ status: 500, body: { error: { code: "INTERNAL_ERROR" } } });
    persistenceFails = false;
    expect(await request(runtime.gateway, message)).toMatchObject({ status: 201, body: { message: { text: "hello team" } } });

    expect(commitCriticalState).toHaveBeenCalledTimes(2);
    expect(eventCountAtCommit).toEqual([1, 1]);
    expect(runtime.ledger.readAfter("room-1", 0, 500).filter((event) => event.type === "human.message")).toHaveLength(1);
  });

  it("confirms an Agent request in persistent state before starting delivery", async () => {
    let persistenceFails = true;
    let gateway: CollabGateway | undefined;
    const statusAtCommit: string[] = [];
    const commitCriticalState = vi.fn(async () => {
      statusAtCommit.push(gateway?.dispatcher.get("request:room-1:agent-persist")?.status ?? "missing");
      if (persistenceFails) throw new Error("state write failed");
    });
    const runtime = setup(undefined, false, commitCriticalState, new ResourceLimiter({
      maxMessagesPerMemberPerWindow: 2,
      messageWindowMs: 60_000,
      maxQueuedRequestsPerRoom: 2,
    }));
    gateway = runtime.gateway;
    const host = await request(runtime.gateway, {
      method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" },
    });
    const message = {
      method: "POST" as const,
      path: "/v1/rooms/room-1/messages",
      headers: bearer((host.body as { roomToken: string }).roomToken),
      body: { clientMessageId: "agent-persist", text: "run tests", target: "dsh" },
    };

    expect(await request(runtime.gateway, message)).toMatchObject({ status: 500, body: { error: { code: "INTERNAL_ERROR" } } });
    expect(runtime.calls).toEqual([]);
    expect(runtime.gateway.dispatcher.get("request:room-1:agent-persist")).toMatchObject({ status: "queued" });
    expect(await request(runtime.gateway, {
      method: "POST",
      path: "/v1/rooms/session-new/host",
      auth: { principalId: "host" },
      body: { hostSessionId: "session-new", title: "New room" },
    })).toMatchObject({ status: 200 });
    expect(runtime.calls).toEqual([]);

    persistenceFails = false;
    expect(await request(runtime.gateway, {
      ...message,
      body: { clientMessageId: "agent-second", text: "run lint", target: "dsh" },
    })).toMatchObject({ status: 202 });
    await vi.waitFor(() => expect(runtime.calls).toEqual(["request:room-1:agent-persist", "request:room-1:agent-second"]));

    expect(await request(runtime.gateway, message)).toMatchObject({ status: 202, body: { request: { status: "queued" } } });
    expect(runtime.calls).toEqual(["request:room-1:agent-persist", "request:room-1:agent-second"]);

    expect(commitCriticalState).toHaveBeenCalledTimes(2);
    expect(statusAtCommit).toEqual(["queued", "queued"]);
    expect(runtime.ledger.readAfter("room-1", 0, 500).filter((event) => event.type === "agent.request.queued")).toHaveLength(2);
  });

  it("does not let an earlier persistence barrier dispatch a later unconfirmed Agent request", async () => {
    const releases: Array<() => void> = [];
    const commitCriticalState = vi.fn(() => new Promise<void>((resolve) => releases.push(resolve)));
    const runtime = setup(undefined, false, commitCriticalState, new ResourceLimiter({
      maxMessagesPerMemberPerWindow: 2,
      messageWindowMs: 60_000,
      maxQueuedRequestsPerRoom: 2,
    }));
    const host = await request(runtime.gateway, {
      method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" },
    });
    const sendAgent = (clientMessageId: string, text: string) => request(runtime.gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: bearer((host.body as { roomToken: string }).roomToken),
      body: { clientMessageId, text, target: "dsh" },
    });

    const first = sendAgent("agent-first", "run tests");
    await vi.waitFor(() => expect(commitCriticalState).toHaveBeenCalledTimes(1));
    const second = sendAgent("agent-second", "run lint");
    await vi.waitFor(() => expect(commitCriticalState).toHaveBeenCalledTimes(2));

    releases[0]!();
    await expect(first).resolves.toMatchObject({ status: 202 });
    await vi.waitFor(() => expect(runtime.calls).toEqual(["request:room-1:agent-first"]));

    releases[1]!();
    await expect(second).resolves.toMatchObject({ status: 202 });
    await vi.waitFor(() => expect(runtime.calls).toEqual([
      "request:room-1:agent-first",
      "request:room-1:agent-second",
    ]));
  });
});
