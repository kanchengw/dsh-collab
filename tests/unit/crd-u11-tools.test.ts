import { describe, expect, it, vi } from "vitest";
import { EventLedger } from "../../src/events.js";
import {
  bindCollabTaskAgentTools,
  LedgerRoomContextReader,
  LedgerTaskMilestonePublisher,
  type DshCollabScopedAgent,
  type DshCollabToolDefinition,
} from "../../src/dsh-collab-tools.js";
import { RoomProjectStore } from "../../src/room-projects.js";
import { TaskStore } from "../../src/tasks.js";
import type { DshNativeAgentContextBinding } from "../../src/dsh-native-agent-context.js";

function actor(memberId = "member-alice", principalId = "alice") {
  return { memberId, principalId };
}

function agent(id = "session-1", cwd = "C:\\workspace\\room-1") {
  let definition: DshCollabToolDefinition | undefined;
  const value: DshCollabScopedAgent = {
    id,
    session: { header: { cwd } },
    ctx: {
      tools: {
        register: vi.fn<(nextDefinition: DshCollabToolDefinition) => () => void>((nextDefinition) => {
          definition = nextDefinition;
          return vi.fn();
        }),
      },
      on: vi.fn((_event, _listener) => vi.fn()),
    },
  };
  return { value, definition: () => definition };
}

function roomProjects(roomId = "room-1", memberId = "member-alice", workspacePath = "C:\\workspace\\room-1") {
  const projects = new RoomProjectStore();
  projects.register({ roomId, memberId, roomTitle: roomId, workspacePath });
  return projects;
}

function contextBinding(deliver = vi.fn()) {
  return {
    sessionId: "session-1",
    isSafeToInject: () => true,
    deliver: deliver.mockImplementation(() => ({ deliveryId: "task-context", messageId: "message-context", state: "injected" as const })),
    cancel: () => true,
    inspect: () => "missing" as const,
    onClaimed: () => vi.fn(),
    dispose: () => undefined,
  } as unknown as DshNativeAgentContextBinding;
}

function tasksFor(input: { taskId?: string; roomId?: string; memberId?: string; assigneeId?: string } = {}) {
  const tasks = new TaskStore();
  const roomId = input.roomId ?? "room-1";
  const memberId = input.memberId ?? "member-alice";
  tasks.create({ taskId: input.taskId ?? "task-1", roomId, title: "Fix reconnect", actor: actor(memberId), eventId: "task-created-" + (input.taskId ?? "task-1"), now: 100 });
  if (input.assigneeId !== undefined) { tasks.addParticipant({ taskId: input.taskId ?? "task-1", memberId: input.assigneeId, actor: actor(memberId), eventId: "task-participant-" + (input.taskId ?? "task-1"), now: 100 }); tasks.assign({ taskId: input.taskId ?? "task-1", assigneeId: input.assigneeId, actor: actor(memberId), eventId: "task-assigned-" + (input.taskId ?? "task-1"), now: 101 }); }
  return tasks;
}

function addEvent(ledger: EventLedger, input: {
  eventId: string;
  roomId?: string;
  type: "human.message" | "task.created" | "task.updated";
  memberId?: string;
  principalId?: string;
  payload: unknown;
}) {
  const roomId = input.roomId ?? "room-1";
  ledger.append({
    eventId: input.eventId,
    roomId,
    type: input.type,
    actor: actor(input.memberId, input.principalId),
    createdAt: 100,
    payload: input.payload,
  });
}

