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
import { RoomStreamHub } from "../../src/stream.js";
import type { StreamFrame } from "../../src/types.js";
import { TaskStore } from "../../src/tasks.js";
import { DecisionStore } from "../../src/decisions.js";

function setup(
  agentOverride?: HostAgentPort,
  withApprovals = false,
  commitCriticalState?: () => Promise<void>,
  limits?: ResourceLimiter,
  now: () => number = () => 10,
  stores?: { taskStore?: TaskStore; decisionStore?: DecisionStore; changeSets?: { get(roomId: string, changeSetId: string): Promise<unknown> } },
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
  const workspace = new WorkspaceService({ rooms, ledger, registry: workspaceSharing, now: () => 10 });
  const tokenFactory = vi.fn(() => `room-token-${String(Math.random())}`);
  stores?.taskStore?.setEventSink((event) => {
    ledger.append({ eventId: `task:${event.eventId}`, roomId: event.roomId, type: event.type, actor: event.actor, createdAt: event.createdAt, payload: event.payload });
  });
  stores?.decisionStore?.setEventSink((event) => {
    ledger.append({ eventId: `decision:${event.eventId}`, roomId: event.roomId, type: event.type, actor: event.actor, createdAt: event.createdAt, payload: event.payload });
  });
  const gateway = new CollabGateway({
    rooms, ledger, invites, agent: agentOverride ?? agent, now, approvals,
    hostPrincipalId: "host",
    hostDisplayName: "Host",
    ownsHostSession: (sessionId) => sessionId !== "session-missing",
    activeRooms,
    workspace,
    tokenFactory,
    ...(commitCriticalState ? { commitCriticalState } : {}),
    ...(limits ? { limits } : {}),
    ...(stores?.taskStore ? { taskStore: stores.taskStore } : {}),
    ...(stores?.decisionStore ? { decisionStore: stores.decisionStore } : {}),
    ...(stores?.changeSets ? { changeSets: stores.changeSets as never } : {}),
  });
  return { gateway, calls, rooms, ledger, approvals, workspaceSharing, activeRooms, tokenFactory };
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

  it("keeps opaque Room identity independent from the owned Host Session", async () => {
    const { gateway } = setup();

    const created = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-opaque/host",
      auth: { principalId: "host" },
      body: { hostSessionId: "session-native", title: "  Release room  " },
    });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      room: { roomId: "room-opaque", hostSessionId: "session-native", title: "Release room" },
    });
  });

  it("rejects a Host Session that the current DSH runtime does not own", async () => {
    const { gateway } = setup();

    const rejected = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-opaque/host",
      auth: { principalId: "host" },
      body: { hostSessionId: "session-missing", title: "Release room" },
    });

    expect(rejected).toMatchObject({ status: 403, body: { error: { code: "ACTION_FORBIDDEN" } } });
  });

  it("rejects Participant, unowned and invalid Host share requests", async () => {
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
      body: { inviteId: "invite-1", token: inviteToken, memberId: "member-bob", displayName: "Bob", resumeCredential: "bob-resume" },
    });
    expect(joined.status).toBe(201);
    expect(joined.body).toMatchObject({ room: { roomId: "room-1" }, member: { principalId: "invite:invite-1:member-bob", role: "participant" } });
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

  it("authenticates Task and Decision REST routes and persists their domain events", async () => {
    const taskStore = new TaskStore();
    const decisionStore = new DecisionStore();
    const { gateway, ledger } = setup(undefined, false, undefined, undefined, () => 10, { taskStore, decisionStore });
    const bootstrap = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const headers = bearer((bootstrap.body as { roomToken: string }).roomToken);

    await expect(request(gateway, { method: "POST", path: "/v1/rooms/room-1/tasks", body: { title: "Ship", clientRequestId: "task-create" } })).resolves.toMatchObject({ status: 401 });
    const created = await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/tasks", headers,
      body: { title: "Ship", clientRequestId: "task-create" },
    });
    expect(created).toMatchObject({ status: 201, body: { task: { taskId: "task:task-create", status: "open" } } });
    const taskId = (created.body as { task: { taskId: string } }).task.taskId;
    await expect(request(gateway, {
      method: "POST", path: `/v1/rooms/room-1/tasks/${encodeURIComponent(taskId)}/claim`, headers,
    })).resolves.toMatchObject({ status: 200, body: { task: { assigneeId: "member-host" } } });
    await expect(request(gateway, {
      method: "PUT", path: `/v1/rooms/room-1/tasks/${encodeURIComponent(taskId)}/status`, headers,
      body: { status: "doing" },
    })).resolves.toMatchObject({ status: 200, body: { task: { status: "doing" } } });
    await expect(request(gateway, {
      method: "POST", path: `/v1/rooms/room-1/tasks/${encodeURIComponent(taskId)}/participants`, headers,
      body: { memberId: "member-alice" },
    })).resolves.toMatchObject({ status: 200, body: { task: { participantIds: expect.arrayContaining(["member-alice"]) } } });
    await expect(request(gateway, {
      method: "POST", path: `/v1/rooms/room-1/tasks/${encodeURIComponent(taskId)}/unassign`, headers,
    })).resolves.toMatchObject({ status: 200, body: { task: { assigneeId: undefined } } });
    await expect(request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/messages", headers,
      body: { messageId: "message-1", text: "Source" },
    })).resolves.toMatchObject({ status: 201 });
    await expect(request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/decisions", headers,
      body: { scope: `task:${taskId}`, conclusion: "Ship it.", sourceMessageIds: ["message-1"], clientRequestId: "decision-propose" },
    })).resolves.toMatchObject({ status: 201, body: { decision: { decisionId: "decision:decision-propose", status: "proposed" } } });
    await expect(request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/decisions/decision%3Adecision-propose/accept", headers,
    })).resolves.toMatchObject({ status: 200, body: { decision: { status: "accepted" } } });

    expect(ledger.readAfter("room-1", 0).map((event) => event.type)).toEqual([
      "task.created", "task.assigned", "task.status-changed", "task.updated", "task.assigned", "human.message", "decision.proposed", "decision.accepted",
    ]);
  });

  it("allows a Task to be claimed again after it is unassigned", async () => {
    const taskStore = new TaskStore();
    const { gateway } = setup(undefined, false, undefined, undefined, () => 10, { taskStore });
    const bootstrap = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const headers = bearer((bootstrap.body as { roomToken: string }).roomToken);
    const created = await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/tasks", headers,
      body: { title: "Retry claim", clientRequestId: "task-retry-claim" },
    });
    const taskId = (created.body as { task: { taskId: string } }).task.taskId;

    await expect(request(gateway, {
      method: "POST", path: `/v1/rooms/room-1/tasks/${encodeURIComponent(taskId)}/claim`, headers,
      body: { clientRequestId: "claim-first" },
    })).resolves.toMatchObject({ status: 200, body: { task: { assigneeId: "member-host" } } });
    await expect(request(gateway, {
      method: "POST", path: `/v1/rooms/room-1/tasks/${encodeURIComponent(taskId)}/unassign`, headers,
      body: { clientRequestId: "unassign-first" },
    })).resolves.toMatchObject({ status: 200, body: { task: { assigneeId: undefined } } });
    await expect(request(gateway, {
      method: "POST", path: `/v1/rooms/room-1/tasks/${encodeURIComponent(taskId)}/claim`, headers,
      body: { clientRequestId: "claim-second" },
    })).resolves.toMatchObject({ status: 200, body: { task: { assigneeId: "member-host" } } });
  });

  it("links the submitted ChangeSet to its code Task", async () => {
    const taskStore = new TaskStore();
    const changeSetId = "a".repeat(64);
    const changeSets = { get: vi.fn(async () => ({ changeSetId, draft: { roomId: "room-1", authorId: "member-alice", title: "Fix", summary: "Fix" }, submittedAt: 5 })) };
    const { gateway, ledger } = setup(undefined, false, undefined, undefined, () => 10, { taskStore, changeSets });
    const bootstrap = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const headers = bearer((bootstrap.body as { roomToken: string }).roomToken);
    const created = await request(gateway, { method: "POST", path: "/v1/rooms/room-1/tasks", headers, body: { title: "Code task", clientRequestId: "task-link" } });
    const taskId = (created.body as { task: { taskId: string } }).task.taskId;

    await expect(request(gateway, {
      method: "POST", path: `/v1/rooms/room-1/tasks/${encodeURIComponent(taskId)}/change-sets`, headers,
      body: { changeSetId, clientRequestId: "link-change-set" },
    })).resolves.toMatchObject({ status: 200, body: { task: { changeSetIds: [changeSetId] } } });
    expect(ledger.readAfter("room-1", 0).at(-1)).toMatchObject({ type: "task.updated", payload: { taskId, changeSetIds: [changeSetId] } });
  });

  it("toggles the Task blocked marker without changing its status", async () => {
    const taskStore = new TaskStore();
    const { gateway } = setup(undefined, false, undefined, undefined, () => 10, { taskStore });
    const bootstrap = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const headers = bearer((bootstrap.body as { roomToken: string }).roomToken);
    const created = await request(gateway, { method: "POST", path: "/v1/rooms/room-1/tasks", headers, body: { title: "Blocked task", clientRequestId: "blocked-task" } });
    const taskId = (created.body as { task: { taskId: string } }).task.taskId;

    await expect(request(gateway, { method: "PUT", path: `/v1/rooms/room-1/tasks/${encodeURIComponent(taskId)}/blocked`, headers, body: { blocked: true } })).resolves.toMatchObject({ status: 200, body: { task: { blocked: true, status: "open" } } });
    await expect(request(gateway, { method: "PUT", path: `/v1/rooms/room-1/tasks/${encodeURIComponent(taskId)}/blocked`, headers, body: { blocked: false } })).resolves.toMatchObject({ status: 200, body: { task: { blocked: false } } });
  });

  it("writes Discussion scope and source references into the human message ledger event", async () => {
    const { gateway, ledger } = setup();
    const bootstrap = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const headers = bearer((bootstrap.body as { roomToken: string }).roomToken);
    await expect(request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/messages", headers,
      body: { messageId: "message-1", text: "Source" },
    })).resolves.toMatchObject({ status: 201 });
    const response = await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/messages", headers,
      body: { messageId: "message-2", text: "Follow up", scope: "task:task-1", sourceMessageId: "message-1" },
    });

    expect(response).toMatchObject({ status: 201, body: { message: { scope: "task:task-1", sourceMessageId: "message-1" } } });
    expect(ledger.readAfter("room-1", 0).at(-1)).toMatchObject({
      type: "human.message",
      payload: { scope: "task:task-1", sourceMessageId: "message-1" },
    });
  });

  it("accepts mentions only for active members of the current room and retires @agent requests", async () => {
    const { gateway, rooms } = setup();
    rooms.addMember("room-2", { memberId: "member-foreign", principalId: "foreign", displayName: "Foreign", now: 2 });
    const host = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const headers = bearer((host.body as { roomToken: string }).roomToken);

    await expect(request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers,
      body: { messageId: "message-valid-mention", text: "hello Alice", mentions: ["member-alice"] },
    })).resolves.toMatchObject({ status: 201, body: { message: { mentions: ["member-alice"] } } });

    await expect(request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers,
      body: { messageId: "message-unknown-mention", text: "hello", mentions: ["member-missing"] },
    })).resolves.toMatchObject({ status: 422, body: { error: { code: "INVALID_INPUT" } } });

    await expect(request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers,
      body: { messageId: "message-foreign-mention", text: "hello", mentions: ["member-foreign"] },
    })).resolves.toMatchObject({ status: 422, body: { error: { code: "INVALID_INPUT" } } });

    rooms.setMemberStatus("room-1", "member-alice", "removed", 3);
    await expect(request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers,
      body: { messageId: "message-removed-mention", text: "hello", mentions: ["member-alice"] },
    })).resolves.toMatchObject({ status: 422, body: { error: { code: "INVALID_INPUT" } } });

    await expect(request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers,
      body: { messageId: "message-agent-mention", text: "@agent run tests", target: "dsh", mentions: ["member-missing"] },
    })).resolves.toMatchObject({ status: 422, body: { error: { code: "INVALID_INPUT" } } });
  });

  it("does not stream a room event until its persistence barrier succeeds", async () => {
    let persistenceFails = true;
    const runtime = setup(undefined, false, async () => {
      if (persistenceFails) throw new Error("state write failed");
    });
    const host = await request(runtime.gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/bootstrap",
      auth: { principalId: "host" },
    });
    const roomToken = (host.body as { roomToken: string }).roomToken;
    const frames: StreamFrame[] = [];
    const hub = new RoomStreamHub({
      rooms: runtime.rooms,
      tokens: runtime.gateway.tokens,
      ledger: runtime.ledger,
      activeRooms: runtime.activeRooms,
      now: () => 10,
    });
    hub.connect({ connectionId: "host-stream", roomId: "room-1", token: roomToken, onFrame: (frame) => frames.push(frame) });
    const mutation = {
      method: "POST" as const,
      path: "/v1/rooms/room-1/workspace-sharing",
      headers: {
        ...bearer(roomToken),
        [COLLAB_CAPABILITY_HEADER]: SIDECAR_REVIEW_CAPABILITY,
      },
      body: { enabled: true },
    };

    expect(await request(runtime.gateway, mutation)).toMatchObject({ status: 500 });
    expect(frames.some((frame) => frame.kind === "event" && frame.event.type === "workspace-sharing.changed")).toBe(false);

    persistenceFails = false;
    expect(await request(runtime.gateway, mutation)).toMatchObject({ status: 200 });
    expect(frames.filter((frame) => frame.kind === "event" && frame.event.type === "workspace-sharing.changed")).toHaveLength(1);
    hub.dispose();
  });

  it("does not expose dirty domain state until persistence can recover", async () => {
    let persistenceFails = true;
    const runtime = setup(undefined, false, async () => {
      if (persistenceFails) throw new Error("state write failed");
    });
    const host = await request(runtime.gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/bootstrap",
      auth: { principalId: "host" },
    });
    const headers = {
      ...bearer((host.body as { roomToken: string }).roomToken),
      [COLLAB_CAPABILITY_HEADER]: SIDECAR_REVIEW_CAPABILITY,
    };

    expect(await request(runtime.gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/workspace-sharing",
      headers,
      body: { enabled: true },
    })).toMatchObject({ status: 500 });
    expect(await request(runtime.gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/workspace-sharing",
      headers,
    })).toMatchObject({ status: 500 });

    persistenceFails = false;
    expect(await request(runtime.gateway, {
      method: "GET",
      path: "/v1/rooms/room-1/workspace-sharing",
      headers,
    })).toMatchObject({ status: 200, body: { state: { enabled: true } } });
  });

  it("binds each acceptance of a reusable invite to a distinct Participant principal", async () => {
    const { gateway, rooms } = setup();
    const created = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/invites",
      auth: { principalId: "host" },
      body: { inviteId: "invite-team", expiresAt: 100 },
    });
    const token = (created.body as { token: string }).token;

    const alice = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/join",
      body: { inviteId: "invite-team", token, memberId: "member-team-alice", displayName: "Team Alice", resumeCredential: "team-alice-resume" },
    });
    const bob = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/join",
      body: { inviteId: "invite-team", token, memberId: "member-team-bob", displayName: "Team Bob", resumeCredential: "team-bob-resume" },
    });

    expect(alice).toMatchObject({ status: 201, body: { member: { principalId: "invite:invite-team:member-team-alice" } } });
    expect(bob).toMatchObject({ status: 201, body: { member: { principalId: "invite:invite-team:member-team-bob" } } });
    expect(rooms.listMembers("room-1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ memberId: "member-team-alice", principalId: "invite:invite-team:member-team-alice" }),
      expect.objectContaining({ memberId: "member-team-bob", principalId: "invite:invite-team:member-team-bob" }),
    ]));
  });

  it("requires the original resume proof before a reusable invite can retry an existing member", async () => {
    const { gateway, tokenFactory } = setup();
    const created = await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/invites", auth: { principalId: "host" }, body: { inviteId: "invite-team", expiresAt: 100 },
    });
    const token = (created.body as { token: string }).token;
    const join = (memberId: string, displayName: string, resumeCredential?: string) => request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/join",
      body: { inviteId: "invite-team", token, memberId, displayName, ...(resumeCredential ? { resumeCredential } : {}) },
    });
    await join("member-alice-2", "Alice", "alice-resume-proof");
    await join("member-bob-2", "Bob", "bob-resume-proof");
    const issuedAfterLegitimateJoins = tokenFactory.mock.calls.length;

    await expect(join("member-bob-2", "Bob")).resolves.toMatchObject({ status: 422 });
    await expect(join("member-bob-2", "Bob", "wrong-proof")).resolves.toMatchObject({ status: 409 });
    expect(tokenFactory).toHaveBeenCalledTimes(issuedAfterLegitimateJoins);
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

  it("exchanges a room bearer for a short-lived stream ticket", async () => {
    const { gateway } = setup();
    const bootstrap = await request(gateway, {
      method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" },
    });
    const roomToken = (bootstrap.body as { roomToken: string }).roomToken;

    const response = await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/stream-tickets", headers: bearer(roomToken), body: {},
    });

    expect(response).toMatchObject({ status: 201, body: { ticket: expect.any(String), expiresAt: expect.any(Number) } });
    expect((response.body as { ticket: string }).ticket).not.toBe(roomToken);
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

  it("rejects the retired DSH message route", async () => {
    const { gateway } = setup();
    const bootstrapped = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const roomToken = (bootstrapped.body as { roomToken: string }).roomToken;
    const response = await request(gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: bearer(roomToken),
      body: { messageId: "message-agent", text: "run tests", target: "dsh" },
    });
    expect(response).toMatchObject({ status: 422, body: { error: { code: "INVALID_INPUT" } } });
    expect(gateway.dispatcher.get("message-agent")).toBeUndefined();
  });

  it("does not enqueue retired DSH requests", async () => {
    const { gateway } = setup();
    const bootstrapped = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const roomToken = (bootstrapped.body as { roomToken: string }).roomToken;
    for (const messageId of ["message-first", "message-second"]) {
      await expect(request(gateway, {
        method: "POST",
        path: "/v1/rooms/room-1/messages",
        headers: bearer(roomToken),
        body: { messageId, text: messageId, target: "dsh" },
      })).resolves.toMatchObject({ status: 422, body: { error: { code: "INVALID_INPUT" } } });
    }
    expect(gateway.dispatcher.queued()).toEqual([]);
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
      body: { inviteId: "invite-1", token: (created.body as { token: string }).token, memberId: "member-bob", displayName: "Bob", resumeCredential: "bob-resume" },
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
    expect(commitCriticalState).toHaveBeenCalledTimes(3);
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

  it("exposes the active Agent queue and enforces message ownership for edit and withdraw", async () => {
    const { gateway, ledger } = setup();
    const host = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const alice = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "alice" } });
    const hostToken = (host.body as { roomToken: string }).roomToken;
    const aliceToken = (alice.body as { roomToken: string }).roomToken;
    await gateway.dispatcher.submit({
      principalId: "host",
      message: { kind: "agent-request", messageId: "message-host-queue", requestId: "request-host-queue", roomId: "room-1", authorMemberId: "member-host", text: "Host queued", target: "dsh", deliveryMode: "followup" },
    });
    await gateway.dispatcher.submit({
      principalId: "alice",
      message: { kind: "agent-request", messageId: "message-alice-queue", requestId: "request-alice-queue", roomId: "room-1", authorMemberId: "member-alice", text: "Alice queued", target: "dsh", deliveryMode: "followup" },
    });

    const snapshot = await request(gateway, { method: "GET", path: "/v1/rooms/room-1/snapshot", headers: bearer(aliceToken) });
    expect(snapshot.body).toMatchObject({ agentQueue: [
      { requestId: "request-host-queue", priority: "host", position: 1, status: "queued" },
      { requestId: "request-alice-queue", priority: "participant", position: 2, status: "queued" },
    ] });

    expect(await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/actions", headers: bearer(aliceToken),
      body: { action: "editAgentRequest", requestId: "request-host-queue", text: "No ownership" },
    })).toMatchObject({ status: 403, body: { error: { code: "ACTION_FORBIDDEN" } } });
    expect(await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/actions", headers: bearer(aliceToken),
      body: { action: "editAgentRequest", requestId: "request-alice-queue", text: "Alice edited" },
    })).toMatchObject({ status: 200, body: { request: { message: { text: "Alice edited" }, messageRevision: 1 } } });
    expect(await request(gateway, {
      method: "POST", path: "/v1/rooms/room-1/actions", headers: bearer(hostToken),
      body: { action: "withdrawAgentRequest", requestId: "request-alice-queue" },
    })).toMatchObject({ status: 200, body: { request: { status: "withdrawn" } } });
    expect(ledger.readAfter("room-1", 0).map((event) => event.type)).toEqual(expect.arrayContaining([
      "agent.request.edited", "agent.request.withdrawn",
    ]));
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
    await ledger.commit();

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
      body: { inviteId: "invite-bob", token: (created.body as { token: string }).token, memberId: "member-bob", displayName: "Bob", resumeCredential: "resume-secret" },
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

    expect(commitCriticalState).toHaveBeenCalledTimes(3);
    expect(statusAtCommit).toEqual(["suspended", "suspended", "suspended"]);
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

    expect(commitCriticalState).toHaveBeenCalledTimes(3);
    expect(roleAtCommit).toEqual(["observer", "observer", "observer"]);
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

    expect(commitCriticalState).toHaveBeenCalledTimes(3);
    expect(stateAtCommit).toEqual(["pending", "pending", "pending"]);
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

    expect(commitCriticalState).toHaveBeenCalledTimes(4);
    expect(stateAtCommit).toEqual(["pending", "decided:allowed-once", "decided:allowed-once", "decided:allowed-once"]);
    expect(runtime.ledger.readAfter("room-1", 0, 500).filter((event) => event.type === "approval.decided")).toHaveLength(1);
  });

  it("expires approvals through a durable command before returning the list", async () => {
    let clock = 10;
    const runtime = setup(undefined, true, undefined, undefined, () => clock);
    const host = await request(runtime.gateway, {
      method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" },
    });
    const headers = bearer((host.body as { roomToken: string }).roomToken);
    await request(runtime.gateway, {
      method: "POST", path: "/v1/rooms/room-1/approvals", headers,
      body: { approvalId: "approval-expiring", toolName: "shell", reason: "run tests", expiresAt: 100 },
    });

    clock = 100;
    expect(await request(runtime.gateway, {
      method: "GET", path: "/v1/rooms/room-1/approvals", headers,
    })).toMatchObject({ status: 200, body: { approvals: [expect.objectContaining({ state: "expired", outcome: "unavailable" })] } });
    expect(runtime.ledger.readCommittedAfter("room-1", 0, 500).filter((event) => event.type === "approval.decided"))
      .toHaveLength(1);
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

    expect(commitCriticalState).toHaveBeenCalledTimes(3);
    expect(eventCountAtCommit).toEqual([1, 1, 1]);
    expect(runtime.ledger.readAfter("room-1", 0, 500).filter((event) => event.type === "human.message")).toHaveLength(1);
  });

  it("does not persist a retired Agent request", async () => {
    const runtime = setup();
    const host = await request(runtime.gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const roomToken = (host.body as { roomToken: string }).roomToken;
    const response = await request(runtime.gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: bearer(roomToken),
      body: { clientMessageId: "agent-persist", text: "run lint", target: "dsh" },
    });
    expect(response).toMatchObject({ status: 422, body: { error: { code: "INVALID_INPUT" } } });
    expect(runtime.gateway.dispatcher.queued()).toEqual([]);
  });

  it("does not dispatch a retired Agent request after any persistence barrier", async () => {
    const runtime = setup();
    const host = await request(runtime.gateway, { method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const roomToken = (host.body as { roomToken: string }).roomToken;
    const response = await request(runtime.gateway, {
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: bearer(roomToken),
      body: { clientMessageId: "agent-persist", text: "run lint", target: "dsh" },
    });
    expect(response).toMatchObject({ status: 422, body: { error: { code: "INVALID_INPUT" } } });
    expect(runtime.calls).toEqual([]);
  });

  it("confirms a cancelled request in persistent state before reporting success", async () => {
    let persistenceFails = true;
    const statusAtCommit: string[] = [];
    let gateway: CollabGateway | undefined;
    const commitCriticalState = vi.fn(async () => {
      statusAtCommit.push(gateway?.dispatcher.get("request-cancel-persist")?.status ?? "missing");
      if (persistenceFails) throw new Error("state write failed");
    });
    const runtime = setup(undefined, false, commitCriticalState);
    gateway = runtime.gateway;
    const host = await request(runtime.gateway, {
      method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" },
    });
    await runtime.gateway.dispatcher.submit({
      principalId: "host",
      message: {
        kind: "agent-request", messageId: "message-cancel-persist", requestId: "request-cancel-persist",
        roomId: "room-1", authorMemberId: "member-host", text: "cancel me", target: "dsh", deliveryMode: "followup",
      },
    });
    const cancel = {
      method: "POST" as const,
      path: "/v1/rooms/room-1/actions",
      headers: bearer((host.body as { roomToken: string }).roomToken),
      body: { action: "cancel", requestId: "request-cancel-persist", keepInbox: true },
    };

    expect(await request(runtime.gateway, cancel)).toMatchObject({ status: 500, body: { error: { code: "INTERNAL_ERROR" } } });
    expect(runtime.gateway.dispatcher.get("request-cancel-persist")).toMatchObject({ status: "cancelled" });

    persistenceFails = false;
    expect(await request(runtime.gateway, cancel)).toMatchObject({ status: 200, body: { request: { status: "cancelled" } } });
    expect(commitCriticalState).toHaveBeenCalledTimes(3);
    expect(statusAtCommit).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(runtime.ledger.readAfter("room-1", 0, 500).filter((event) => event.type === "agent.request.cancelled")).toHaveLength(1);
  });

  it("confirms owned room metadata in persistent state before reporting Host sharing success", async () => {
    let persistenceFails = true;
    let rooms: RoomStore | undefined;
    const roomAtCommit: Array<{ title: string; revision: number }> = [];
    const commitCriticalState = vi.fn(async () => {
      const room = rooms?.getRoom("session-persist");
      if (room) roomAtCommit.push({ title: room.title, revision: room.revision });
      if (persistenceFails) throw new Error("state write failed");
    });
    const runtime = setup(undefined, false, commitCriticalState);
    rooms = runtime.rooms;
    const share = (title: string) => request(runtime.gateway, {
      method: "POST",
      path: "/v1/rooms/session-persist/host",
      auth: { principalId: "host" },
      body: { hostSessionId: "session-persist", title },
    });

    expect(await share("Release room")).toMatchObject({ status: 500 });
    expect(runtime.activeRooms.isActive("session-persist")).toBe(false);
    persistenceFails = false;
    expect(await share("Release room")).toMatchObject({ status: 200, body: { room: { title: "Release room", revision: 1 } } });

    persistenceFails = true;
    expect(await share("Planning room")).toMatchObject({ status: 500 });
    persistenceFails = false;
    expect(await share("Planning room")).toMatchObject({ status: 200, body: { room: { title: "Planning room", revision: 2 } } });

    expect(commitCriticalState).toHaveBeenCalledTimes(6);
    expect(roomAtCommit).toEqual([
      { title: "Release room", revision: 1 },
      { title: "Release room", revision: 1 },
      { title: "Release room", revision: 1 },
      { title: "Planning room", revision: 2 },
      { title: "Planning room", revision: 2 },
      { title: "Planning room", revision: 2 },
    ]);
    expect(runtime.rooms.listMembers("session-persist")).toHaveLength(1);
    expect(runtime.activeRooms.isActive("session-persist")).toBe(true);
  });
});
