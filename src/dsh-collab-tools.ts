import { EventLedger } from "./events.js";
import { CollabError, invalidInput } from "./errors.js";
import { projectRoomContextForAgent, type RoomContextForAgent } from "./room-context.js";
import type { CollaborationTask } from "./collaboration-types.js";
import type { DshNativeAgentContextBinding } from "./dsh-native-agent-context.js";
import { TaskStore } from "./tasks.js";
import { createHash } from "node:crypto";
import type { ParticipantGatewayTransport } from "./participant.js";
import { roomProjectForCwd } from "./dsh-room-project-sessions.js";
import type { RoomProject, RoomProjectStore } from "./room-projects.js";
import type { RoomEvent, WorkUpdate } from "./types.js";
import { validateWorkUpdate } from "./work-updates.js";

export interface PublishWorkUpdateRequest {
  roomId: string;
  clientRequestId: string;
  sourceSessionId: string;
  summary: string;
  filePaths: string[];
  changeSetId?: string;
  signal?: AbortSignal;
}

export interface WorkUpdatePublisher {
  publish(input: PublishWorkUpdateRequest): Promise<WorkUpdate>;
}

export interface DshCollabToolExecution {
  callId: string;
  signal: AbortSignal;
}

export interface DshCollabToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: "object";
    additionalProperties: false;
    properties: Record<string, unknown>;
    required: string[];
  };
  output: {
    schema: Record<string, unknown>;
    render(args: unknown, value: unknown): Array<{ type: "text"; text: string }>;
  };
  execute(args: unknown, execution: DshCollabToolExecution): Promise<unknown>;
}

interface DshCollabPreToolExecution {
  name: string;
}

export interface DshCollabScopedAgent {
  id: string;
  session?: { header?: { cwd?: string } };
  ctx: {
    tools: { register(definition: DshCollabToolDefinition): () => void };
    on(
      event: "tools/pre-execute",
      listener: (execution: DshCollabPreToolExecution, next: () => Promise<unknown>) => Promise<unknown>,
    ): () => void;
  };
}

export interface DshCollabToolAgentRegistry {
  get(sessionId: string): DshCollabScopedAgent | undefined;
}

export interface CollabPublishUpdateToolBinding {
  readonly roomId: string;
  readonly sessionId: string;
  dispose(): void;
}

interface PublishUpdateArgs {
  summary: string;
  filePaths: string[];
  changeSetId?: string;
}

function parseArgs(value: unknown): PublishUpdateArgs {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("collab_publish_update arguments are invalid");
  const input = value as Record<string, unknown>;
  const allowed = new Set(["summary", "filePaths", "changeSetId"]);
  if (Object.keys(input).some((key) => !allowed.has(key)) || typeof input.summary !== "string"
    || !Array.isArray(input.filePaths) || input.filePaths.some((path) => typeof path !== "string")
    || (input.changeSetId !== undefined && typeof input.changeSetId !== "string")) {
    throw new Error("collab_publish_update arguments are invalid");
  }
  return {
    summary: input.summary,
    filePaths: [...input.filePaths] as string[],
    ...(input.changeSetId === undefined ? {} : { changeSetId: input.changeSetId }),
  };
}

function idempotencyKey(sessionId: string, callId: string): string {
  return createHash("sha256").update(`${sessionId}\0${callId}`, "utf8").digest("hex");
}

function currentProject(projects: RoomProjectStore, agent: DshCollabScopedAgent, expected: RoomProject): RoomProject {
  const current = roomProjectForCwd(projects, agent.session?.header?.cwd);
  if (!current || current.roomId !== expected.roomId || current.memberId !== expected.memberId || current.workspacePath !== expected.workspacePath) {
    throw new Error("Session is no longer in the active Collab Room Project");
  }
  return current;
}

