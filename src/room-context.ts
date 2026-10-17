import { invalidInput } from "./errors.js";
import type { RoomEvent } from "./types.js";
import { validateWorkUpdate } from "./work-updates.js";
import { validateWorkspaceVersionRecord } from "./workspace-versions.js";

export type RoomContextEntry =
  | { kind: "message"; author: string; text: string }
  | { kind: "work-update"; author: string; summary: string; refs: string[] }
  | { kind: "changeset"; changeSetId: string; author: string; status: string; summary: string }
  | { kind: "review"; changeSetId: string; author: string; decision: string }
  | { kind: "task"; taskId: string; title?: string; status?: string; blocked?: boolean; assigneeId?: string; participantIds: string[] }
  | { kind: "decision"; decisionId: string; scope: string; status: string; conclusion?: string; sourceMessageIds: string[] };

export type RoomContextAgentEntry = Exclude<RoomContextEntry, { kind: "message" }>;

declare const roomContextAgentProjectionBrand: unique symbol;
declare const roomContextSummaryProjectionBrand: unique symbol;

export interface RoomContextForAgent {
  roomId: string;
  fromSeq: number;
  toSeq: number;
  workspaceVersionId?: string;
  entries: RoomContextAgentEntry[];
  omittedCount: number;
  readonly [roomContextAgentProjectionBrand]: "agent";
}

export interface RoomContextForSummary {
  roomId: string;
  fromSeq: number;
  toSeq: number;
  workspaceVersionId?: string;
  entries: RoomContextEntry[];
  omittedCount: number;
  readonly [roomContextSummaryProjectionBrand]: "summary";
}

/** Backwards-compatible name for the structured agent delivery packet. */
export type RoomContextSnapshot = RoomContextForAgent;

export interface ProjectRoomContextInput {
  roomId: string;
  afterSeq: number;
  events: RoomEvent[];
  maxEntries: number;
  memberId?: string;
  priorEvents?: RoomEvent[];
}

export const ROOM_CONTEXT_STATE_VERSION = 1 as const;
const MAX_CONTEXT_DECISIONS = 8;
const MAX_ACTIVE_WORK_UPDATES = 8;
const MAX_CONTEXT_CHANGESETS = 16;

export interface RoomContextSummary {
  kind: "deterministic" | "semantic";
  text: string;
  sourceSeq: number;
  disclosure?: "room-public-only";
}

export interface RoomContextDecision {
  decisionId: string;
  changeSetId: string;
  reviewerId: string;
  outcome: "approved" | "changes-requested";
  note?: string;
  seq: number;
}

export interface RoomContextWorkUpdate {
  updateId: string;
  author: string;
  summary: string;
  refs: string[];
  seq: number;
}

export type RoomContextChangeSetStatus =
  | "submitted"
  | "in-review"
  | "changes-requested"
  | "approved"
  | "applied"
  | "superseded"
  | "conflicted";

export interface RoomContextChangeSet {
  changeSetId: string;
  author: string;
  status: RoomContextChangeSetStatus;
  summary: string;
  reviewerId?: string;
  findingCount: number;
  supersedesChangeSetId?: string;
  supersededByChangeSetId?: string;
  seq: number;
}

export interface RoomContextWorkspaceVersion {
  workspaceVersionId: string;
  parentVersionId?: string;
  createdBy: string;
  createdAt: number;
  changeSummary: { fileCount: number; totalBytes: number };
  seq: number;
}

export interface RoomContextTask {
  taskId: string;
  title: string;
  status: string;
  blocked: boolean;
  assigneeId?: string;
  participantIds: string[];
  seq: number;
}

export interface RoomContextStructuredDecision {
  decisionId: string;
  scope: string;
  status: string;
  conclusion: string;
  sourceMessageIds: string[];
  seq: number;
}
export interface RoomContextState {
  version: typeof ROOM_CONTEXT_STATE_VERSION;
  roomId: string;
  appliedThroughSeq: number;
  currentSummary?: RoomContextSummary;
  decisions: RoomContextDecision[];
  activeWorkUpdates: RoomContextWorkUpdate[];
  changeSets: RoomContextChangeSet[];
  currentWorkspaceVersion?: RoomContextWorkspaceVersion;
  tasks?: RoomContextTask[];
  collabDecisions?: RoomContextStructuredDecision[];
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput(`${field} must not be blank`, { field });
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(`${field} must be a non-negative integer`, { field });
  }
  return value;
}

function collaborationPayload(event: RoomEvent, roomId: string, authorField: string, createdAtField = "createdAt"): Record<string, unknown> {
  if (!isRecord(event.payload)) throw invalidInput(`${event.type} payload is invalid`, { eventId: event.eventId });
  const author = requiredText(event.payload[authorField], `payload.${authorField}`);
  const createdAt = nonNegativeInteger(event.payload[createdAtField], `payload.${createdAtField}`);
  if (author !== event.actor?.memberId || createdAt !== event.createdAt) {
    throw invalidInput(`${event.type} authority does not match its durable event`, { eventId: event.eventId });
  }
  if (event.payload.roomId !== undefined && requiredText(event.payload.roomId, "payload.roomId") !== roomId) {
    throw invalidInput(`${event.type} room does not match its durable event`, { eventId: event.eventId });
  }
  return event.payload;
}

