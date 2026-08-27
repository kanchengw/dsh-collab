import { createHash } from "node:crypto";
import type {
  ReviewPoint,
  ReviewPointCreateInput,
  ReviewPointFile,
  ReviewPointPage,
  ReviewPointProjection,
  WorkspaceSnapshotPackage,
} from "./collaboration-types.js";
import { CollabError, invalidInput } from "./errors.js";
import { EventLedger } from "./events.js";
import { RoomStore } from "./room.js";
import { isSafeWorkspaceSnapshotPath, validateWorkspaceSnapshotPackage } from "./workspace-snapshot-store.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

export type ReviewPointCreateFile = ReviewPointCreateInput["files"][number];

export interface ReviewPointServiceSnapshot {
  version: 1;
  reviewPoints: ReviewPoint[];
  comparisonSnapshots: Array<{ roomId: string; snapshotId: string }>;
}

export interface ReviewPointSnapshotProvider {
  load(snapshotId: string): Promise<WorkspaceSnapshotPackage | undefined>;
}

interface ReviewPointServiceOptions {
  rooms: RoomStore;
  ledger: EventLedger;
  snapshots: ReviewPointSnapshotProvider;
  now?: () => number;
}

function requiredText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(`${field} must not be blank`, { field });
  const normalized = value.trim();
  if (normalized.length > maxLength) throw invalidInput(`${field} is too long`, { field, maxLength });
  return normalized;
}

function optionalText(value: string | undefined, field: string, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim();
  if (normalized === "") return undefined;
  if (normalized.length > maxLength) throw invalidInput(`${field} is too long`, { field, maxLength });
  return normalized;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw invalidInput(`${field} must be a non-negative integer`, { field });
  return value;
}

function reviewPointId(roomId: string, principalId: string, clientRequestId: string): string {
  return createHash("sha256").update(`${roomId}\0${principalId}\0${clientRequestId}`).digest("hex");
}

function validateSnapshotForRoom(snapshot: WorkspaceSnapshotPackage, roomId: string, hostSessionId?: string): WorkspaceSnapshotPackage {
  const value = validateWorkspaceSnapshotPackage(snapshot);
  if (value.roomId !== roomId || (hostSessionId !== undefined && value.hostSessionId !== hostSessionId)) {
    throw invalidInput("Workspace Snapshot does not belong to this room");
  }
  return value;
}

function createFiles(input: readonly ReviewPointCreateFile[], snapshot: WorkspaceSnapshotPackage): ReviewPointFile[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 10_000) throw invalidInput("Review Point files are invalid");
  const manifest = new Map(snapshot.files.map((file) => [file.path, file]));
  const paths = new Set<string>();
  return input.map((file) => {
    if (!file || typeof file.path !== "string" || !isSafeWorkspaceSnapshotPath(file.path) || paths.has(file.path)
      || !["added", "modified", "deleted", "renamed"].includes(file.status)) {
      throw invalidInput("Review Point file is invalid");
    }
    paths.add(file.path);
    const snapshotFile = manifest.get(file.path);
    if (file.status === "deleted" ? snapshotFile !== undefined : snapshotFile === undefined) {
      throw invalidInput("Review Point file does not match the captured Workspace Snapshot", { path: file.path });
    }
    return {
      path: file.path,
      status: file.status,
      ...(snapshotFile ? { snapshotContentHash: snapshotFile.contentHash } : {}),
      additions: nonNegativeInteger(file.additions, "additions"),
      deletions: nonNegativeInteger(file.deletions, "deletions"),
    };
  });
}

