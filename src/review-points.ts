import { createHash } from "node:crypto";
import type {
  ReviewPointDiff,
  ReviewPoint,
  ReviewPointCreateInput,
  ReviewPointFile,
  ReviewPointPage,
  ReviewPointProjection,
  ReviewLifecycle,
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
  version: 1 | 2;
  reviewPoints: ReviewPoint[];
  comparisonSnapshots: Array<{ roomId: string; snapshotId: string }>;
  reviewDiffs?: Array<{ reviewPointId: string; diffs: ReviewPointDiff[] }>;
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
  const files = validateCreateFiles(input);
  const manifest = new Map(snapshot.files.map((file) => [file.path, file]));
  return files.map((file) => {
    const snapshotFile = manifest.get(file.path);
    if (file.status === "deleted" ? snapshotFile !== undefined : snapshotFile === undefined) {
      throw invalidInput("Review Point file does not match the captured Workspace Snapshot", { path: file.path });
    }
    return {
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status,
      ...(snapshotFile ? { snapshotContentHash: snapshotFile.contentHash } : {}),
      additions: file.additions,
      deletions: file.deletions,
    };
  });
}

function validateCreateFiles(input: readonly ReviewPointCreateFile[]): ReviewPointCreateFile[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 10_000) throw invalidInput("Review Point files are invalid");
  const paths = new Set<string>();
  return input.map((file) => {
    if (!file || typeof file.path !== "string" || !isSafeWorkspaceSnapshotPath(file.path) || paths.has(file.path)
      || (file.previousPath !== undefined && !isSafeWorkspaceSnapshotPath(file.previousPath))
      || !["added", "modified", "deleted", "renamed"].includes(file.status)) {
      throw invalidInput("Review Point file is invalid");
    }
    paths.add(file.path);
    return {
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status: file.status,
      additions: nonNegativeInteger(file.additions, "additions"),
      deletions: nonNegativeInteger(file.deletions, "deletions"),
    };
  });
}

function validateRestoredPoint(value: ReviewPoint, rooms: RoomStore): ReviewPoint {
  if (!value || !/^[a-f0-9]{64}$/.test(value.reviewPointId) || typeof value.roomId !== "string"
    || typeof value.createdBy !== "string" || !Array.isArray(value.reviewerIds) || value.reviewerIds.some((id) => typeof id !== "string" || id === "")
    || new Set(value.reviewerIds).size !== value.reviewerIds.length
    || !["open", "changes-requested", "approved", "closed"].includes(value.lifecycle)
    || !Number.isSafeInteger(value.roomEventSeq) || value.roomEventSeq < 0 || typeof value.mainAgentSessionId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.workspaceSnapshotId) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.headOid)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0 || !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 10_000) {
    throw new CollabError("SNAPSHOT_INVALID", "Review Point snapshot is invalid");
  }
  rooms.getRoom(value.roomId);
  const roomMemberIds = new Set(rooms.listMembers(value.roomId).map((member) => member.memberId));
  if (value.reviewerIds.some((memberId) => !roomMemberIds.has(memberId))) {
    throw new CollabError("SNAPSHOT_INVALID", "Review Point reviewer snapshot is invalid");
  }
  requiredText(value.title, "title", 120);
  optionalText(value.focus, "focus", 2_000);
  const paths = new Set<string>();
  for (const file of value.files) {
    if (!file || !isSafeWorkspaceSnapshotPath(file.path) || paths.has(file.path)
      || (file.previousPath !== undefined && !isSafeWorkspaceSnapshotPath(file.previousPath))
      || !["added", "modified", "deleted", "renamed"].includes(file.status)
      || !Number.isSafeInteger(file.additions) || file.additions < 0 || !Number.isSafeInteger(file.deletions) || file.deletions < 0
      || (file.snapshotContentHash !== undefined && !/^[a-f0-9]{64}$/.test(file.snapshotContentHash))) {
      throw new CollabError("SNAPSHOT_INVALID", "Review Point file snapshot is invalid");
    }
    paths.add(file.path);
  }
  return structuredClone(value);
}