function projectHumanMessage(event: RoomEvent, roomId: string): RoomContextEntry {
  if (!isRecord(event.payload)
    || event.payload.kind !== "human"
    || event.payload.visibility !== "room") {
    throw invalidInput("human.message payload is not a shared room message", { eventId: event.eventId });
  }
  requiredText(event.payload.messageId, "payload.messageId");
  const payloadRoomId = requiredText(event.payload.roomId, "payload.roomId");
  const author = requiredText(event.payload.authorMemberId, "payload.authorMemberId");
  const actorMemberId = requiredText(event.actor?.memberId, "actor.memberId");
  const text = requiredText(event.payload.text, "payload.text");
  if (payloadRoomId !== roomId || author !== actorMemberId) {
    throw invalidInput("human.message authority does not match its durable event", { eventId: event.eventId });
  }
  return { kind: "message", author, text };
}

function projectWorkUpdate(event: RoomEvent, roomId: string): RoomContextEntry {
  const update = validateWorkUpdate(event.payload);
  if (update.roomId !== roomId || update.authorId !== event.actor?.memberId || update.createdAt !== event.createdAt) {
    throw invalidInput("Work Update authority does not match its durable event", { eventId: event.eventId });
  }
  return {
    kind: "work-update",
    author: update.authorId,
    summary: update.summary,
    refs: [...update.filePaths, ...(update.changeSetId ? [update.changeSetId] : [])],
  };
}

function projectWorkspaceVersion(event: RoomEvent, roomId: string): string {
  const record = validateWorkspaceVersionRecord(event.payload);
  if (record.version.roomId !== roomId || record.version.createdBy !== event.actor?.memberId || record.version.createdAt !== event.createdAt) {
    throw invalidInput("Workspace Version authority does not match its durable event", { eventId: event.eventId });
  }
  return record.version.workspaceVersionId;
}

function projectCollaborationRoomEvent(event: RoomEvent, roomId: string): RoomContextEntry | undefined {
  if (event.type === "workspace-sharing.changed") {
    if (!isRecord(event.payload)
      || requiredText(event.payload.roomId, "payload.roomId") !== roomId
      || typeof event.payload.enabled !== "boolean") {
      throw invalidInput("workspace-sharing.changed payload is invalid", { eventId: event.eventId });
    }
    nonNegativeInteger(event.payload.revision, "payload.revision");
    if (event.payload.enabled) {
      const enabledBy = requiredText(event.payload.enabledBy, "payload.enabledBy");
      if (enabledBy !== event.actor?.memberId
        || nonNegativeInteger(event.payload.enabledAt, "payload.enabledAt") !== event.createdAt) {
        throw invalidInput("workspace-sharing.changed authority does not match its durable event", { eventId: event.eventId });
      }
    }
    return undefined;
  }
  if (event.type === "changeset.submitted") {
    const payload = collaborationPayload(event, roomId, "authorId", "submittedAt");
    const title = requiredText(payload.title, "payload.title");
    const summary = requiredText(payload.summary, "payload.summary");
    return {
      kind: "changeset",
      changeSetId: requiredText(payload.changeSetId, "payload.changeSetId"),
      author: requiredText(payload.authorId, "payload.authorId"),
      status: "submitted",
      summary: `${title}: ${summary}`,
    };
  }
  if (event.type === "changeset.review-assigned") {
    const payload = collaborationPayload(event, roomId, "assignedBy");
    return {
      kind: "review",
      changeSetId: requiredText(payload.changeSetId, "payload.changeSetId"),
      author: requiredText(payload.assignedBy, "payload.assignedBy"),
      decision: `Assigned reviewer ${requiredText(payload.reviewerId, "payload.reviewerId")}`,
    };
  }
  if (event.type === "changeset.finding-created") {
    const payload = collaborationPayload(event, roomId, "authorId");
    const severity = requiredText(payload.severity, "payload.severity");
    if (!["critical", "high", "medium", "low", "note"].includes(severity)) {
      throw invalidInput("payload.severity is invalid", { eventId: event.eventId });
    }
    return {
      kind: "review",
      changeSetId: requiredText(payload.changeSetId, "payload.changeSetId"),
      author: requiredText(payload.authorId, "payload.authorId"),
      decision: `[${severity}] ${requiredText(payload.body, "payload.body")}`,
    };
  }
  if (event.type === "changeset.review-decided") {
    const payload = collaborationPayload(event, roomId, "reviewerId");
    if (payload.outcome !== "approved" && payload.outcome !== "changes-requested") {
      throw invalidInput("payload.outcome is invalid", { eventId: event.eventId });
    }
    const note = payload.note === undefined ? undefined : requiredText(payload.note, "payload.note");
    return {
      kind: "review",
      changeSetId: requiredText(payload.changeSetId, "payload.changeSetId"),
      author: requiredText(payload.reviewerId, "payload.reviewerId"),
      decision: note ? `${payload.outcome}: ${note}` : payload.outcome,
    };
  }
  if (event.type === "changeset.revision-linked") {
    const payload = collaborationPayload(event, roomId, "linkedBy");
    return {
      kind: "changeset",
      changeSetId: requiredText(payload.changeSetId, "payload.changeSetId"),
      author: requiredText(payload.linkedBy, "payload.linkedBy"),
      status: "revision",
      summary: `Supersedes ${requiredText(payload.supersedesChangeSetId, "payload.supersedesChangeSetId")}`,
    };
  }
  if (event.type === "changeset.applied") {
    const payload = collaborationPayload(event, roomId, "appliedBy");
    return {
      kind: "changeset",
      changeSetId: requiredText(payload.changeSetId, "payload.changeSetId"),
      author: requiredText(payload.appliedBy, "payload.appliedBy"),
      status: "applied",
      summary: `Workspace ${requiredText(payload.workspaceVersionId, "payload.workspaceVersionId")}`,
    };
  }
  if (event.type === "changeset.apply-conflicted") {
    const payload = collaborationPayload(event, roomId, "detectedBy");
    if (!Array.isArray(payload.conflicts) || payload.conflicts.length === 0) {
      throw invalidInput("payload.conflicts is invalid", { eventId: event.eventId });
    }
    const paths = payload.conflicts.map((value) => {
      if (!isRecord(value)) throw invalidInput("payload.conflicts is invalid", { eventId: event.eventId });
      return requiredText(value.path, "payload.conflicts.path");
    });
    return {
      kind: "changeset",
      changeSetId: requiredText(payload.changeSetId, "payload.changeSetId"),
      author: requiredText(payload.detectedBy, "payload.detectedBy"),
      status: "conflicted",
      summary: `Conflicts: ${paths.join(", ")}`,
    };
  }
  return undefined;
}

