import { describe, expect, it, vi } from "vitest";
import { EventLedger } from "../../src/events.js";
import { LedgerRoomContextReader, LedgerTaskMilestonePublisher, type DshCollabScopedAgent, type DshCollabToolDefinition } from "../../src/dsh-collab-tools.js";
import type { DshNativeAgentContextBinding } from "../../src/dsh-native-agent-context.js";
import { handleTaskAgentHandoff, TaskAgentHandoffService, createDshCollabToolAgentRegistry } from "../../src/task-agent-handoff.js";
import { RoomProjectStore } from "../../src/room-projects.js";
import { TaskStore } from "../../src/tasks.js";

function setup() {
  const definitions: DshCollabToolDefinition[] = [];
  const unregisters: Array<ReturnType<typeof vi.fn>> = [];
  const agent: DshCollabScopedAgent = {
    id: "session-1",
    session: { header: { cwd: "C:\\workspace\\room-1" } },
    ctx: {
      tools: {
        register: vi.fn((definition: DshCollabToolDefinition) => {
          definitions.push(definition);
          const unregister = vi.fn();
          unregisters.push(unregister);
          return unregister;
        }),
      },
      on: vi.fn(() => vi.fn()),
    },
  };
  const projects = new RoomProjectStore();
  projects.register({ roomId: "room-1", memberId: "member-alice", roomTitle: "Room", workspacePath: "C:\\workspace\\room-1" });
  const tasks = new TaskStore();
  tasks.create({ taskId: "task-1", roomId: "room-1", title: "Task", actor: { memberId: "member-alice", principalId: "alice" }, eventId: "task-created", now: 1 });
  const contextBinding = {
    sessionId: "session-1",
    isSafeToInject: () => true,
    deliver: () => ({ deliveryId: "delivery", messageId: "message", state: "injected" as const }),
    cancel: () => true,
    inspect: () => "missing" as const,
    onClaimed: () => vi.fn(),
    dispose: vi.fn(),
  } as unknown as DshNativeAgentContextBinding;
  const ledger = new EventLedger();
  const service = new TaskAgentHandoffService({
    agents: createDshCollabToolAgentRegistry({ get: () => agent }),
    projects,
    resolve: () => ({
      tasks,
      contextBinding,
      context: new LedgerRoomContextReader({ ledger }),
      milestones: new LedgerTaskMilestonePublisher({ ledger, tasks, principalForMember: (memberId) => tasks.principalForMember(memberId) }),
    }),
  });
  return { agent, definitions, unregisters, service };
}

describe("TaskAgentHandoffService", () => {
  it("is the production handoff seam used by task/handoff and releases registered tools", () => {
    const state = setup();
    expect(handleTaskAgentHandoff(state.service, { taskId: "task-1", sessionId: "session-1" })).toEqual({ roomId: "room-1", memberId: "member-alice", taskId: "task-1", sessionId: "session-1" });
    expect(state.definitions.map((definition) => definition.name)).toEqual(["collab_room_context", "collab_task_milestone"]);
    expect(handleTaskAgentHandoff(state.service, { taskId: "task-1", sessionId: "session-1" })).toMatchObject({ taskId: "task-1", sessionId: "session-1" });
    expect(state.unregisters.slice(0, 2).every((unregister) => unregister.mock.calls.length === 1)).toBe(true);
    state.service.disposeSession("session-1");
    expect(state.unregisters.every((unregister) => unregister.mock.calls.length === 1)).toBe(true);
  });

  it("requires the explicit taskId/sessionId payload", () => {
    const state = setup();
    expect(() => handleTaskAgentHandoff(state.service, { taskId: "task-1" })).toThrow(/invalid/i);
    expect(() => handleTaskAgentHandoff(state.service, { taskId: "task-1", sessionId: "session-1", extra: true })).toThrow(/invalid/i);
  });
});
