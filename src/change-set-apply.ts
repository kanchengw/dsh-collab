import { createHash } from "node:crypto";
import type { ChangeSetReview } from "./change-set-reviews.js";
import type { StagedChangeSet } from "./change-set-staging.js";
import type { ChangeSetDraftFile } from "./change-sets.js";
import { CollabError } from "./errors.js";
import type { RoomStore } from "./room.js";
import { isSafeWorkspaceSnapshotPath } from "./workspace-snapshot-store.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface ChangeSetApplyFileState {
  contentHash: string;
  size: number;
}

export interface ChangeSetApplyWorkspaceReader {
  inspect(roomId: string, path: string): Promise<ChangeSetApplyFileState | undefined>;
}

export interface ChangeSetApplyStagingReader {
  get(roomId: string, changeSetId: string): Promise<StagedChangeSet | undefined>;
  readResult(roomId: string, changeSetId: string, path: string): Promise<Uint8Array>;
}

export interface ChangeSetApplyReviewReader {
  getReview(input: { roomId: string; principalId: string; changeSetId: string }): Promise<ChangeSetReview>;
}

export interface ChangeSetApplyPlanOperation {
  path: string;
  previousPath?: string;
  operation: ChangeSetDraftFile["operation"];
  base?: { path: string; contentHash: string; size: number };
  result?: { contentHash: string; size: number; bytes: Uint8Array };
}

export interface ChangeSetApplyPlan {
  roomId: string;
  changeSetId: string;
  baseWorkspaceVersionId: string;
  operations: ChangeSetApplyPlanOperation[];
}

export type ChangeSetApplyConflictKind = "base-missing" | "base-changed" | "target-exists";

export interface ChangeSetApplyConflictItem {
  path: string;
  kind: ChangeSetApplyConflictKind;
  expectedContentHash?: string;
  expectedSize?: number;
  actualContentHash?: string;
  actualSize?: number;
}

export interface ChangeSetApplyConflictRecord {
  version: 1;
  conflictId: string;
  roomId: string;
  changeSetId: string;
  baseWorkspaceVersionId: string;
  detectedBy: string;
  conflicts: ChangeSetApplyConflictItem[];
  createdAt: number;
}

export interface ChangeSetApplyPreflightServiceSnapshot {
  version: 1;
  conflicts: ChangeSetApplyConflictRecord[];
}

export type ChangeSetApplyPreflightResult =
  | { outcome: "ready"; plan: ChangeSetApplyPlan }
  | { outcome: "conflicted"; conflict: ChangeSetApplyConflictRecord };

export interface ChangeSetApplyConflictEvent {
  type: "changeset.apply-conflicted";
  roomId: string;
  conflict: ChangeSetApplyConflictRecord;
}