interface ProjectedTaskContext {
  taskId: string;
  title: string;
  status: string;
  blocked: boolean;
  assigneeId?: string;
  participantIds: string[];
}

interface ProjectedDecisionContext {
  decisionId: string;
  scope: string;
  status: string;
  conclusion?: string;
  sourceMessageIds: string[];
}

function structuredPayload(event: RoomEvent, roomId: string): Record<string, unknown> {
  if (!isRecord(event.payload)) throw invalidInput(`${event.type} payload is invalid`, { eventId: event.eventId });
  if (event.payload.roomId !== undefined && requiredText(event.payload.roomId, "payload.roomId") !== roomId) {
    throw invalidInput(`${event.type} room does not match its durable event`, { eventId: event.eventId });
  }
  return event.payload;
}

function structuredTaskEvent(event: RoomEvent, roomId: string, memberId: string | undefined, tasks: Map<string, ProjectedTaskContext>): RoomContextEntry | undefined {
  const payload = structuredPayload(event, roomId);
  const taskId = requiredText(payload.taskId, "payload.taskId");
  if (event.type === "task.created") {
    const createdBy = requiredText(payload.createdBy, "payload.createdBy");
    if (createdBy !== event.actor.memberId || !Array.isArray(payload.participantIds)) throw invalidInput("task.created payload is invalid", { eventId: event.eventId });
    const participantIds = [...new Set(payload.participantIds.map((value) => requiredText(value, "payload.participantIds")))];
    tasks.set(taskId, { taskId, title: requiredText(payload.title, "payload.title"), status: "open", blocked: false, participantIds });
  } else {
    const task = tasks.get(taskId);
    if (!task) return undefined;
    task.participantIds = [...new Set([...task.participantIds, event.actor.memberId])];
    if (event.type === "task.updated") {
      if (payload.title !== undefined) task.title = requiredText(payload.title, "payload.title");
      if (payload.blocked !== undefined) {
        if (typeof payload.blocked !== "boolean") throw invalidInput("payload.blocked is invalid", { eventId: event.eventId });
        task.blocked = payload.blocked;
      }
      if (Array.isArray(payload.participantIds)) task.participantIds = [...new Set(payload.participantIds.map((value) => requiredText(value, "payload.participantIds")))];
    } else if (event.type === "task.assigned") {
      task.assigneeId = requiredText(payload.assigneeId, "payload.assigneeId");
      task.participantIds = [...new Set([...task.participantIds, task.assigneeId])];
    } else if (event.type === "task.status-changed") {
      task.status = requiredText(payload.to, "payload.to");
    } else if (event.type === "task.completed") {
      task.status = "done";
    }
  }
  const task = tasks.get(taskId)!;
  if (memberId !== undefined && !task.participantIds.includes(memberId)) return undefined;
  return {
    kind: "task",
    taskId: task.taskId,
    title: task.title,
    status: task.status,
    blocked: task.blocked,
    ...(task.assigneeId ? { assigneeId: task.assigneeId } : {}),
    participantIds: [...task.participantIds],
  };
}

