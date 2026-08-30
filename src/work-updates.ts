import { createHash } from "node:crypto";
import { CollabError, invalidInput } from "./errors.js";
import { EventLedger } from "./events.js";
import { RoomStore } from "./room.js";
import type { RoomEvent, WorkUpdate } from "./types.js";
import { isSafeWorkspaceSnapshotPath } from "./workspace-snapshot-store.js";

const MAX_SUMMARY_LENGTH = 10_000;
const MAX_FILE_PATHS = 100;
const MAX_FILE_PATH_LENGTH = 512;

export interface PublishWorkUpdateInput {
  roomId: string;
  principalId: string;
  clientRequestId: string;
  sourceSessionId: string;
  summary: string;
  filePaths: string[];
  changeSetId?: string;
}

export interface PublishedWorkUpdate {
  update: WorkUpdate;
  event: RoomEvent;
  created: boolean;
}

export interface WorkUpdateServiceOptions {
  rooms: RoomStore;
  ledger: EventLedger;
  now?: () => number;
  resolveChangeSetRoom?: (changeSetId: string) => string | undefined;
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(`${field} must not be blank`, { field });
  const normalized = value.trim();
  if (normalized.length > maxLength) throw invalidInput(`${field} is too long`, { field, maxLength });
  return normalized;
}

function filePaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_FILE_PATHS) throw invalidInput("filePaths are invalid", { field: "filePaths" });
  const seen = new Set<string>();
  return value.map((path) => {
    if (typeof path !== "string" || path.length > MAX_FILE_PATH_LENGTH || !isSafeWorkspaceSnapshotPath(path) || seen.has(path)) {
      throw invalidInput("filePaths are invalid", { field: "filePaths" });
    }
    seen.add(path);
    return path;
  });
}

function optionalChangeSetId(value: unknown): string | undefined {
  return value === undefined ? undefined : requiredText(value, "changeSetId", 128);
}

export function validateWorkUpdate(value: unknown): WorkUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("Work Update is invalid");
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["updateId", "roomId", "authorId", "sourceSessionId", "summary", "filePaths", "changeSetId", "createdAt"]);
  if (Object.keys(candidate).some((field) => !allowed.has(field))) throw invalidInput("Work Update contains an unsupported field");
  const updateId = requiredText(candidate.updateId, "updateId", 64);
  if (!/^[a-f0-9]{64}$/.test(updateId)) throw invalidInput("updateId is invalid", { field: "updateId" });
  const createdAt = candidate.createdAt;
  if (!Number.isSafeInteger(createdAt) || (createdAt as number) < 0) throw invalidInput("createdAt is invalid", { field: "createdAt" });
  const changeSetId = optionalChangeSetId(candidate.changeSetId);
  return {
    updateId,
    roomId: requiredText(candidate.roomId, "roomId", 128),
    authorId: requiredText(candidate.authorId, "authorId", 128),
    sourceSessionId: requiredText(candidate.sourceSessionId, "sourceSessionId", 128),
    summary: requiredText(candidate.summary, "summary", MAX_SUMMARY_LENGTH),
    filePaths: filePaths(candidate.filePaths),
    ...(changeSetId ? { changeSetId } : {}),
    createdAt: createdAt as number,
  };
}

function updateId(roomId: string, principalId: string, clientRequestId: string): string {
  return createHash("sha256").update(`${roomId}\0${principalId}\0${clientRequestId}`, "utf8").digest("hex");
}

function sameUpdate(left: WorkUpdate, right: WorkUpdate): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class WorkUpdateService {
  private readonly byId = new Map<string, { update: WorkUpdate; event: RoomEvent }>();
  private readonly now: () => number;

  constructor(private readonly options: WorkUpdateServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    for (const room of options.ledger.snapshot().rooms) {
      for (const event of room.events) {
        if (event.type !== "work-update.published") continue;
        try {
          const update = validateWorkUpdate(event.payload);
          const member = options.rooms.listMembers(update.roomId).find((candidate) => candidate.memberId === update.authorId);
          if (event.eventId !== `work-update:${update.updateId}` || event.roomId !== update.roomId
            || event.actor.memberId !== update.authorId || event.actor.principalId !== member?.principalId
            || event.createdAt !== update.createdAt || !member
            || this.byId.has(update.updateId)) {
            throw new Error("event mismatch");
          }
          this.byId.set(update.updateId, { update, event: structuredClone(event) });
        } catch (error) {
          throw new CollabError("SNAPSHOT_INVALID", "Work Update ledger snapshot is invalid", {
            cause: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  publish(input: PublishWorkUpdateInput): PublishedWorkUpdate {
    const roomId = requiredText(input.roomId, "roomId", 128);
    const principalId = requiredText(input.principalId, "principalId", 128);
    const member = this.options.rooms.authorize(roomId, principalId, "workUpdate");
    const clientRequestId = requiredText(input.clientRequestId, "clientRequestId", 128);
    const id = updateId(roomId, principalId, clientRequestId);
    const existing = this.byId.get(id);
    const changeSetId = optionalChangeSetId(input.changeSetId);
    const update = validateWorkUpdate({
      updateId: id,
      roomId,
      authorId: member.memberId,
      sourceSessionId: input.sourceSessionId,
      summary: input.summary,
      filePaths: input.filePaths,
      ...(changeSetId ? { changeSetId } : {}),
      createdAt: existing?.update.createdAt ?? this.now(),
    });
    if (existing) {
      if (!sameUpdate(existing.update, update)) throw new CollabError("REQUEST_CONFLICT", "Work Update request conflicts with an existing request");
      return { update: structuredClone(existing.update), event: structuredClone(existing.event), created: false };
    }
    if (changeSetId && this.options.resolveChangeSetRoom?.(changeSetId) !== roomId) {
      throw invalidInput("ChangeSet reference does not belong to this room", { changeSetId });
    }
    const event = this.options.ledger.append({
      eventId: `work-update:${update.updateId}`,
      roomId,
      type: "work-update.published",
      actor: { memberId: member.memberId, principalId },
      createdAt: update.createdAt,
      payload: update,
    });
    this.byId.set(update.updateId, { update, event });
    return { update: structuredClone(update), event: structuredClone(event), created: true };
  }
}
