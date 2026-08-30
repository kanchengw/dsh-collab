import { invalidInput } from "./errors.js";
import type { RoomEvent } from "./types.js";
import { validateWorkUpdate } from "./work-updates.js";

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
  }

  const omittedCount = Math.max(0, entries.length - input.maxEntries);
  return {
    roomId,
    fromSeq: input.afterSeq + 1,
    toSeq: input.events[input.events.length - 1]!.seq,
    entries: entries.slice(-input.maxEntries),
    omittedCount,
  };
}