function structuredDecisionEvent(event: RoomEvent, roomId: string, memberId: string | undefined, tasks: Map<string, ProjectedTaskContext>, decisions: Map<string, ProjectedDecisionContext>): RoomContextEntry | undefined {
  const payload = structuredPayload(event, roomId);
  const decisionId = requiredText(payload.decisionId, "payload.decisionId");
  if (event.type === "decision.proposed") {
    const scope = requiredText(payload.scope, "payload.scope");
    const sourceMessageIds = Array.isArray(payload.sourceMessageIds) ? [...new Set(payload.sourceMessageIds.map((value) => requiredText(value, "payload.sourceMessageIds")))] : [];
    if (sourceMessageIds.length === 0 || (scope !== "room" && (!scope.startsWith("task:") || scope.slice(5).trim() === ""))) throw invalidInput("decision.proposed payload is invalid", { eventId: event.eventId });
    const proposedBy = requiredText(payload.proposedBy, "payload.proposedBy");
    if (proposedBy !== event.actor.memberId) throw invalidInput("decision.proposed authority does not match its durable event", { eventId: event.eventId });
    decisions.set(decisionId, { decisionId, scope, status: "proposed", conclusion: requiredText(payload.conclusion, "payload.conclusion"), sourceMessageIds });
  } else {
    const decision = decisions.get(decisionId);
    if (!decision) return undefined;
    if (event.type === "decision.accepted") decision.status = "accepted";
    if (event.type === "decision.superseded") decision.status = "superseded";
  }
  const decision = decisions.get(decisionId)!;
  if (memberId !== undefined && decision.scope.startsWith("task:")) {
    const taskIds = decision.scope.slice("task:".length).split(",");
    if (!taskIds.some((taskId) => tasks.get(taskId)?.participantIds.includes(memberId))) return undefined;
  }
  return {
    kind: "decision",
    decisionId: decision.decisionId,
    scope: decision.scope,
    status: decision.status,
    ...(decision.conclusion ? { conclusion: decision.conclusion } : {}),
    sourceMessageIds: [...decision.sourceMessageIds],
  };
}
function projectRoomContextInternal(input: ProjectRoomContextInput, includeHumanMessages: boolean): RoomContextForSummary | RoomContextForAgent | undefined {
  const roomId = requiredText(input.roomId, "roomId");
  if (!Number.isSafeInteger(input.afterSeq) || input.afterSeq < 0) {
    throw invalidInput("afterSeq must be a non-negative integer", { afterSeq: input.afterSeq });
  }
  if (!Number.isSafeInteger(input.maxEntries) || input.maxEntries < 1) {
    throw invalidInput("maxEntries must be a positive integer", { maxEntries: input.maxEntries });
  }
  if (!Array.isArray(input.events)) throw invalidInput("events must be an array", { field: "events" });
  if (input.events.length === 0) return undefined;

  const entries: RoomContextEntry[] = [];
  const tasks = new Map<string, ProjectedTaskContext>();
  const decisions = new Map<string, ProjectedDecisionContext>();
  let workspaceVersionId: string | undefined;
  const priorEvents = input.priorEvents ?? [];
  if (input.priorEvents !== undefined) {
    let expectedPriorSeq = 1;
    for (const priorEvent of priorEvents) {
      if (!priorEvent || priorEvent.roomId !== roomId) {
        throw invalidInput("room context prior event is outside the requested room", { expectedRoomId: roomId });
      }
      if (priorEvent.seq !== expectedPriorSeq || priorEvent.seq > input.afterSeq) {
        throw invalidInput("room context prior event sequence is not a contiguous prefix", {
          expectedSeq: expectedPriorSeq,
          actualSeq: priorEvent.seq,
        });
      }
      expectedPriorSeq += 1;
      if (priorEvent.type === "task.created" || priorEvent.type === "task.updated" || priorEvent.type === "task.assigned" || priorEvent.type === "task.status-changed" || priorEvent.type === "task.completed") structuredTaskEvent(priorEvent, roomId, undefined, tasks);
      else if (priorEvent.type === "decision.proposed" || priorEvent.type === "decision.accepted" || priorEvent.type === "decision.superseded") structuredDecisionEvent(priorEvent, roomId, undefined, tasks, decisions);
    }
    if (expectedPriorSeq !== input.afterSeq + 1) {
      throw invalidInput("room context prior events do not cover the requested prefix", {
        expectedThroughSeq: input.afterSeq,
        actualThroughSeq: expectedPriorSeq - 1,
      });
    }
  }
  let expectedSeq = input.afterSeq + 1;
  for (const event of input.events) {
    if (!event || event.roomId !== roomId) {
      throw invalidInput("room context event is outside the requested room", { expectedRoomId: roomId });
    }
    if (event.seq !== expectedSeq) {
      throw invalidInput("room context event sequence is not contiguous", {
        expectedSeq,
        actualSeq: event.seq,
      });
    }
    expectedSeq += 1;
    if (event.type === "human.message") {
      const message = projectHumanMessage(event, roomId);
      if (includeHumanMessages) entries.push(message);
    } else if (event.type === "work-update.published") entries.push(projectWorkUpdate(event, roomId));
    else if (event.type === "workspace-version.published") workspaceVersionId = projectWorkspaceVersion(event, roomId);
    else if (event.type === "task.created" || event.type === "task.updated" || event.type === "task.assigned" || event.type === "task.status-changed" || event.type === "task.completed") {
      const task = structuredTaskEvent(event, roomId, input.memberId, tasks);
      if (task) entries.push(task);
    } else if (event.type === "decision.proposed" || event.type === "decision.accepted" || event.type === "decision.superseded") {
      const decision = structuredDecisionEvent(event, roomId, input.memberId, tasks, decisions);
      if (decision) entries.push(decision);
    } else {
      const collaboration = projectCollaborationRoomEvent(event, roomId);
      if (collaboration) entries.push(collaboration);
    }
  }

  const omittedCount = Math.max(0, entries.length - input.maxEntries);
  return {
    roomId,
    fromSeq: input.afterSeq + 1,
    toSeq: input.events[input.events.length - 1]!.seq,
    ...(workspaceVersionId ? { workspaceVersionId } : {}),
    entries: entries.slice(-input.maxEntries),
    omittedCount,
  } as RoomContextForSummary | RoomContextForAgent;
}

/** Projects structured room state for an agent; human discussion is validated but excluded. */
export function projectRoomContextForAgent(input: ProjectRoomContextInput): RoomContextForAgent | undefined {
  return projectRoomContextInternal(input, false) as RoomContextForAgent | undefined;
}

/** Projects room state for an on-demand human-readable summary, including room messages. */
export function projectRoomContextForSummary(input: ProjectRoomContextInput): RoomContextForSummary | undefined {
  return projectRoomContextInternal(input, true) as RoomContextForSummary | undefined;
}

/** Compatibility alias for the summary projection used by existing callers. */
export function projectRoomContext(input: ProjectRoomContextInput): RoomContextForSummary | undefined {
  return projectRoomContextForSummary(input);
}

function stateRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw invalidInput(`${field} is invalid`, { field });
  return value;
}

function safeSequence(value: unknown, field: string): number {
  return nonNegativeInteger(value, field);
}

function validateRoomContextState(value: unknown, expectedRoomId?: string): RoomContextState {
  const candidate = stateRecord(value, "room context state");
  if (candidate.version !== ROOM_CONTEXT_STATE_VERSION) {
    throw invalidInput("room context state version is unsupported", { version: candidate.version });
  }
  const roomId = requiredText(candidate.roomId, "roomId");
  if (expectedRoomId !== undefined && roomId !== expectedRoomId) {
    throw invalidInput("room context state belongs to another room", { expectedRoomId, roomId });
  }
  const appliedThroughSeq = safeSequence(candidate.appliedThroughSeq, "appliedThroughSeq");
  if (!Array.isArray(candidate.decisions) || candidate.decisions.length > MAX_CONTEXT_DECISIONS) {
    throw invalidInput("room context decisions are invalid", { field: "decisions" });
  }
  if (!Array.isArray(candidate.activeWorkUpdates) || candidate.activeWorkUpdates.length > MAX_ACTIVE_WORK_UPDATES) {
    throw invalidInput("room context Work Updates are invalid", { field: "activeWorkUpdates" });
  }
  if (!Array.isArray(candidate.changeSets) || candidate.changeSets.length > MAX_CONTEXT_CHANGESETS) {
    throw invalidInput("room context ChangeSets are invalid", { field: "changeSets" });
  }

  const currentSummary = candidate.currentSummary === undefined ? undefined : (() => {
    const summary = stateRecord(candidate.currentSummary, "currentSummary");
    if (summary.kind !== "deterministic" && summary.kind !== "semantic") throw invalidInput("currentSummary kind is invalid");
    const sourceSeq = safeSequence(summary.sourceSeq, "currentSummary.sourceSeq");
    if (sourceSeq > appliedThroughSeq) throw invalidInput("currentSummary sourceSeq is ahead of appliedThroughSeq");
    return {
      kind: summary.kind as RoomContextSummary["kind"],
      text: requiredText(summary.text, "currentSummary.text"),
      sourceSeq,
      ...(summary.kind === "semantic"
        ? summary.disclosure === "room-public-only"
          ? { disclosure: "room-public-only" as const }
          : invalidInput("semantic currentSummary disclosure is invalid")
        : {}),
    };
  })();

  const decisions = candidate.decisions.map((value) => {
    const decision = stateRecord(value, "room context decision");
    const outcome: RoomContextDecision["outcome"] = decision.outcome as RoomContextDecision["outcome"];
    if (outcome !== "approved" && outcome !== "changes-requested") throw invalidInput("room context decision outcome is invalid");
    const note = decision.note === undefined ? undefined : requiredText(decision.note, "decision.note");
    const seq = safeSequence(decision.seq, "decision.seq");
    if (seq > appliedThroughSeq) throw invalidInput("decision seq is ahead of appliedThroughSeq");
    return {
      decisionId: requiredText(decision.decisionId, "decision.decisionId"),
      changeSetId: requiredText(decision.changeSetId, "decision.changeSetId"),
      reviewerId: requiredText(decision.reviewerId, "decision.reviewerId"),
      outcome,
      ...(note ? { note } : {}),
      seq,
    };
  });

  const activeWorkUpdates = candidate.activeWorkUpdates.map((value) => {
    const update = stateRecord(value, "room context Work Update");
    if (!Array.isArray(update.refs) || update.refs.some((ref) => typeof ref !== "string" || ref.trim() === "")) {
      throw invalidInput("room context Work Update refs are invalid");
    }
    const seq = safeSequence(update.seq, "update.seq");
    if (seq > appliedThroughSeq) throw invalidInput("Work Update seq is ahead of appliedThroughSeq");
    return {
      updateId: requiredText(update.updateId, "update.updateId"),
      author: requiredText(update.author, "update.author"),
      summary: requiredText(update.summary, "update.summary"),
      refs: update.refs.map((ref) => ref.trim()),
      seq,
    };
  });

  const allowedStatuses: RoomContextChangeSetStatus[] = ["submitted", "in-review", "changes-requested", "approved", "applied", "superseded", "conflicted"];
  const changeSets = candidate.changeSets.map((value) => {
    const changeSet = stateRecord(value, "room context ChangeSet");
    if (!allowedStatuses.includes(changeSet.status as RoomContextChangeSetStatus)) throw invalidInput("room context ChangeSet status is invalid");
    if (!Number.isSafeInteger(changeSet.findingCount) || (changeSet.findingCount as number) < 0) throw invalidInput("room context findingCount is invalid");
    const seq = safeSequence(changeSet.seq, "changeSet.seq");
    if (seq > appliedThroughSeq) throw invalidInput("ChangeSet seq is ahead of appliedThroughSeq");
    return {
      changeSetId: requiredText(changeSet.changeSetId, "changeSet.changeSetId"),
      author: requiredText(changeSet.author, "changeSet.author"),
      status: changeSet.status as RoomContextChangeSetStatus,
      summary: requiredText(changeSet.summary, "changeSet.summary"),
      ...(changeSet.reviewerId === undefined ? {} : { reviewerId: requiredText(changeSet.reviewerId, "changeSet.reviewerId") }),
      findingCount: changeSet.findingCount as number,
      ...(changeSet.supersedesChangeSetId === undefined ? {} : { supersedesChangeSetId: requiredText(changeSet.supersedesChangeSetId, "changeSet.supersedesChangeSetId") }),
      ...(changeSet.supersededByChangeSetId === undefined ? {} : { supersededByChangeSetId: requiredText(changeSet.supersededByChangeSetId, "changeSet.supersededByChangeSetId") }),
      seq,
    };
  });

  const tasks = candidate.tasks === undefined ? undefined : (() => {
    if (!Array.isArray(candidate.tasks) || candidate.tasks.length > 32) throw invalidInput("room context tasks are invalid", { field: "tasks" });
    return candidate.tasks.map((value) => {
      const task = stateRecord(value, "room context task");
      const seq = safeSequence(task.seq, "task.seq");
      if (seq > appliedThroughSeq) throw invalidInput("Task seq is ahead of appliedThroughSeq");
      if (!Array.isArray(task.participantIds)) throw invalidInput("Task participantIds are invalid");
      return {
        taskId: requiredText(task.taskId, "task.taskId"),
        title: requiredText(task.title, "task.title"),
        status: requiredText(task.status, "task.status"),
        blocked: task.blocked === true,
        ...(task.assigneeId === undefined ? {} : { assigneeId: requiredText(task.assigneeId, "task.assigneeId") }),
        participantIds: task.participantIds.map((memberId) => requiredText(memberId, "task.participantIds")),
        seq,
      };
    });
  })();

  const collabDecisions = candidate.collabDecisions === undefined ? undefined : (() => {
    if (!Array.isArray(candidate.collabDecisions) || candidate.collabDecisions.length > 32) throw invalidInput("room context structured decisions are invalid", { field: "collabDecisions" });
    return candidate.collabDecisions.map((value) => {
      const decision = stateRecord(value, "room context structured decision");
      const seq = safeSequence(decision.seq, "structured decision.seq");
      if (seq > appliedThroughSeq) throw invalidInput("Structured Decision seq is ahead of appliedThroughSeq");
      if (!Array.isArray(decision.sourceMessageIds)) throw invalidInput("Structured Decision message references are invalid");
      return {
        decisionId: requiredText(decision.decisionId, "structured decision.decisionId"),
        scope: requiredText(decision.scope, "structured decision.scope"),
        status: requiredText(decision.status, "structured decision.status"),
        conclusion: requiredText(decision.conclusion, "structured decision.conclusion"),
        sourceMessageIds: decision.sourceMessageIds.map((messageId) => requiredText(messageId, "structured decision.sourceMessageIds")),
        seq,
      };
    });
  })();
  const currentWorkspaceVersion = candidate.currentWorkspaceVersion === undefined ? undefined : (() => {
    const version = stateRecord(candidate.currentWorkspaceVersion, "currentWorkspaceVersion");
    const changeSummary = stateRecord(version.changeSummary, "currentWorkspaceVersion.changeSummary");
    if (!Number.isSafeInteger(changeSummary.fileCount) || (changeSummary.fileCount as number) < 0
      || !Number.isSafeInteger(changeSummary.totalBytes) || (changeSummary.totalBytes as number) < 0) {
      throw invalidInput("currentWorkspaceVersion.changeSummary is invalid");
    }
    const seq = safeSequence(version.seq, "currentWorkspaceVersion.seq");
    if (seq > appliedThroughSeq) throw invalidInput("Workspace Version seq is ahead of appliedThroughSeq");
    return {
      workspaceVersionId: requiredText(version.workspaceVersionId, "workspaceVersionId"),
      ...(version.parentVersionId === undefined ? {} : { parentVersionId: requiredText(version.parentVersionId, "parentVersionId") }),
      createdBy: requiredText(version.createdBy, "createdBy"),
      createdAt: safeSequence(version.createdAt, "createdAt"),
      changeSummary: { fileCount: changeSummary.fileCount as number, totalBytes: changeSummary.totalBytes as number },
      seq,
    };
  })();

  return structuredClone({
    version: ROOM_CONTEXT_STATE_VERSION,
    roomId,
    appliedThroughSeq,
    currentSummary,
    decisions,
    activeWorkUpdates,
    changeSets,
    currentWorkspaceVersion,
    ...(tasks === undefined ? {} : { tasks }),
    ...(collabDecisions === undefined ? {} : { collabDecisions }),
  });
}