function toolDefinition(input: {
  agents: DshCollabToolAgentRegistry;
  agent: DshCollabScopedAgent;
  projects: RoomProjectStore;
  project: RoomProject;
  sessionId: string;
  publisher: WorkUpdatePublisher;
  isDisposed(): boolean;
}): DshCollabToolDefinition {
  return {
    name: "collab_publish_update",
    description: "Publish a concise update about work completed in this Room Project DSH Session to its Collab room.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        summary: { type: "string", description: "Concise description of completed work. Do not include private prompts or tool logs." },
        filePaths: { type: "array", items: { type: "string" }, description: "Workspace-relative files relevant to the update." },
        changeSetId: { type: "string", description: "Optional immutable Collab ChangeSet identifier." },
      },
      required: ["summary", "filePaths"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          updateId: { type: "string" },
          roomId: { type: "string" },
          status: { type: "string", enum: ["published"] },
        },
        required: ["updateId", "roomId", "status"],
      },
      render: (_args, value) => [{ type: "text", text: `Published Collab work update ${(value as { updateId: string }).updateId}.` }],
    },
    async execute(rawArgs, execution) {
      if (input.isDisposed()) throw new Error("Collab publish tool binding is disposed");
      if (input.agents.get(input.sessionId) !== input.agent) throw new Error("Room Project Session live Agent has changed");
      const project = currentProject(input.projects, input.agent, input.project);
      const args = parseArgs(rawArgs);
      const update = await input.publisher.publish({
        roomId: project.roomId,
        clientRequestId: idempotencyKey(input.sessionId, execution.callId),
        sourceSessionId: input.sessionId,
        summary: args.summary,
        filePaths: args.filePaths,
        ...(args.changeSetId === undefined ? {} : { changeSetId: args.changeSetId }),
        signal: execution.signal,
      });
      if (update.roomId !== project.roomId || update.authorId !== project.memberId || update.sourceSessionId !== input.sessionId) {
        throw new Error("Published Work Update identity does not match the Room Project Session");
      }
      return { updateId: update.updateId, roomId: update.roomId, status: "published" };
    },
  };
}

export function bindCollabPublishUpdateTool(input: {
  agents: DshCollabToolAgentRegistry;
  projects: RoomProjectStore;
  sessionId: string;
  publisher: WorkUpdatePublisher;
}): CollabPublishUpdateToolBinding {
  const agent = input.agents.get(input.sessionId);
  if (!agent || agent.id !== input.sessionId) throw new Error("Room Project Session does not have a live Agent");
  const project = roomProjectForCwd(input.projects, agent.session?.header?.cwd);
  if (!project) throw new Error("Session is not in a Collab Room Project");
  let disposed = false;
  const unregister = agent.ctx.tools.register(toolDefinition({ ...input, agent, project, isDisposed: () => disposed }));
  let removeApprovalGate: () => void;
  try {
    removeApprovalGate = agent.ctx.on("tools/pre-execute", async (execution, next) => {
      if (execution.name !== "collab_publish_update") return await next();
      return { kind: "ask", reason: "Publish this Work Update to the active Collab Room Project?" };
    });
  } catch (error) {
    unregister();
    throw error;
  }
  return {
    roomId: project.roomId,
    sessionId: input.sessionId,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      removeApprovalGate();
      unregister();
    },
  };
}

export class GatewayWorkUpdatePublisher implements WorkUpdatePublisher {
  constructor(private readonly options: {
    transport: ParticipantGatewayTransport;
    tokenForRoom(roomId: string): string | undefined;
  }) {}