interface ChangeSetApplyPreflightServiceOptions {
  rooms: RoomStore;
  changeSets: ChangeSetApplyStagingReader;
  reviews: ChangeSetApplyReviewReader;
  workspace: ChangeSetApplyWorkspaceReader;
  now?: () => number;
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isSafePath(path: string): boolean {
  return isSafeWorkspaceSnapshotPath(path) && !path.split("/").includes(".git");
}

function invalidSnapshot(message: string): CollabError {
  return new CollabError("SNAPSHOT_INVALID", message);
}

function validateFileState(value: ChangeSetApplyFileState | undefined): ChangeSetApplyFileState | undefined {
  if (value === undefined) return undefined;
  if (!HASH_PATTERN.test(value.contentHash) || !Number.isSafeInteger(value.size) || value.size < 0) {
    throw invalidSnapshot("Owner workspace file state is invalid");
  }
  return { contentHash: value.contentHash, size: value.size };
}

function validateFile(file: ChangeSetDraftFile): void {
  if (!file || !isSafePath(file.path) || !["add", "modify", "delete", "rename"].includes(file.operation)
    || (file.previousPath !== undefined && !isSafePath(file.previousPath))) {
    throw invalidSnapshot("Staged ChangeSet contains an unsafe or invalid path");
  }
  const baseDeclared = file.baseContentHash !== undefined || file.baseSize !== undefined;
  const resultDeclared = file.resultContentHash !== undefined || file.resultSize !== undefined;
  const hasBase = HASH_PATTERN.test(file.baseContentHash ?? "") && Number.isSafeInteger(file.baseSize) && file.baseSize! >= 0;
  const hasResult = HASH_PATTERN.test(file.resultContentHash ?? "") && Number.isSafeInteger(file.resultSize) && file.resultSize! >= 0;
  if (baseDeclared !== hasBase || resultDeclared !== hasResult) throw invalidSnapshot("Staged ChangeSet file hashes or sizes are invalid");
  if ((file.operation === "add" && (hasBase || !hasResult || file.previousPath !== undefined))
    || (file.operation === "modify" && (!hasBase || !hasResult || file.previousPath !== undefined))
    || (file.operation === "delete" && (!hasBase || hasResult || file.previousPath !== undefined))
    || (file.operation === "rename" && (!hasBase || !hasResult || file.previousPath === undefined || file.previousPath === file.path))) {
    throw invalidSnapshot("Staged ChangeSet file operation is invalid");
  }
}

function validateChangeSet(value: StagedChangeSet | undefined, roomId: string, changeSetId: string): StagedChangeSet {
  if (!value) throw new CollabError("CHANGE_SET_NOT_FOUND", "ChangeSet does not exist");
  if (value.version !== 1 || value.changeSetId !== changeSetId || !value.draft || value.draft.draftId !== changeSetId
    || value.draft.roomId !== roomId || typeof value.draft.authorId !== "string" || value.draft.authorId === ""
    || typeof value.draft.baseWorkspaceVersionId !== "string" || value.draft.baseWorkspaceVersionId === ""
    || !Array.isArray(value.draft.files) || value.draft.files.length === 0
    || !Number.isSafeInteger(value.submittedAt) || value.submittedAt < 0) {
    throw invalidSnapshot("Staged ChangeSet envelope is invalid");
  }
  const targets = new Set<string>();
  const bases = new Set<string>();
  for (const file of value.draft.files) {
    validateFile(file);
    const basePath = file.previousPath ?? file.path;
    if (targets.has(file.path) || (file.baseContentHash !== undefined && bases.has(basePath))) {
      throw invalidSnapshot("Staged ChangeSet contains duplicate paths");
    }
    targets.add(file.path);
    if (file.baseContentHash !== undefined) bases.add(basePath);
  }
  return structuredClone(value);
}

function validateApprovedReview(review: ChangeSetReview, changeSet: StagedChangeSet): void {
  if (!review || review.roomId !== changeSet.draft.roomId || review.changeSetId !== changeSet.changeSetId
    || review.authorId !== changeSet.draft.authorId) {
    throw invalidSnapshot("ChangeSet Review does not match its staged ChangeSet");
  }
  if (review.status !== "approved") throw new CollabError("REQUEST_STATE", "ChangeSet must be approved before apply preflight");
  if (!review.decision || review.decision.roomId !== review.roomId || review.decision.changeSetId !== review.changeSetId
    || review.decision.outcome !== "approved" || review.decision.reviewerId !== review.requiredReviewerId) {
    throw invalidSnapshot("Approved ChangeSet Review decision is invalid");
  }
}

function conflictIdentity(record: Omit<ChangeSetApplyConflictRecord, "version" | "conflictId" | "createdAt">): string {
  return hash(JSON.stringify(record));
}

function validateConflictRecord(value: ChangeSetApplyConflictRecord, rooms: RoomStore): ChangeSetApplyConflictRecord {
  if (!value || value.version !== 1 || !HASH_PATTERN.test(value.conflictId) || typeof value.roomId !== "string" || value.roomId === ""
    || !HASH_PATTERN.test(value.changeSetId) || typeof value.baseWorkspaceVersionId !== "string" || value.baseWorkspaceVersionId === ""
    || typeof value.detectedBy !== "string" || !Array.isArray(value.conflicts) || value.conflicts.length === 0
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) {
    throw invalidSnapshot("ChangeSet apply conflict snapshot is invalid");
  }
  rooms.getRoom(value.roomId);
  if (!rooms.listMembers(value.roomId).some((member) => member.memberId === value.detectedBy)) {
    throw invalidSnapshot("ChangeSet apply conflict actor is invalid");
  }
  for (const item of value.conflicts) {
    if (!item || !isSafePath(item.path) || !["base-missing", "base-changed", "target-exists"].includes(item.kind)
      || (item.expectedContentHash !== undefined && !HASH_PATTERN.test(item.expectedContentHash))
      || (item.actualContentHash !== undefined && !HASH_PATTERN.test(item.actualContentHash))
      || (item.expectedSize !== undefined && (!Number.isSafeInteger(item.expectedSize) || item.expectedSize < 0))
      || (item.actualSize !== undefined && (!Number.isSafeInteger(item.actualSize) || item.actualSize < 0))) {
      throw invalidSnapshot("ChangeSet apply conflict item is invalid");
    }
  }
  const identityInput = {
    roomId: value.roomId,
    changeSetId: value.changeSetId,
    baseWorkspaceVersionId: value.baseWorkspaceVersionId,
    detectedBy: value.detectedBy,
    conflicts: value.conflicts,
  };
  if (conflictIdentity(identityInput) !== value.conflictId) throw invalidSnapshot("ChangeSet apply conflict identity is invalid");
  return structuredClone(value);
}

export class ChangeSetApplyPreflightService {
  private readonly conflicts = new Map<string, ChangeSetApplyConflictRecord>();
  private readonly listeners = new Set<(event: ChangeSetApplyConflictEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly options: ChangeSetApplyPreflightServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  static fromSnapshot(options: ChangeSetApplyPreflightServiceOptions, snapshot: ChangeSetApplyPreflightServiceSnapshot): ChangeSetApplyPreflightService {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.conflicts)) throw invalidSnapshot("ChangeSet apply preflight snapshot is invalid");
    const service = new ChangeSetApplyPreflightService(options);
    for (const raw of snapshot.conflicts) {
      let conflict: ChangeSetApplyConflictRecord;
      try {
        conflict = validateConflictRecord(raw, options.rooms);
      } catch (error) {
        if (error instanceof CollabError && error.code === "SNAPSHOT_INVALID") throw error;
        throw invalidSnapshot("ChangeSet apply preflight snapshot is invalid");
      }
      if (service.conflicts.has(conflict.conflictId)) throw invalidSnapshot("ChangeSet apply preflight snapshot contains duplicate conflicts");
      service.conflicts.set(conflict.conflictId, conflict);
    }
    return service;
  }