export function restoreRoomContextState(value: unknown, expectedRoomId?: string): RoomContextState {
  return validateRoomContextState(value, expectedRoomId);
}

function replaceBounded<T>(items: T[], value: T, same: (item: T) => boolean, max: number): T[] {
  return [...items.filter((item) => !same(item)), value].slice(-max);
}

function changeSetFor(state: RoomContextState, changeSetId: string, event: RoomEvent): RoomContextChangeSet {
  return state.changeSets.find((changeSet) => changeSet.changeSetId === changeSetId) ?? {
    changeSetId,
    author: requiredText(event.actor?.memberId, "actor.memberId"),
    status: "submitted",
    summary: `ChangeSet ${changeSetId}`,
    findingCount: 0,
    seq: event.seq,
  };
}

function applyChangeSetEvent(state: RoomContextState, event: RoomEvent): void {
  const payload = event.type === "changeset.submitted"
    ? collaborationPayload(event, state.roomId, "authorId", "submittedAt")
    : event.type === "changeset.review-assigned"
      ? collaborationPayload(event, state.roomId, "assignedBy")
      : event.type === "changeset.finding-created"
        ? collaborationPayload(event, state.roomId, "authorId")
        : event.type === "changeset.review-decided"
          ? collaborationPayload(event, state.roomId, "reviewerId")
          : event.type === "changeset.revision-linked"
            ? collaborationPayload(event, state.roomId, "linkedBy")
            : event.type === "changeset.applied"
              ? collaborationPayload(event, state.roomId, "appliedBy")
              : collaborationPayload(event, state.roomId, "detectedBy");
  const changeSetId = requiredText(payload.changeSetId, "payload.changeSetId");
  let changeSet = changeSetFor(state, changeSetId, event);

  if (event.type === "changeset.submitted") {
    changeSet = { ...changeSet, author: requiredText(payload.authorId, "payload.authorId"), status: "submitted", summary: `${requiredText(payload.title, "payload.title")}: ${requiredText(payload.summary, "payload.summary")}`, seq: event.seq };
    state.currentSummary = { kind: "deterministic", text: changeSet.summary, sourceSeq: event.seq };
  } else if (event.type === "changeset.review-assigned") {
    changeSet = { ...changeSet, status: "in-review", reviewerId: requiredText(payload.reviewerId, "payload.reviewerId"), seq: event.seq };
  } else if (event.type === "changeset.finding-created") {
    const severity = requiredText(payload.severity, "payload.severity");
    if (!["critical", "high", "medium", "low", "note"].includes(severity)) throw invalidInput("payload.severity is invalid", { eventId: event.eventId });
    changeSet = { ...changeSet, findingCount: changeSet.findingCount + 1, seq: event.seq };
  } else if (event.type === "changeset.review-decided") {
    const outcome = payload.outcome;
    if (outcome !== "approved" && outcome !== "changes-requested") throw invalidInput("payload.outcome is invalid", { eventId: event.eventId });
    const note = payload.note === undefined ? undefined : requiredText(payload.note, "payload.note");
    state.decisions = replaceBounded(state.decisions, {
      decisionId: requiredText(payload.decisionId, "payload.decisionId"),
      changeSetId,
      reviewerId: requiredText(payload.reviewerId, "payload.reviewerId"),
      outcome,
      ...(note ? { note } : {}),
      seq: event.seq,
    }, (decision) => decision.decisionId === payload.decisionId, MAX_CONTEXT_DECISIONS);
    changeSet = { ...changeSet, status: outcome, reviewerId: requiredText(payload.reviewerId, "payload.reviewerId"), seq: event.seq };
  } else if (event.type === "changeset.revision-linked") {
    const supersedesChangeSetId = requiredText(payload.supersedesChangeSetId, "payload.supersedesChangeSetId");
    state.changeSets = state.changeSets.map((candidate) => candidate.changeSetId === supersedesChangeSetId
      ? { ...candidate, status: "superseded", supersededByChangeSetId: changeSetId, seq: event.seq }
      : candidate);
    changeSet = { ...changeSet, status: "submitted", supersedesChangeSetId, seq: event.seq };
  } else if (event.type === "changeset.applied") {
    changeSet = { ...changeSet, status: "applied", seq: event.seq };
  } else {
    const conflicts = payload.conflicts;
    if (!Array.isArray(conflicts) || conflicts.length === 0) throw invalidInput("payload.conflicts is invalid", { eventId: event.eventId });
    for (const conflict of conflicts) {
      if (!isRecord(conflict)) throw invalidInput("payload.conflicts is invalid", { eventId: event.eventId });
      requiredText(conflict.path, "payload.conflicts.path");
    }
    changeSet = { ...changeSet, status: "conflicted", seq: event.seq };
  }

  state.changeSets = replaceBounded(state.changeSets, changeSet, (candidate) => candidate.changeSetId === changeSetId, MAX_CONTEXT_CHANGESETS);
}