describe("CRD-U11 collab task agent tools", () => {
  it("reads structured room deltas without exposing human chatter and advances the cursor", async () => {
    const ledger = new EventLedger();
    addEvent(ledger, { eventId: "message-1", type: "human.message", payload: { kind: "human", messageId: "message-1", roomId: "room-1", authorMemberId: "member-alice", text: "private chatter", visibility: "room" } });
    addEvent(ledger, {
      eventId: "task-1",
      type: "task.created",
      payload: { taskId: "task-1", title: "Fix reconnect", participantIds: ["member-alice"], createdBy: "member-alice" },
    });
    const reader = new LedgerRoomContextReader({ ledger });

    await expect(reader.read({ roomId: "room-1", memberId: "member-alice", cursor: 0 })).resolves.toMatchObject({
      roomId: "room-1",
      cursor: 0,
      nextCursor: 2,
      entries: [{ kind: "task", taskId: "task-1", title: "Fix reconnect" }],
    });
    await expect(reader.read({ roomId: "room-1", memberId: "member-alice", cursor: 2 })).resolves.toMatchObject({
      roomId: "room-1",
      cursor: 2,
      nextCursor: 2,
      entries: [],
    });
  });

  it("projects a published milestone as structured Task context only for Task members", async () => {
    const ledger = new EventLedger();
    addEvent(ledger, { eventId: "task-1", type: "task.created", payload: { taskId: "task-1", title: "Fix reconnect", participantIds: ["member-alice"], createdBy: "member-alice" } });
    const publisher = new LedgerTaskMilestonePublisher({ ledger, tasks: tasksFor(), principalForMember: () => "alice", now: () => 200 });
    await publisher.publish({ clientRequestId: "milestone-1", roomId: "room-1", taskId: "task-1", memberId: "member-alice", sourceSessionId: "session-1", kind: "changeset-submitted", changeSetId: "change-1" });

    await expect(new LedgerRoomContextReader({ ledger }).read({ roomId: "room-1", memberId: "member-alice", cursor: 1 })).resolves.toMatchObject({ nextCursor: 2, entries: [{ kind: "task-milestone", taskId: "task-1", milestone: "changeset-submitted", changeSetId: "change-1" }] });
    await expect(new LedgerRoomContextReader({ ledger }).read({ roomId: "room-1", memberId: "member-bob", cursor: 1 })).resolves.toMatchObject({ nextCursor: 2, entries: [] });
  });

  it("binds both read-only context and milestone tools to the existing Room Project Agent", async () => {
    const linked = agent();
    const ledger = new EventLedger();
    const milestones = new LedgerTaskMilestonePublisher({ ledger, tasks: tasksFor(), principalForMember: () => "alice" });
    bindCollabTaskAgentTools({
      agents: new Map([["session-1", linked.value]]),
      projects: roomProjects(),
      sessionId: "session-1",
      taskId: "task-1",
      tasks: tasksFor(),
      contextBinding: contextBinding(),
      context: new LedgerRoomContextReader({ ledger }),
      milestones,
    });

    expect(linked.value.ctx.tools.register).toHaveBeenCalledTimes(2);
    const definitions = vi.mocked(linked.value.ctx.tools.register).mock.calls.map(([definition]) => definition as DshCollabToolDefinition);
    expect(definitions.map((definition) => definition.name)).toEqual(["collab_room_context", "collab_task_milestone"]);
    expect(definitions.every((definition) => definition.parameters.additionalProperties === false)).toBe(true);
  });

  it("injects structured Task context through the native Session binding", () => {
    const linked = agent();
    const deliver = vi.fn((_input: { deliveryId: string; text: string }) => ({ deliveryId: "task-context", messageId: "message-context", state: "injected" as const }));
    const ledger = new EventLedger();
    bindCollabTaskAgentTools({ agents: new Map([["session-1", linked.value]]), projects: roomProjects(), sessionId: "session-1", taskId: "task-1", tasks: tasksFor(), contextBinding: contextBinding(deliver), context: new LedgerRoomContextReader({ ledger }), milestones: new LedgerTaskMilestonePublisher({ ledger, tasks: tasksFor(), principalForMember: () => "alice" }) });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: "task-context:room-1:task-1:session-1", text: expect.stringContaining("dsh-collab.task-context") }));
    const delivery = deliver.mock.calls[0]?.[0] as { text: string } | undefined;
    expect(delivery).toBeDefined();
    expect(JSON.parse(delivery!.text).task.taskId).toBe("task-1");
  });

  it("requires an explicit current-room Task binding before registering tools", () => {
    const linked = agent();
    const common = {
      agents: new Map([["session-1", linked.value]]),
      projects: roomProjects(),
      sessionId: "session-1",
      contextBinding: contextBinding(),
      context: new LedgerRoomContextReader({ ledger: new EventLedger() }),
      milestones: new LedgerTaskMilestonePublisher({ ledger: new EventLedger(), tasks: tasksFor(), principalForMember: () => "alice" }),
    };

    expect(() => bindCollabTaskAgentTools({ ...common, taskId: "missing", tasks: tasksFor() })).toThrow(/task/i);
    expect(() => bindCollabTaskAgentTools({ ...common, taskId: "task-2", tasks: tasksFor({ taskId: "task-2", roomId: "room-2" }) })).toThrow(/room/i);
    expect(() => bindCollabTaskAgentTools({ ...common, taskId: "task-1", tasks: tasksFor({ memberId: "member-bob" }) })).toThrow(/participant|member/i);
  });

  it("returns the Task binding handle and rejects a binding that becomes invalid", async () => {
    const linked = agent();
    const ledger = new EventLedger();
    const tasks = tasksFor();
    const binding = bindCollabTaskAgentTools({
      agents: new Map([["session-1", linked.value]]),
      projects: roomProjects(),
      sessionId: "session-1",
      taskId: "task-1",
      tasks,
      contextBinding: contextBinding(),
      context: new LedgerRoomContextReader({ ledger }),
      milestones: new LedgerTaskMilestonePublisher({ ledger, tasks, principalForMember: () => "alice" }),
    });
    expect(binding).toMatchObject({ roomId: "room-1", memberId: "member-alice", sessionId: "session-1", taskId: "task-1" });
    const milestoneDefinition = vi.mocked(linked.value.ctx.tools.register).mock.calls[1]?.[0] as DshCollabToolDefinition;
    await expect(milestoneDefinition.execute({ taskId: "task-2", kind: "completed" }, { callId: "cross-task", signal: new AbortController().signal })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
    tasks.addParticipant({ taskId: "task-1", memberId: "member-bob", actor: actor(), eventId: "task-reassigned-member", now: 102 });
    tasks.assign({ taskId: "task-1", assigneeId: "member-bob", actor: actor(), eventId: "task-reassigned", now: 103 });
    const contextDefinition = vi.mocked(linked.value.ctx.tools.register).mock.calls[0]?.[0] as DshCollabToolDefinition;
    await expect(contextDefinition.execute({ cursor: 0 }, { callId: "call-1", signal: new AbortController().signal })).rejects.toThrow(/binding|member|assignee|task/i);
  });

  it("rejects an invalid cursor and never crosses the reader's room boundary", async () => {
    const ledger = new EventLedger();
    addEvent(ledger, { eventId: "task-1", type: "task.created", payload: { taskId: "task-1", title: "Task", participantIds: ["member-alice"], createdBy: "member-alice" } });
    const reader = new LedgerRoomContextReader({ ledger });

    await expect(reader.read({ roomId: "room-1", memberId: "member-alice", cursor: 2 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(reader.read({ roomId: "room-2", memberId: "member-alice", cursor: 0 })).resolves.toMatchObject({ roomId: "room-2", nextCursor: 0, entries: [] });
  });

  it("re-resolves the current Session workspace and validates the native binding Session id on every call", async () => {
    const linked = agent();
    const projects = roomProjects();
    const tasks = tasksFor();
    const contextBindingValue = contextBinding();
    const ledger = new EventLedger();
    bindCollabTaskAgentTools({
      agents: new Map([["session-1", linked.value]]),
      projects,
      sessionId: "session-1",
      taskId: "task-1",
      tasks,
      contextBinding: contextBindingValue,
      context: new LedgerRoomContextReader({ ledger }),
      milestones: new LedgerTaskMilestonePublisher({ ledger, tasks, principalForMember: () => "alice" }),
    });
    linked.value.session!.header!.cwd = "C:\\workspace\\other";
    const contextDefinition = vi.mocked(linked.value.ctx.tools.register).mock.calls[0]![0];
    await expect(contextDefinition.execute({ cursor: 0 }, { callId: "workspace-change", signal: new AbortController().signal })).rejects.toThrow(/workspace|Room Project/i);

    expect(() => bindCollabTaskAgentTools({
      agents: new Map([["session-1", linked.value]]),
      projects,
      sessionId: "session-1",
      taskId: "task-1",
      tasks,
      contextBinding: { ...contextBinding(), sessionId: "other-session" } as DshNativeAgentContextBinding,
      context: new LedgerRoomContextReader({ ledger }),
      milestones: new LedgerTaskMilestonePublisher({ ledger, tasks, principalForMember: () => "alice" }),
    })).toThrow(/session/i);
  });

  it("allows only milestone backfills and rejects realtime progress", async () => {
    const ledger = new EventLedger();
    const publisher = new LedgerTaskMilestonePublisher({ ledger, tasks: tasksFor(), principalForMember: () => "alice", now: () => 200 });

    await expect(publisher.publish({
      clientRequestId: "milestone-1",
      roomId: "room-1",
      taskId: "task-1",
      memberId: "member-alice",
      sourceSessionId: "session-1",
      kind: "blocked",
      summary: "Waiting for a decision.",
    })).resolves.toMatchObject({ kind: "blocked", taskId: "task-1" });
    await expect(publisher.publish({
      clientRequestId: "progress-1",
      roomId: "room-1",
      taskId: "task-1",
      memberId: "member-alice",
      sourceSessionId: "session-1",
      kind: "progress",
      summary: "Still working.",
    } as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("rejects cross-room and unbound milestone publication, while making retries idempotent and conflicts explicit", async () => {
    const ledger = new EventLedger();
    const tasks = tasksFor();
    const publisher = new LedgerTaskMilestonePublisher({
      ledger,
      tasks,
      principalForMember: (memberId) => memberId === "member-alice" ? "alice" : undefined,
      boundSession: (roomId, memberId, sessionId) => roomId === "room-1" && memberId === "member-alice" && sessionId === "session-1",
    });
    const request = {
      clientRequestId: "milestone-1",
      roomId: "room-1",
      taskId: "task-1",
      memberId: "member-alice",
      sourceSessionId: "session-1",
      kind: "completed" as const,
      summary: "Done.",
    };

    await expect(publisher.publish({ ...request, roomId: "room-2" })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
    await expect(publisher.publish({ ...request, sourceSessionId: "session-2" })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
    await expect(publisher.publish(request)).resolves.toMatchObject({ milestoneId: "milestone-1" });
    await expect(publisher.publish(request)).resolves.toMatchObject({ milestoneId: "milestone-1" });
    await expect(publisher.publish({ ...request, summary: "Conflicting retry." })).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });
  });

  it("rejects unknown, cross-room, and foreign-member milestone publication at the publisher boundary", async () => {
    const ledger = new EventLedger();
    const tasks = tasksFor();
    tasks.create({ taskId: "task-2", roomId: "room-2", title: "Other room", actor: actor(), eventId: "task-created-task-2", now: 100 });
    const publisher = new LedgerTaskMilestonePublisher({ ledger, tasks, principalForMember: (memberId) => memberId === "member-alice" || memberId === "member-bob" ? memberId : undefined });
    const request = { clientRequestId: "publisher-validation", roomId: "room-1", taskId: "task-1", memberId: "member-alice", sourceSessionId: "session-1", kind: "completed" as const };

    await expect(publisher.publish({ ...request, taskId: "missing" })).rejects.toMatchObject({ code: "REQUEST_NOT_FOUND" });
    await expect(publisher.publish({ ...request, roomId: "room-2" })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
    await expect(publisher.publish({ ...request, memberId: "member-bob" })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
  });

  it("rejects forged milestone kinds while projecting Room Context", async () => {
    const ledger = new EventLedger();
    addEvent(ledger, { eventId: "task-created", type: "task.created", payload: { taskId: "task-1", title: "Task", participantIds: ["member-alice"], createdBy: "member-alice" } });
    ledger.append({
      eventId: "milestone-forged",
      roomId: "room-1",
      type: "task.milestone",
      actor: actor(),
      createdAt: 100,
      payload: { roomId: "room-1", taskId: "task-1", memberId: "member-alice", sourceSessionId: "session-1", milestone: "forged-value" },
    });
    await expect(new LedgerRoomContextReader({ ledger }).read({ roomId: "room-1", memberId: "member-alice", cursor: 0 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
