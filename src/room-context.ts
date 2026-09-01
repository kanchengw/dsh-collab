import { invalidInput } from "./errors.js";
import type { RoomEvent } from "./types.js";
import { validateWorkUpdate } from "./work-updates.js";
import { validateWorkspaceVersionRecord } from "./workspace-versions.js";

export type RoomContextEntry =
  | { kind: "message"; author: string; text: string }
  | { kind: "work-update"; author: string; summary: string; refs: string[] }
  | { kind: "changeset"; changeSetId: string; author: string; status: string; summary: string }
  | { kind: "review"; changeSetId: string; author: string; decision: string };

export interface RoomContextSnapshot {
  roomId: string;
  fromSeq: number;
  toSeq: number;
  workspaceVersionId?: string;
  entries: RoomContextEntry[];
  omittedCount: number;
}

export interface ProjectRoomContextInput {
  roomId: string;
  afterSeq: number;
  events: RoomEvent[];
  maxEntries: number;
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

export function projectRoomContext(input: ProjectRoomContextInput): RoomContextSnapshot | undefined {
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
  let workspaceVersionId: string | undefined;
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
    if (event.type === "human.message") entries.push(projectHumanMessage(event, roomId));
    else if (event.type === "work-update.published") entries.push(projectWorkUpdate(event, roomId));
    else if (event.type === "workspace-version.published") workspaceVersionId = projectWorkspaceVersion(event, roomId);
    else {
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
  };
}