function applyTaskContextEvent(state: RoomContextState, event: RoomEvent): void {
  const payload = structuredPayload(event, state.roomId);
  const taskId = requiredText(payload.taskId, "payload.taskId");
  const tasks = state.tasks ?? (state.tasks = []);
  let task = tasks.find((candidate) => candidate.taskId === taskId);
  if (event.type === "task.created") {
    const createdBy = requiredText(payload.createdBy, "payload.createdBy");
    if (createdBy !== event.actor.memberId || !Array.isArray(payload.participantIds)) throw invalidInput("task.created authority or participants are invalid", { eventId: event.eventId });
    task = {
      taskId,
      title: requiredText(payload.title, "payload.title"),
      status: "open",
      blocked: false,
      participantIds: [...new Set(payload.participantIds.map((value) => requiredText(value, "payload.participantIds")))],
      seq: event.seq,
    };
  } else if (!task) {
    return;
  } else {
    task.participantIds = [...new Set([...task.participantIds, event.actor.memberId])];
    if (event.type === "task.updated") {
      if (payload.title !== undefined) task.title = requiredText(payload.title, "payload.title");
      if (payload.blocked !== undefined) {
        if (typeof payload.blocked !== "boolean") throw invalidInput("payload.blocked is invalid", { eventId: event.eventId });
        task.blocked = payload.blocked;
      }
      if (Array.isArray(payload.participantIds)) task.participantIds = [...new Set(payload.participantIds.map((value) => requiredText(value, "payload.participantIds")))];
    } else if (event.type === "task.assigned") {
      task.assigneeId = requiredText(payload.assigneeId, "payload.assigneeId");
      task.participantIds = [...new Set([...task.participantIds, task.assigneeId])];
    } else if (event.type === "task.status-changed") {
      task.status = requiredText(payload.to, "payload.to");
    } else if (event.type === "task.completed") {
      task.status = "done";
    }
    task.seq = event.seq;
  }
  state.tasks = replaceBounded(tasks, task, (candidate) => candidate.taskId === taskId, 32);
}