function validateDiffs(value: readonly ReviewPointDiff[], point: ReviewPoint): ReviewPointDiff[] {
  if (!Array.isArray(value) || value.length !== point.files.length) throw new CollabError("SNAPSHOT_INVALID", "Review Point diff artifact is invalid");
  let totalTextBytes = 0;
  return value.map((diff, index) => {
    if (!diff || diff.path !== point.files[index]?.path || !isSafeWorkspaceSnapshotPath(diff.path)) {
      throw new CollabError("SNAPSHOT_INVALID", "Review Point diff artifact path is invalid");
    }
    if (diff.kind === "binary") return { path: diff.path, kind: "binary" };
    if (diff.kind === "unavailable") {
      throw new CollabError("SNAPSHOT_INVALID", "Review Point diff artifact is invalid");
    }
    if (diff.kind !== "text" || (diff.oldText !== null && typeof diff.oldText !== "string") || (diff.newText !== null && typeof diff.newText !== "string")) {
      throw new CollabError("SNAPSHOT_INVALID", "Review Point diff artifact content is invalid");
    }
    const oldBytes = diff.oldText === null ? 0 : Buffer.byteLength(diff.oldText);
    const newBytes = diff.newText === null ? 0 : Buffer.byteLength(diff.newText);
    if (oldBytes > 2 * 1024 * 1024 || newBytes > 2 * 1024 * 1024 || (totalTextBytes += oldBytes + newBytes) > 8 * 1024 * 1024) {
      throw new CollabError("SNAPSHOT_INVALID", "Review Point diff artifact exceeds limits");
    }
    return { path: diff.path, kind: "text", oldText: diff.oldText, newText: diff.newText };
  });
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

function lifecycleTransition(current: ReviewLifecycle, next: ReviewLifecycle): boolean {
  if (current === next) return true;
  if (current === "open") return next === "changes-requested" || next === "approved" || next === "closed";
  if (current === "changes-requested") return next === "approved" || next === "closed";
  return current === "approved" && next === "closed";
}

export class ReviewPointService {
  private readonly points: ReviewPoint[] = [];
  private readonly byId = new Map<string, ReviewPoint>();
  private readonly byRoom = new Map<string, ReviewPoint[]>();
  private readonly comparisonSnapshots = new Map<string, string>();
  private readonly reviewDiffs = new Map<string, ReviewPointDiff[]>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly options: ReviewPointServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  static fromSnapshot(options: ReviewPointServiceOptions, snapshot: ReviewPointServiceSnapshot): ReviewPointService {
    if (!snapshot || (snapshot.version !== 1 && snapshot.version !== 2) || !Array.isArray(snapshot.reviewPoints) || !Array.isArray(snapshot.comparisonSnapshots)
      || (snapshot.version === 2 && !Array.isArray(snapshot.reviewDiffs))) {
      throw new CollabError("SNAPSHOT_INVALID", "Review Point snapshot is invalid");
    }
    const service = new ReviewPointService(options);
    for (const raw of snapshot.reviewPoints) {
      const point = validateRestoredPoint(raw, options.rooms);
      if (service.byId.has(point.reviewPointId)) throw new CollabError("SNAPSHOT_INVALID", "Review Point snapshot contains duplicate IDs");
      service.points.push(point);
      service.byId.set(point.reviewPointId, point);
      service.indexRoom(point);
    }
    for (const entry of snapshot.reviewDiffs ?? []) {
      const point = service.byId.get(entry?.reviewPointId);
      if (!point || service.reviewDiffs.has(entry.reviewPointId)) throw new CollabError("SNAPSHOT_INVALID", "Review Point diff snapshot is invalid");
      service.reviewDiffs.set(entry.reviewPointId, validateDiffs(entry.diffs, point));
    }
    for (const point of service.points) {
      if (service.reviewDiffs.has(point.reviewPointId)) continue;
      if (snapshot.version === 2) throw new CollabError("SNAPSHOT_INVALID", "Review Point diff snapshot is invalid or incomplete");
      service.reviewDiffs.set(point.reviewPointId, point.files.map((file) => ({ path: file.path, kind: "unavailable" })));
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
    diffs: readonly ReviewPointDiff[];
  }): ReviewPoint {
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    if (member.role !== "host") throw new CollabError("ACTION_FORBIDDEN", "only the Host can create a Review Point");
    const room = this.options.rooms.getRoom(input.roomId);
    if (!room.hostSessionId) throw new CollabError("ACTION_FORBIDDEN", "Review Point creation requires a Host Session");
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
      const { reviewerIds: _existingReviewers, lifecycle: _existingLifecycle, ...existingCreatePayload } = existing;
      const { reviewerIds: _newReviewers, lifecycle: _newLifecycle, ...newCreatePayload } = point;
      if (JSON.stringify(existingCreatePayload) !== JSON.stringify(newCreatePayload)) throw new CollabError("REQUEST_CONFLICT", "Review Point request conflicts with an existing request");
      return structuredClone(existing);
    }
    const diffs = validateDiffs(input.diffs, point);
    this.points.push(point);
    this.byId.set(point.reviewPointId, point);
    this.indexRoom(point);
    this.comparisonSnapshots.set(room.roomId, captured.snapshotId);
    this.reviewDiffs.set(point.reviewPointId, diffs);
    this.emit();
    return structuredClone(point);
  }

  findCreated(input: {
    roomId: string;
    principalId: string;
    clientRequestId: string;
    title: string;
    focus?: string;
    files: readonly ReviewPointCreateFile[];
  }): ReviewPoint | undefined {
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    if (member.role !== "host") throw new CollabError("ACTION_FORBIDDEN", "only the Host can create a Review Point");
    const id = reviewPointId(input.roomId, input.principalId, requiredText(input.clientRequestId, "clientRequestId", 128));
    const existing = this.byId.get(id);
    if (!existing) return undefined;
    const title = requiredText(input.title, "title", 120);
    const focus = optionalText(input.focus, "focus", 2_000);
    const files = validateCreateFiles(input.files);
    const matches = existing.title === title && existing.focus === focus && existing.files.length === files.length
      && files.every((file, index) => {
        const stored = existing.files[index];
        return stored?.path === file.path && stored.previousPath === file.previousPath && stored.status === file.status
          && stored.additions === file.additions && stored.deletions === file.deletions;
      });
    if (!matches) throw new CollabError("REQUEST_CONFLICT", "Review Point request conflicts with an existing request");
    return structuredClone(existing);
  }

  get(input: { roomId: string; principalId: string; reviewPointId: string }): ReviewPoint {
    this.options.rooms.authorize(input.roomId, input.principalId, "read");
    const point = this.byId.get(input.reviewPointId);
    if (!point || point.roomId !== input.roomId) throw new CollabError("SNAPSHOT_NOT_FOUND", "Review Point does not exist");
    return structuredClone(point);
  }

  getDiff(input: { roomId: string; principalId: string; reviewPointId: string; fileIndex: number }): ReviewPointDiff {
    const point = this.get(input);
    if (!Number.isSafeInteger(input.fileIndex) || input.fileIndex < 0 || input.fileIndex >= point.files.length) throw invalidInput("Review Point diff file index is invalid");
    const diff = this.reviewDiffs.get(point.reviewPointId)?.[input.fileIndex];
    if (!diff) throw new CollabError("SNAPSHOT_NOT_FOUND", "Review Point diff artifact does not exist");
    return structuredClone(diff);
  }

  setWorkflow(input: {
    roomId: string;
    principalId: string;
    reviewPointId: string;
    reviewerIds?: string[];
    lifecycle?: ReviewLifecycle;
  }): ReviewPoint {
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    if (member.role !== "host") throw new CollabError("ACTION_FORBIDDEN", "only the Host can update Review workflow");
    const point = this.byId.get(input.reviewPointId);
    if (!point || point.roomId !== input.roomId) throw new CollabError("SNAPSHOT_NOT_FOUND", "Review Point does not exist");
    const reviewerIds = input.reviewerIds ?? point.reviewerIds;
    const lifecycle = input.lifecycle ?? point.lifecycle;
    if (!Array.isArray(reviewerIds) || reviewerIds.length > 100 || new Set(reviewerIds).size !== reviewerIds.length
      || reviewerIds.some((memberId) => typeof memberId !== "string" || memberId === "")
      || !["open", "changes-requested", "approved", "closed"].includes(lifecycle)) {
      throw invalidInput("Review workflow update is invalid");
    }
    const reviewersChanged = JSON.stringify(reviewerIds) !== JSON.stringify(point.reviewerIds);
    const lifecycleChanged = lifecycle !== point.lifecycle;
    if (!reviewersChanged && !lifecycleChanged) return structuredClone(point);
    if (this.options.rooms.getRoom(input.roomId).state !== "open") {
      throw new CollabError("ACTION_FORBIDDEN", "room is not open for Review workflow changes");
    }
    if (point.lifecycle === "closed") throw new CollabError("ACTION_FORBIDDEN", "Review Point is closed for workflow changes");
    if (reviewersChanged) {
      const activeMemberIds = new Set(this.options.rooms.listMembers(input.roomId).filter((candidate) => candidate.status === "active").map((candidate) => candidate.memberId));
      if (reviewerIds.some((reviewerId) => !activeMemberIds.has(reviewerId))) throw invalidInput("reviewers must be active room members");
    }
    if (lifecycleChanged && !lifecycleTransition(point.lifecycle, lifecycle)) throw new CollabError("REQUEST_CONFLICT", "Review lifecycle transition is not allowed");
    point.reviewerIds = [...reviewerIds];
    point.lifecycle = lifecycle;
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
    const ordered = [...(this.byRoom.get(input.roomId) ?? [])].reverse();
    const start = input.after === undefined ? 0 : ordered.findIndex((point) => point.reviewPointId === input.after) + 1;
    if (input.after !== undefined && start === 0) throw invalidInput("Review Point cursor is invalid");
    const page = ordered.slice(start, start + limit);
    const comparisonId = this.comparisonSnapshots.get(input.roomId);
    const cache = new Map<string, Promise<WorkspaceSnapshotPackage>>();
    const load = async (snapshotId: string): Promise<WorkspaceSnapshotPackage> => {
      const cached = cache.get(snapshotId);
      if (cached) return await cached;
      const loading = this.options.snapshots.load(snapshotId).then((value) => {
        if (!value) throw new CollabError("SNAPSHOT_NOT_FOUND", "Review Point Workspace Snapshot does not exist");
        return validateSnapshotForRoom(value, input.roomId);
      });
      cache.set(snapshotId, loading);
      return await loading;
    };
    const current = comparisonId ? await load(comparisonId) : undefined;
    const reviewPoints = await Promise.all(page.map(async (point): Promise<ReviewPointProjection> => {
      const original = await load(point.workspaceSnapshotId);
      if (original.hostSessionId !== point.mainAgentSessionId) throw new CollabError("SNAPSHOT_INVALID", "Review Point Workspace Snapshot Host Session is invalid");
      const comparison = current ?? original;
      return {
        reviewPoint: structuredClone(point),
        freshness: freshness(point, comparison),
        progress: {
          roomEventDelta: Math.max(0, this.options.ledger.latestSeq(point.roomId) - point.roomEventSeq),
          workspaceChangedFileCount: changedFileCount(original, comparison),
        },
      };
    }));
    const nextCursor = start + page.length < ordered.length ? page.at(-1)?.reviewPointId : undefined;
    return { reviewPoints, ...(nextCursor ? { nextCursor } : {}) };
  }

  snapshot(): ReviewPointServiceSnapshot {
    return {
      version: 2,
      reviewPoints: structuredClone(this.points),
      comparisonSnapshots: [...this.comparisonSnapshots].map(([roomId, snapshotId]) => ({ roomId, snapshotId })),
      reviewDiffs: [...this.reviewDiffs].map(([reviewPointId, diffs]) => ({ reviewPointId, diffs: structuredClone(diffs) })),
    };
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private indexRoom(point: ReviewPoint): void {
    const points = this.byRoom.get(point.roomId) ?? [];
    points.push(point);
    this.byRoom.set(point.roomId, points);
  }
}