  async publish(input: PublishWorkUpdateRequest): Promise<WorkUpdate> {
    const token = this.options.tokenForRoom(input.roomId);
    if (!token) throw new Error("Collab room credential is unavailable");
    const response = await this.options.transport.request({
      method: "POST",
      path: `/v1/rooms/${encodeURIComponent(input.roomId)}/work-updates`,
      token,
      body: {
        clientRequestId: input.clientRequestId,
        sourceSessionId: input.sourceSessionId,
        summary: input.summary,
        filePaths: input.filePaths,
        ...(input.changeSetId === undefined ? {} : { changeSetId: input.changeSetId }),
      },
      signal: input.signal,
    });
    if (response.status >= 400) throw new Error(`Work Update publication failed (${String(response.status)})`);
    const body = response.body as { update?: unknown };
    const update = validateWorkUpdate(body?.update);
    if (update.roomId !== input.roomId || update.sourceSessionId !== input.sourceSessionId) {
      throw new Error("Work Update response identity does not match request");
    }
    return update;
  }
}

export const COLLAB_TASK_MILESTONE_KINDS = [
  "changeset-submitted",
  "review-requested",
  "blocked",
  "completed",
  "needs-human-decision",
] as const;

export type CollabTaskMilestoneKind = typeof COLLAB_TASK_MILESTONE_KINDS[number];

export interface CollabRoomContextResult {
  roomId: string;
  cursor: number;
  nextCursor: number;
  entries: RoomContextForAgent["entries"];
  omittedCount: number;
}

export interface CollabRoomContextReader {
  read(input: { roomId: string; memberId: string; cursor: number }): Promise<CollabRoomContextResult>;
}

function readLedgerRoom(ledger: EventLedger, roomId: string): ReturnType<EventLedger["readAfter"]> {
  const events: ReturnType<EventLedger["readAfter"]> = [];
  let cursor = 0;
  while (cursor < ledger.latestSeq(roomId)) {
    const batch = ledger.readAfter(roomId, cursor, 500);
    if (batch.length === 0) throw invalidInput("Room event ledger is not contiguous", { roomId, cursor });
    events.push(...batch);
    cursor = batch[batch.length - 1]!.seq;
  }
  return events;
}

export class LedgerRoomContextReader implements CollabRoomContextReader {
  constructor(private readonly options: { ledger: EventLedger; maxEntries?: number }) {}

  async read(input: { roomId: string; memberId: string; cursor: number }): Promise<CollabRoomContextResult> {
    if (typeof input.roomId !== "string" || input.roomId.trim() === "") throw invalidInput("roomId is required");
    if (typeof input.memberId !== "string" || input.memberId.trim() === "") throw invalidInput("memberId is required");
    if (!Number.isSafeInteger(input.cursor) || input.cursor < 0) throw invalidInput("cursor must be a non-negative integer", { cursor: input.cursor });
    const latest = this.options.ledger.latestSeq(input.roomId);
    if (input.cursor > latest) throw invalidInput("cursor is outside the requested room", { roomId: input.roomId, cursor: input.cursor, latest });
    const allEvents = readLedgerRoom(this.options.ledger, input.roomId);
    const projected = projectRoomContextForAgent({
      roomId: input.roomId,
      afterSeq: input.cursor,
      events: allEvents.filter((event) => event.seq > input.cursor),
      maxEntries: this.options.maxEntries ?? 64,
      memberId: input.memberId,
      ...(input.cursor === 0 ? {} : { priorEvents: allEvents.filter((event) => event.seq <= input.cursor) }),
    });
    return {
      roomId: input.roomId,
      cursor: input.cursor,
      nextCursor: projected?.toSeq ?? input.cursor,
      entries: projected?.entries ?? [],
      omittedCount: projected?.omittedCount ?? 0,
    };
  }
}

export interface PublishCollabTaskMilestoneRequest {
  clientRequestId: string;
  roomId: string;
  taskId: string;
  memberId: string;
  sourceSessionId: string;
  kind: CollabTaskMilestoneKind;
  summary?: string;
  changeSetId?: string;
}

export interface CollabTaskMilestone {
  milestoneId: string;
  roomId: string;
  taskId: string;
  memberId: string;
  sourceSessionId: string;
  kind: CollabTaskMilestoneKind;
  summary?: string;
  changeSetId?: string;
  createdAt: number;
}