function validateRestoredPoint(value: ReviewPoint, rooms: RoomStore): ReviewPoint {
  if (!value || !/^[a-f0-9]{64}$/.test(value.reviewPointId) || typeof value.roomId !== "string"
    || typeof value.createdBy !== "string" || !Array.isArray(value.reviewerIds) || value.reviewerIds.some((id) => typeof id !== "string" || id === "")
    || !["open", "changes-requested", "approved", "closed"].includes(value.lifecycle)
    || !Number.isSafeInteger(value.roomEventSeq) || value.roomEventSeq < 0 || typeof value.mainAgentSessionId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.workspaceSnapshotId) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.headOid)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Array.isArray(value.files)) {
    throw new CollabError("SNAPSHOT_INVALID", "Review Point snapshot is invalid");
  }
  rooms.getRoom(value.roomId);
  requiredText(value.title, "title", 120);
  optionalText(value.focus, "focus", 2_000);
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!file || !isSafeWorkspaceSnapshotPath(file.path) || paths.has(file.path)
      || !["added", "modified", "deleted", "renamed"].includes(file.status)
      || !Number.isSafeInteger(file.additions) || file.additions < 0 || !Number.isSafeInteger(file.deletions) || file.deletions < 0
      || (file.snapshotContentHash !== undefined && !/^[a-f0-9]{64}$/.test(file.snapshotContentHash))) {
      throw new CollabError("SNAPSHOT_INVALID", "Review Point file snapshot is invalid");
    }
    paths.add(file.path);
  }
  return structuredClone(value);
}

function changedFileCount(original: WorkspaceSnapshotPackage, current: WorkspaceSnapshotPackage): number {
  const before = new Map(original.files.map((file) => [file.path, file.contentHash]));
  const after = new Map(current.files.map((file) => [file.path, file.contentHash]));
  return [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path)).length;
}

function freshness(point: ReviewPoint, current: WorkspaceSnapshotPackage): ReviewPointProjection["freshness"] {
  const hashes = new Map(current.files.map((file) => [file.path, file.contentHash]));
  return point.files.some((file) => hashes.get(file.path) !== file.snapshotContentHash) ? "stale" : "current";
}