  subscribe(listener: (event: ChangeSetApplyConflictEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async preflight(input: { roomId: string; principalId: string; changeSetId: string }): Promise<ChangeSetApplyPreflightResult> {
    const actor = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    if (actor.role !== "host") throw new CollabError("ACTION_FORBIDDEN", "only the Owner can preflight a ChangeSet apply");
    const changeSet = validateChangeSet(await this.options.changeSets.get(input.roomId, input.changeSetId), input.roomId, input.changeSetId);
    validateApprovedReview(await this.options.reviews.getReview(input), changeSet);

    const operations: ChangeSetApplyPlanOperation[] = [];
    const conflicts: ChangeSetApplyConflictItem[] = [];
    for (const file of changeSet.draft.files) {
      const basePath = file.previousPath ?? file.path;
      const currentBase = file.baseContentHash === undefined
        ? undefined
        : validateFileState(await this.options.workspace.inspect(input.roomId, basePath));
      if (file.baseContentHash !== undefined) {
        if (!currentBase) {
          conflicts.push({ path: basePath, kind: "base-missing", expectedContentHash: file.baseContentHash, expectedSize: file.baseSize });
        } else if (currentBase.contentHash !== file.baseContentHash || currentBase.size !== file.baseSize) {
          conflicts.push({
            path: basePath,
            kind: "base-changed",
            expectedContentHash: file.baseContentHash,
            expectedSize: file.baseSize,
            actualContentHash: currentBase.contentHash,
            actualSize: currentBase.size,
          });
        }
      }
      if (file.operation === "add" || file.operation === "rename") {
        const target = validateFileState(await this.options.workspace.inspect(input.roomId, file.path));
        if (target) conflicts.push({ path: file.path, kind: "target-exists", actualContentHash: target.contentHash, actualSize: target.size });
      }

      let result: ChangeSetApplyPlanOperation["result"];
      if (file.resultContentHash !== undefined) {
        let bytes: Uint8Array;
        try {
          bytes = await this.options.changeSets.readResult(input.roomId, input.changeSetId, file.path);
        } catch {
          throw invalidSnapshot(`Staged ChangeSet result cannot be read: ${file.path}`);
        }
        if (bytes.byteLength !== file.resultSize || hash(bytes) !== file.resultContentHash) {
          throw invalidSnapshot(`Staged ChangeSet result does not match its manifest: ${file.path}`);
        }
        result = { contentHash: file.resultContentHash, size: file.resultSize!, bytes: structuredClone(bytes) };
      }
      operations.push({
        path: file.path,
        ...(file.previousPath ? { previousPath: file.previousPath } : {}),
        operation: file.operation,
        ...(file.baseContentHash ? { base: { path: basePath, contentHash: file.baseContentHash, size: file.baseSize! } } : {}),
        ...(result ? { result } : {}),
      });
    }

    if (conflicts.length > 0) return { outcome: "conflicted", conflict: this.recordConflict(changeSet, actor.memberId, conflicts) };
    return {
      outcome: "ready",
      plan: {
        roomId: input.roomId,
        changeSetId: input.changeSetId,
        baseWorkspaceVersionId: changeSet.draft.baseWorkspaceVersionId,
        operations,
      },
    };
  }

  listConflicts(roomId: string, changeSetId: string): ChangeSetApplyConflictRecord[] {
    return structuredClone([...this.conflicts.values()].filter((conflict) => conflict.roomId === roomId && conflict.changeSetId === changeSetId));
  }

  snapshot(): ChangeSetApplyPreflightServiceSnapshot {
    return { version: 1, conflicts: structuredClone([...this.conflicts.values()]) };
  }

  private recordConflict(changeSet: StagedChangeSet, detectedBy: string, conflicts: ChangeSetApplyConflictItem[]): ChangeSetApplyConflictRecord {
    const identityInput = {
      roomId: changeSet.draft.roomId,
      changeSetId: changeSet.changeSetId,
      baseWorkspaceVersionId: changeSet.draft.baseWorkspaceVersionId,
      detectedBy,
      conflicts: structuredClone(conflicts),
    };
    const conflictId = conflictIdentity(identityInput);
    const existing = this.conflicts.get(conflictId);
    if (existing) return structuredClone(existing);
    const createdAt = this.now();
    if (!Number.isSafeInteger(createdAt) || createdAt < 0) throw new Error("ChangeSet apply conflict timestamp is invalid");
    const conflict: ChangeSetApplyConflictRecord = { version: 1, conflictId, ...identityInput, createdAt };
    this.conflicts.set(conflictId, conflict);
    const event: ChangeSetApplyConflictEvent = { type: "changeset.apply-conflicted", roomId: conflict.roomId, conflict: structuredClone(conflict) };
    for (const listener of this.listeners) listener(event);
    return structuredClone(conflict);
  }
}