export interface CollabTaskMilestonePublisher {
  publish(input: PublishCollabTaskMilestoneRequest): Promise<CollabTaskMilestone>;
}

function taskMilestoneFromEvent(event: RoomEvent): CollabTaskMilestone {
  const payload = event.payload as Record<string, unknown>;
  return {
    milestoneId: event.eventId,
    roomId: event.roomId,
    taskId: String(payload.taskId),
    memberId: String(payload.memberId),
    sourceSessionId: String(payload.sourceSessionId),
    kind: payload.milestone as CollabTaskMilestoneKind,
    ...(payload.summary === undefined ? {} : { summary: String(payload.summary) }),
    ...(payload.changeSetId === undefined ? {} : { changeSetId: String(payload.changeSetId) }),
    createdAt: event.createdAt,
  };
}

export class LedgerTaskMilestonePublisher implements CollabTaskMilestonePublisher {
  constructor(private readonly options: {
    ledger: EventLedger;
    tasks: TaskStore;
    principalForMember: (memberId: string, roomId?: string) => string | undefined;
    boundSession?: (roomId: string, memberId: string, sessionId: string) => boolean;
    now?: () => number;
  }) {}

  async publish(input: PublishCollabTaskMilestoneRequest): Promise<CollabTaskMilestone> {
    if (!COLLAB_TASK_MILESTONE_KINDS.includes(input.kind)) throw invalidInput("task milestone kind is not supported", { kind: input.kind });
    const task = this.options.tasks.get(input.taskId, false);
    if (!task) throw new CollabError("REQUEST_NOT_FOUND", "Task was not found", { taskId: input.taskId });
    if (task.roomId !== input.roomId) throw new CollabError("ACTION_FORBIDDEN", "Task belongs to another Collab Room", { taskId: input.taskId, roomId: input.roomId });
    if (!task.participantIds.includes(input.memberId)) throw new CollabError("ACTION_FORBIDDEN", "Current member is not a Task participant", { taskId: input.taskId, memberId: input.memberId });
    if (task.assigneeId !== undefined && task.assigneeId !== input.memberId) throw new CollabError("ACTION_FORBIDDEN", "Task is assigned to another member", { taskId: input.taskId, assigneeId: task.assigneeId });
    const principalId = this.options.principalForMember(input.memberId, input.roomId);
    if (!principalId || (this.options.boundSession && !this.options.boundSession(input.roomId, input.memberId, input.sourceSessionId))) {
      throw new CollabError("ACTION_FORBIDDEN", "Task milestone Session is not bound to the requested Room member", { roomId: input.roomId, memberId: input.memberId, sessionId: input.sourceSessionId });
    }
    const createdAt = this.options.now?.() ?? Date.now();
    const payload = {
      roomId: input.roomId,
      taskId: input.taskId,
      memberId: input.memberId,
      sourceSessionId: input.sourceSessionId,
      milestone: input.kind,
      ...(input.summary === undefined ? {} : { summary: input.summary }),
      ...(input.changeSetId === undefined ? {} : { changeSetId: input.changeSetId }),
    };
    try {
      const event = this.options.ledger.append({ eventId: input.clientRequestId, roomId: input.roomId, type: "task.milestone", actor: { memberId: input.memberId, principalId }, createdAt, payload });
      return taskMilestoneFromEvent(event);
    } catch (error) {
      if (error instanceof CollabError && error.code === "EVENT_CONFLICT") {
        const existing = this.options.ledger.snapshot().rooms.flatMap((room) => room.events).find((event) => event.eventId === input.clientRequestId);
        if (existing && existing.roomId === input.roomId && existing.type === "task.milestone" && existing.actor.memberId === input.memberId && existing.actor.principalId === principalId && JSON.stringify(existing.payload) === JSON.stringify(payload)) return taskMilestoneFromEvent(existing);
        throw new CollabError("REQUEST_CONFLICT", "Task milestone request id conflicts with an existing event", { requestId: input.clientRequestId });
      }
      throw error;
    }
  }
}