export class ReviewPointService {
  private readonly points: ReviewPoint[] = [];
  private readonly byId = new Map<string, ReviewPoint>();
  private readonly comparisonSnapshots = new Map<string, string>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly options: ReviewPointServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  static fromSnapshot(options: ReviewPointServiceOptions, snapshot: ReviewPointServiceSnapshot): ReviewPointService {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.reviewPoints) || !Array.isArray(snapshot.comparisonSnapshots)) {
      throw new CollabError("SNAPSHOT_INVALID", "Review Point snapshot is invalid");
    }
    const service = new ReviewPointService(options);
    for (const raw of snapshot.reviewPoints) {
      const point = validateRestoredPoint(raw, options.rooms);
      if (service.byId.has(point.reviewPointId)) throw new CollabError("SNAPSHOT_INVALID", "Review Point snapshot contains duplicate IDs");
      service.points.push(point);
      service.byId.set(point.reviewPointId, point);
    }
    for (const entry of snapshot.comparisonSnapshots) {
      if (!entry || typeof entry.roomId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(entry.snapshotId)
        || service.comparisonSnapshots.has(entry.roomId)) {
        throw new CollabError("SNAPSHOT_INVALID", "Review Point comparison snapshot is invalid");
      }
      options.rooms.getRoom(entry.roomId);
      service.comparisonSnapshots.set(entry.roomId, entry.snapshotId);
    }
    return service;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  create(input: {
    roomId: string;
    principalId: string;
    clientRequestId: string;
    title: string;
    focus?: string;
    files: readonly ReviewPointCreateFile[];
    snapshot: WorkspaceSnapshotPackage;
  }): ReviewPoint {
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    if (member.role !== "host") throw new CollabError("ACTION_FORBIDDEN", "only the Host can create a Review Point");
    const room = this.options.rooms.getRoom(input.roomId);
    const clientRequestId = requiredText(input.clientRequestId, "clientRequestId", 128);
    const captured = validateSnapshotForRoom(input.snapshot, room.roomId, room.hostSessionId);
    if (!captured.headOid) throw invalidInput("Review Point requires a Git HEAD");
    const id = reviewPointId(room.roomId, input.principalId, clientRequestId);
    const existing = this.byId.get(id);
    const focus = optionalText(input.focus, "focus", 2_000);
    const point: ReviewPoint = {
      reviewPointId: id,
      roomId: room.roomId,
      title: requiredText(input.title, "title", 120),
      ...(focus ? { focus } : {}),
      createdBy: member.memberId,
      reviewerIds: [],
      lifecycle: "open",
      roomEventSeq: captured.roomEventSeq,
      mainAgentSessionId: room.hostSessionId,
      workspaceSnapshotId: captured.snapshotId,
      headOid: captured.headOid,
      files: createFiles(input.files, captured),
      createdAt: existing?.createdAt ?? this.now(),
    };
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(point)) throw new CollabError("REQUEST_CONFLICT", "Review Point request conflicts with an existing request");
      return structuredClone(existing);
    }
    this.points.push(point);
    this.byId.set(point.reviewPointId, point);
    this.comparisonSnapshots.set(room.roomId, captured.snapshotId);
    this.emit();
    return structuredClone(point);
  }

  observeSnapshot(input: { roomId: string; principalId: string; snapshot: WorkspaceSnapshotPackage }): void {
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    if (member.role !== "host") throw new CollabError("ACTION_FORBIDDEN", "only the Host can refresh Review Points");
    const room = this.options.rooms.getRoom(input.roomId);
    const captured = validateSnapshotForRoom(input.snapshot, room.roomId, room.hostSessionId);
    if (this.comparisonSnapshots.get(room.roomId) === captured.snapshotId) return;
    this.comparisonSnapshots.set(room.roomId, captured.snapshotId);
    this.emit();
  }

  async list(input: { roomId: string; principalId: string; after?: string; limit?: number }): Promise<ReviewPointPage> {
    this.options.rooms.authorize(input.roomId, input.principalId, "read");
    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw invalidInput("limit must be between 1 and 100");
    const ordered = this.points.filter((point) => point.roomId === input.roomId).reverse();
    const start = input.after === undefined ? 0 : ordered.findIndex((point) => point.reviewPointId === input.after) + 1;
    if (input.after !== undefined && start === 0) throw invalidInput("Review Point cursor is invalid");
    const page = ordered.slice(start, start + limit);
    const comparisonId = this.comparisonSnapshots.get(input.roomId);
    const cache = new Map<string, WorkspaceSnapshotPackage>();
    const load = async (snapshotId: string): Promise<WorkspaceSnapshotPackage> => {
      const cached = cache.get(snapshotId);
      if (cached) return cached;
      const value = await this.options.snapshots.load(snapshotId);
      if (!value) throw new CollabError("SNAPSHOT_NOT_FOUND", "Review Point Workspace Snapshot does not exist");
      const validated = validateSnapshotForRoom(value, input.roomId);
      cache.set(snapshotId, validated);
      return validated;
    };
    const reviewPoints: ReviewPointProjection[] = [];
    for (const point of page) {
      const original = await load(point.workspaceSnapshotId);
      if (original.hostSessionId !== point.mainAgentSessionId) throw new CollabError("SNAPSHOT_INVALID", "Review Point Workspace Snapshot Host Session is invalid");
      const current = comparisonId ? await load(comparisonId) : original;
      reviewPoints.push({
        reviewPoint: structuredClone(point),
        freshness: freshness(point, current),
        progress: {
          roomEventDelta: Math.max(0, this.options.ledger.latestSeq(point.roomId) - point.roomEventSeq),
          workspaceChangedFileCount: changedFileCount(original, current),
        },
      });
    }
    const nextCursor = start + page.length < ordered.length ? page.at(-1)?.reviewPointId : undefined;
    return { reviewPoints, ...(nextCursor ? { nextCursor } : {}) };
  }

  snapshot(): ReviewPointServiceSnapshot {
    return {
      version: 1,
      reviewPoints: structuredClone(this.points),
      comparisonSnapshots: [...this.comparisonSnapshots].map(([roomId, snapshotId]) => ({ roomId, snapshotId })),
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
