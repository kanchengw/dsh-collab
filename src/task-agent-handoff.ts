import { CollabError } from "./errors.js";
import {
  bindCollabTaskAgentTools,
  type CollabRoomContextReader,
  type CollabTaskAgentToolsBinding,
  type CollabTaskMilestonePublisher,
  type DshCollabScopedAgent,
  type DshCollabToolAgentRegistry,
} from "./dsh-collab-tools.js";
import type { DshNativeAgentContextBinding } from "./dsh-native-agent-context.js";
import type { RoomProjectStore } from "./room-projects.js";
import type { TaskStore } from "./tasks.js";

export interface TaskAgentHandoffRequest {
  taskId: string;
  sessionId: string;
}

export interface TaskAgentHandoffRuntimeSeams {
  tasks: TaskStore;
  contextBinding: DshNativeAgentContextBinding;
  isActiveMember: (roomId: string, memberId: string) => boolean;
  context: CollabRoomContextReader;
  milestones: CollabTaskMilestonePublisher;
}

export class TaskAgentHandoffService {
  private readonly bindings = new Map<string, CollabTaskAgentToolsBinding>();

  constructor(private readonly options: {
    agents: DshCollabToolAgentRegistry;
    projects: RoomProjectStore;
    resolve(sessionId: string): TaskAgentHandoffRuntimeSeams | undefined;
  }) {}

  handoff(input: TaskAgentHandoffRequest): CollabTaskAgentToolsBinding {
    const seams = this.options.resolve(input.sessionId);
    if (!seams) throw new CollabError("ACTION_FORBIDDEN", "Task Agent Session is not associated with a live Room Project", { sessionId: input.sessionId });
    const next = bindCollabTaskAgentTools({
      agents: this.options.agents,
      projects: this.options.projects,
      sessionId: input.sessionId,
      taskId: input.taskId,
      tasks: seams.tasks,
      contextBinding: seams.contextBinding,
      isActiveMember: seams.isActiveMember,
      context: seams.context,
      milestones: seams.milestones,
    });
    this.bindings.get(input.sessionId)?.dispose();
    this.bindings.set(input.sessionId, next);
    return next;
  }

  get(sessionId: string): CollabTaskAgentToolsBinding | undefined {
    return this.bindings.get(sessionId);
  }

  disposeSession(sessionId: string): void {
    this.bindings.get(sessionId)?.dispose();
    this.bindings.delete(sessionId);
  }

  dispose(): void {
    for (const sessionId of this.bindings.keys()) this.disposeSession(sessionId);
  }
}

export function handleTaskAgentHandoff(service: TaskAgentHandoffService, payload: unknown): { roomId: string; memberId: string; taskId: string; sessionId: string } {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Task handoff request is invalid");
  const input = payload as { taskId?: unknown; sessionId?: unknown };
  if (Object.keys(input).some((key) => key !== "taskId" && key !== "sessionId")
    || typeof input.taskId !== "string" || input.taskId.trim() === ""
    || typeof input.sessionId !== "string" || input.sessionId.trim() === "") {
    throw new Error("Task handoff request is invalid");
  }
  const binding = service.handoff({ taskId: input.taskId, sessionId: input.sessionId });
  return { roomId: binding.roomId, memberId: binding.memberId, taskId: binding.taskId, sessionId: binding.sessionId };
}

export function createDshCollabToolAgentRegistry(input: {
  get(sessionId: string): unknown;
}): DshCollabToolAgentRegistry {
  return {
    get(sessionId) {
      const agent = input.get(sessionId) as DshCollabScopedAgent | undefined;
      return agent?.ctx?.tools?.register ? agent : undefined;
    },
  };
}