export interface CollabTaskAgentToolsBinding {
  readonly roomId: string;
  readonly memberId: string;
  readonly sessionId: string;
  readonly taskId: string;
  dispose(): void;
}

function exactObject(value: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("Tool arguments are invalid");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw invalidInput("Tool arguments contain unknown fields");
  return record;
}

function validateTaskAgentBinding(task: CollaborationTask, project: RoomProject, taskId: string): void {
  if (task.taskId !== taskId) throw new CollabError("REQUEST_NOT_FOUND", "Task binding does not match the requested Task", { taskId });
  if (task.roomId !== project.roomId) throw new CollabError("ACTION_FORBIDDEN", "Task belongs to another Collab Room", { taskId, roomId: project.roomId });
  if (!task.participantIds.includes(project.memberId)) throw new CollabError("ACTION_FORBIDDEN", "Current member is not a Task participant", { taskId, memberId: project.memberId });
  if (task.assigneeId !== undefined && task.assigneeId !== project.memberId) throw new CollabError("ACTION_FORBIDDEN", "Task is assigned to another member", { taskId, assigneeId: task.assigneeId });
}

export function bindCollabTaskAgentTools(input: {
  agents: DshCollabToolAgentRegistry;
  projects: RoomProjectStore;
  sessionId: string;
  taskId: string;
  tasks: TaskStore;
  contextBinding: DshNativeAgentContextBinding;
  context: CollabRoomContextReader;
  milestones: CollabTaskMilestonePublisher;
}): CollabTaskAgentToolsBinding {
  const agent = input.agents.get(input.sessionId);
  if (!agent || agent.id !== input.sessionId) throw new CollabError("ACTION_FORBIDDEN", "Task Agent Session is not live", { sessionId: input.sessionId });
  if (input.contextBinding.sessionId !== input.sessionId) throw new CollabError("ACTION_FORBIDDEN", "Native Agent context binding belongs to another Session", { sessionId: input.sessionId });
  const project = roomProjectForCwd(input.projects, agent.session?.header?.cwd);
  if (!project) throw new CollabError("ACTION_FORBIDDEN", "Session is not in a Collab Room Project", { sessionId: input.sessionId });
  const boundTask = input.tasks.get(input.taskId, false);
  if (!boundTask) throw new CollabError("REQUEST_NOT_FOUND", "Task was not found", { taskId: input.taskId });
  validateTaskAgentBinding(boundTask, project, input.taskId);
  let disposed = false;
  const assertBinding = (): { agent: DshCollabScopedAgent; project: RoomProject; task: CollaborationTask } => {
    const task = input.tasks.get(input.taskId, false);
    if (!task) throw new CollabError("REQUEST_NOT_FOUND", "Task binding no longer exists", { taskId: input.taskId });
    const currentAgent = input.agents.get(input.sessionId);
    if (currentAgent !== agent) throw new CollabError("ACTION_FORBIDDEN", "Task Agent Session is no longer live", { sessionId: input.sessionId });
    const current = currentProject(input.projects, currentAgent, project);
    if (input.contextBinding.sessionId !== input.sessionId) throw new CollabError("ACTION_FORBIDDEN", "Native Agent context binding belongs to another Session", { sessionId: input.sessionId });
    validateTaskAgentBinding(task, current, input.taskId);
    return { agent: currentAgent, project: current, task };
  };
  const taskContextDeliveryId = `task-context:${project.roomId}:${input.taskId}:${input.sessionId}`;
  const contextUnregister = agent.ctx.tools.register({
    name: "collab_room_context",
    description: "Read structured incremental Collab Room context for the current member. Human chatter is excluded.",
    parameters: { type: "object", additionalProperties: false, properties: { cursor: { type: "integer", minimum: 0 } }, required: ["cursor"] },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { roomId: { type: "string" }, cursor: { type: "integer" }, nextCursor: { type: "integer" }, entries: { type: "array" }, omittedCount: { type: "integer" } }, required: ["roomId", "cursor", "nextCursor", "entries", "omittedCount"] },
      render: (_args, value) => [{ type: "text", text: "Read Collab Room context through cursor " + String((value as CollabRoomContextResult).nextCursor) + "." }],
    },
    async execute(rawArgs) {
      if (disposed) throw new Error("Collab task Agent tool binding is disposed");
      const current = assertBinding();
      const args = exactObject(rawArgs, ["cursor"]);
      if (!Number.isSafeInteger(args.cursor) || (args.cursor as number) < 0) throw invalidInput("cursor must be a non-negative integer");
      return input.context.read({ roomId: current.project.roomId, memberId: current.project.memberId, cursor: args.cursor as number });
    },
  });
  const milestoneUnregister = agent.ctx.tools.register({
    name: "collab_task_milestone",
    description: "Backfill one meaningful Task milestone to the Collab Room.",
    parameters: { type: "object", additionalProperties: false, properties: { taskId: { type: "string" }, kind: { type: "string", enum: [...COLLAB_TASK_MILESTONE_KINDS] }, summary: { type: "string" }, changeSetId: { type: "string" } }, required: ["taskId", "kind"] },
    output: {
      schema: { type: "object", additionalProperties: false, properties: { milestoneId: { type: "string" }, taskId: { type: "string" }, kind: { type: "string" } }, required: ["milestoneId", "taskId", "kind"] },
      render: (_args, value) => [{ type: "text", text: "Recorded Task milestone " + String((value as CollabTaskMilestone).kind) + "." }],
    },
    async execute(rawArgs, execution) {
      if (disposed) throw new Error("Collab task Agent tool binding is disposed");
      const current = assertBinding();
      const args = exactObject(rawArgs, ["taskId", "kind", "summary", "changeSetId"]);
      if (typeof args.taskId !== "string" || typeof args.kind !== "string" || !COLLAB_TASK_MILESTONE_KINDS.includes(args.kind as CollabTaskMilestoneKind)) throw invalidInput("Task milestone arguments are invalid");
      if (args.taskId !== input.taskId) throw new CollabError("ACTION_FORBIDDEN", "Task milestone is outside the bound Task", { boundTaskId: input.taskId, requestedTaskId: args.taskId });
      if (args.summary !== undefined && typeof args.summary !== "string") throw invalidInput("summary must be a string");
      if (args.changeSetId !== undefined && typeof args.changeSetId !== "string") throw invalidInput("changeSetId must be a string");
      const milestone = await input.milestones.publish({ clientRequestId: idempotencyKey(input.sessionId, execution.callId), roomId: current.project.roomId, taskId: args.taskId, memberId: current.project.memberId, sourceSessionId: input.sessionId, kind: args.kind as CollabTaskMilestoneKind, ...(args.summary === undefined ? {} : { summary: args.summary }), ...(args.changeSetId === undefined ? {} : { changeSetId: args.changeSetId }) });
      return { milestoneId: milestone.milestoneId, taskId: milestone.taskId, kind: milestone.kind };
    },
  });
  try {
    input.contextBinding.deliver({
      deliveryId: taskContextDeliveryId,
      text: JSON.stringify({ kind: "dsh-collab.task-context", roomId: project.roomId, task: boundTask }),
    });
  } catch (error) {
    contextUnregister();
    milestoneUnregister();
    throw error;
  }
  return {
    roomId: project.roomId,
    memberId: project.memberId,
    sessionId: input.sessionId,
    taskId: input.taskId,
    dispose() { if (disposed) return; disposed = true; contextUnregister(); milestoneUnregister(); },
  };
}