function applyStructuredDecisionContextEvent(state: RoomContextState, event: RoomEvent): void {
  const payload = structuredPayload(event, state.roomId);
  const decisionId = requiredText(payload.decisionId, "payload.decisionId");
  const decisions = state.collabDecisions ?? (state.collabDecisions = []);
  let decision = decisions.find((candidate) => candidate.decisionId === decisionId);
  if (event.type === "decision.proposed") {
    const proposedBy = requiredText(payload.proposedBy, "payload.proposedBy");
    if (proposedBy !== event.actor.memberId || !Array.isArray(payload.sourceMessageIds)) throw invalidInput("decision.proposed authority or references are invalid", { eventId: event.eventId });
    const scope = requiredText(payload.scope, "payload.scope");
    if (scope !== "room" && (!scope.startsWith("task:") || scope.slice(5).trim() === "")) throw invalidInput("decision scope is invalid", { eventId: event.eventId });
    decision = {
      decisionId,
      scope,
      status: "proposed",
      conclusion: requiredText(payload.conclusion, "payload.conclusion"),
      sourceMessageIds: payload.sourceMessageIds.map((value) => requiredText(value, "payload.sourceMessageIds")),
      seq: event.seq,
    };
  } else if (!decision) {
    return;
  } else if (event.type === "decision.accepted") {
    decision.status = "accepted";
    decision.seq = event.seq;
  } else if (event.type === "decision.superseded") {
    const replacementId = requiredText(payload.supersededBy, "payload.supersededBy");
    if (!decisions.some((candidate) => candidate.decisionId === replacementId)) return;
    decision.status = "superseded";
    decision.seq = event.seq;
  }
  state.collabDecisions = replaceBounded(decisions, decision, (candidate) => candidate.decisionId === decisionId, 32);
}
export function reduceRoomContext(initial: RoomContextState, events: RoomEvent[]): RoomContextState {
  const state = validateRoomContextState(initial);
  if (!Array.isArray(events)) throw invalidInput("room context events must be an array", { field: "events" });
  let expectedSeq = state.appliedThroughSeq + 1;
  for (const event of events) {
    if (!event || event.roomId !== state.roomId) throw invalidInput("room context event is outside the requested room", { roomId: state.roomId });
    if (!Number.isSafeInteger(event.seq) || event.seq < 1) throw invalidInput("room context event sequence is invalid", { eventId: event.eventId });
    if (event.seq <= state.appliedThroughSeq) continue;
    if (event.seq !== expectedSeq) throw invalidInput("room context event sequence is not contiguous", { expectedSeq, actualSeq: event.seq });

    if (event.type === "work-update.published") {
      const update = validateWorkUpdate(event.payload);
      if (update.roomId !== state.roomId || update.authorId !== event.actor?.memberId || update.createdAt !== event.createdAt) {
        throw invalidInput("Work Update authority does not match its durable event", { eventId: event.eventId });
      }
      state.activeWorkUpdates = replaceBounded(state.activeWorkUpdates, {
        updateId: update.updateId,
        author: update.authorId,
        summary: update.summary,
        refs: [...update.filePaths, ...(update.changeSetId ? [update.changeSetId] : [])],
        seq: event.seq,
      }, (candidate) => candidate.updateId === update.updateId, MAX_ACTIVE_WORK_UPDATES);
      state.currentSummary = { kind: "deterministic", text: update.summary, sourceSeq: event.seq };
    } else if (event.type === "workspace-version.published") {
      const record = validateWorkspaceVersionRecord(event.payload);
      if (record.version.roomId !== state.roomId || record.version.createdBy !== event.actor?.memberId || record.version.createdAt !== event.createdAt) {
        throw invalidInput("Workspace Version authority does not match its durable event", { eventId: event.eventId });
      }
      const fileCount = record.version.files.length;
      const totalBytes = record.artifact.totalBytes;
      state.currentWorkspaceVersion = {
        workspaceVersionId: record.version.workspaceVersionId,
        ...(record.version.parentVersionId ? { parentVersionId: record.version.parentVersionId } : {}),
        createdBy: record.version.createdBy,
        createdAt: record.version.createdAt,
        changeSummary: { fileCount, totalBytes },
        seq: event.seq,
      };
      state.currentSummary = {
        kind: "deterministic",
        text: `Workspace Version ${record.version.workspaceVersionId}: ${fileCount} ${fileCount === 1 ? "file" : "files"}, ${totalBytes} bytes`,
        sourceSeq: event.seq,
      };
    } else if (event.type === "task.created"
      || event.type === "task.updated"
      || event.type === "task.assigned"
      || event.type === "task.status-changed"
      || event.type === "task.completed") {
      applyTaskContextEvent(state, event);
    } else if (event.type === "decision.proposed"
      || event.type === "decision.accepted"
      || event.type === "decision.superseded") {
      applyStructuredDecisionContextEvent(state, event);
    } else if (event.type === "changeset.submitted"
      || event.type === "changeset.review-assigned"
      || event.type === "changeset.finding-created"
      || event.type === "changeset.review-decided"
      || event.type === "changeset.revision-linked"
      || event.type === "changeset.applied"
      || event.type === "changeset.apply-conflicted") {
      applyChangeSetEvent(state, event);
    }

    state.appliedThroughSeq = event.seq;
    expectedSeq += 1;
  }
  return structuredClone(state);
}
