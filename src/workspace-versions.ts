import { createHash } from "node:crypto";
import { CollabError, invalidInput } from "./errors.js";
import { EventLedger } from "./events.js";
import { RoomStore } from "./room.js";
import type { RoomEvent } from "./types.js";
import type { WorkspaceSnapshotPackage } from "./collaboration-types.js";
import { isSafeWorkspaceSnapshotPath } from "./workspace-snapshot-store.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface WorkspaceVersionFile {
  path: string;
  contentHash: string;
  size: number;
  mode: "text" | "binary";
}

export interface WorkspaceVersion {
  workspaceVersionId: string;
  roomId: string;
  parentVersionId?: string;
  headOid?: string;
  files: WorkspaceVersionFile[];
  createdBy: string;
  createdAt: number;
}

export interface WorkspaceVersionArtifact {
  kind: "workspace-snapshot.v1";
  snapshotId: string;
  manifestHash: string;
  totalBytes: number;
}

export interface WorkspaceVersionRecord {
  version: WorkspaceVersion;
  manifestHash: string;
  artifact: WorkspaceVersionArtifact;
}

export interface CreateWorkspaceVersionInput {
  roomId: string;
  principalId: string;
  snapshotId: string;
  parentVersionId?: string;
}

export interface CreatedWorkspaceVersion {
  record: WorkspaceVersionRecord;
  event: RoomEvent;
  created: boolean;
}

export interface WorkspaceVersionServiceOptions {
  rooms: RoomStore;
  ledger: EventLedger;
  artifacts: WorkspaceVersionArtifactStore;
}

export interface WorkspaceVersionArtifactStore {
  load(snapshotId: string): Promise<WorkspaceSnapshotPackage | undefined>;
  readFile(snapshotId: string, path: string): Promise<Uint8Array>;
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(`${field} must not be blank`, { field });
  return value.trim();
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  if (Object.keys(value).some((field) => !allowed.has(field))) throw invalidInput(`${label} contains an unsupported field`);
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput(`${label} is invalid`);
  return value as Record<string, unknown>;
}

function identifier(value: unknown, field: string): string {
  const normalized = requiredText(value, field);
  if (!ID_PATTERN.test(normalized)) throw invalidInput(`${field} is invalid`, { field });
  return normalized;
}

function contentHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw invalidInput(`${field} is invalid`, { field });
  return value;
}

function safeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw invalidInput(`${field} is invalid`, { field });
  return value as number;
}

function optionalIdentifier(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : identifier(value, field);
}

function validateFile(value: unknown): WorkspaceVersionFile {
  const file = recordValue(value, "Workspace Version file");
  exactFields(file, ["path", "contentHash", "size", "mode"], "Workspace Version file");
  const path = requiredText(file.path, "path");
  if (!isSafeWorkspaceSnapshotPath(path)) throw invalidInput("Workspace Version file path is unsafe", { path });
  if (file.mode !== "text" && file.mode !== "binary") throw invalidInput("Workspace Version file mode is invalid", { path });
  return {
    path,
    contentHash: contentHash(file.contentHash, "contentHash"),
    size: safeInteger(file.size, "size"),
    mode: file.mode,
  };
}

export function validateWorkspaceVersionRecord(value: unknown): WorkspaceVersionRecord {
  const record = recordValue(value, "Workspace Version record");
  exactFields(record, ["version", "manifestHash", "artifact"], "Workspace Version record");
  const rawVersion = recordValue(record.version, "Workspace Version");
  exactFields(rawVersion, ["workspaceVersionId", "roomId", "parentVersionId", "headOid", "files", "createdBy", "createdAt"], "Workspace Version");
  if (!Array.isArray(rawVersion.files)) throw invalidInput("Workspace Version files are invalid");
  const files = rawVersion.files.map(validateFile);
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) throw invalidInput("Workspace Version files must be unique", { path: file.path });
    seen.add(file.path);
  }
  const headOid = rawVersion.headOid;
  if (headOid !== undefined && (typeof headOid !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(headOid))) {
    throw invalidInput("Workspace Version headOid is invalid");
  }
  const parentVersionId = optionalIdentifier(rawVersion.parentVersionId, "parentVersionId");
  const version: WorkspaceVersion = {
    workspaceVersionId: identifier(rawVersion.workspaceVersionId, "workspaceVersionId"),
    roomId: requiredText(rawVersion.roomId, "roomId"),
    ...(parentVersionId ? { parentVersionId } : {}),
    ...(headOid ? { headOid } : {}),
    files,
    createdBy: requiredText(rawVersion.createdBy, "createdBy"),
    createdAt: safeInteger(rawVersion.createdAt, "createdAt"),
  };
  const manifestHash = contentHash(record.manifestHash, "manifestHash");
  if (hash(JSON.stringify(files)) !== manifestHash) throw invalidInput("Workspace Version manifest hash does not match");

  const rawArtifact = recordValue(record.artifact, "Workspace Version artifact");
  exactFields(rawArtifact, ["kind", "snapshotId", "manifestHash", "totalBytes"], "Workspace Version artifact");
  if (rawArtifact.kind !== "workspace-snapshot.v1") throw invalidInput("Workspace Version artifact kind is invalid");
  const artifact: WorkspaceVersionArtifact = {
    kind: "workspace-snapshot.v1",
    snapshotId: identifier(rawArtifact.snapshotId, "artifact.snapshotId"),
    manifestHash: contentHash(rawArtifact.manifestHash, "artifact.manifestHash"),
    totalBytes: safeInteger(rawArtifact.totalBytes, "artifact.totalBytes"),
  };
  const totalBytes = files.reduce((total, file) => total + file.size, 0);
  if (!Number.isSafeInteger(totalBytes) || totalBytes !== artifact.totalBytes) throw invalidInput("Workspace Version artifact size does not match");
  if (artifact.snapshotId !== version.workspaceVersionId) throw invalidInput("Workspace Version artifact identity does not match");
  return structuredClone({ version, manifestHash, artifact });
}

function fileMode(content: Uint8Array): WorkspaceVersionFile["mode"] {
  if (content.includes(0)) return "binary";
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return "text";
  } catch {
    return "binary";
  }
}

function sameRecord(left: WorkspaceVersionRecord, right: WorkspaceVersionRecord): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export class WorkspaceVersionService {
  private readonly byRoom = new Map<string, WorkspaceVersionRecord[]>();
  private readonly events = new Map<string, RoomEvent>();

  constructor(private readonly options: WorkspaceVersionServiceOptions) {
    for (const roomSnapshot of options.ledger.snapshot().rooms) {
      for (const event of roomSnapshot.events) {
        if (event.type !== "workspace-version.published") continue;
        try {
          const record = validateWorkspaceVersionRecord(event.payload);
          const room = options.rooms.getRoom(record.version.roomId);
          const member = options.rooms.listMembers(room.roomId).find((candidate) => candidate.memberId === record.version.createdBy);
          const previous = this.latest(room.roomId);
          if (event.eventId !== `workspace-version:${record.version.workspaceVersionId}`
            || event.roomId !== room.roomId
            || event.createdAt !== record.version.createdAt
            || event.actor.memberId !== member?.memberId
            || event.actor.principalId !== member?.principalId
            || member?.role !== "host"
            || member.principalId !== room.hostId
            || record.version.parentVersionId !== previous?.version.workspaceVersionId
            || this.get(room.roomId, record.version.workspaceVersionId)) {
            throw new Error("event mismatch");
          }
          this.add(record, event);
        } catch (error) {
          throw new CollabError("SNAPSHOT_INVALID", "Workspace Version ledger snapshot is invalid", {
            cause: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  async create(input: CreateWorkspaceVersionInput): Promise<CreatedWorkspaceVersion> {
    const roomId = requiredText(input.roomId, "roomId");
    const principalId = requiredText(input.principalId, "principalId");
    const snapshotId = identifier(input.snapshotId, "snapshotId");
    const parentVersionId = optionalIdentifier(input.parentVersionId, "parentVersionId");
    const member = this.options.rooms.authorize(roomId, principalId, "workspaceVersion");
    const existing = this.get(roomId, snapshotId);
    if (existing) {
      if (existing.version.parentVersionId !== parentVersionId) throw new CollabError("REQUEST_CONFLICT", "Workspace Version parent conflicts with the existing version");
      return { record: existing, event: structuredClone(this.events.get(`${roomId}\0${snapshotId}`)!), created: false };
    }
    const latest = this.latest(roomId);
    if (parentVersionId !== latest?.version.workspaceVersionId) {
      throw invalidInput(latest ? "parentVersionId must identify the latest Workspace Version" : "parentVersionId is not allowed for the first Workspace Version");
    }
    const room = this.options.rooms.getRoom(roomId);
    const snapshot = await this.options.artifacts.load(snapshotId);
    if (!snapshot) throw invalidInput(`Workspace Snapshot ${snapshotId} does not exist`, { snapshotId });
    if (snapshot.roomId !== roomId) throw invalidInput("Workspace Snapshot belongs to a different room", { snapshotId });
    if (snapshot.hostSessionId !== room.hostSessionId) throw invalidInput("Workspace Snapshot belongs to a different Host Session", { snapshotId });

    const files: WorkspaceVersionFile[] = [];
    let totalBytes = 0;
    for (const file of snapshot.files) {
      const content = await this.options.artifacts.readFile(snapshotId, file.path);
      totalBytes += file.size;
      if (!Number.isSafeInteger(totalBytes)) throw invalidInput("Workspace Version is too large");
      files.push({ path: file.path, contentHash: file.contentHash, size: file.size, mode: fileMode(content) });
    }
    const record = validateWorkspaceVersionRecord({
      version: {
        workspaceVersionId: snapshot.snapshotId,
        roomId,
        ...(parentVersionId ? { parentVersionId } : {}),
        ...(snapshot.headOid ? { headOid: snapshot.headOid } : {}),
        files,
        createdBy: member.memberId,
        createdAt: snapshot.createdAt,
      },
      manifestHash: hash(JSON.stringify(files)),
      artifact: {
        kind: "workspace-snapshot.v1",
        snapshotId: snapshot.snapshotId,
        manifestHash: snapshot.manifestHash,
        totalBytes,
      },
    });
    const committed = this.get(roomId, snapshotId);
    if (committed) {
      if (!sameRecord(committed, record)) throw new CollabError("REQUEST_CONFLICT", "Workspace Version conflicts with the existing version");
      return { record: committed, event: structuredClone(this.events.get(`${roomId}\0${snapshotId}`)!), created: false };
    }
    if (parentVersionId !== this.latest(roomId)?.version.workspaceVersionId) {
      throw new CollabError("REQUEST_CONFLICT", "Workspace Version parent is no longer the latest version");
    }
    const event = this.options.ledger.append({
      eventId: `workspace-version:${record.version.workspaceVersionId}`,
      roomId,
      type: "workspace-version.published",
      actor: { memberId: member.memberId, principalId },
      createdAt: record.version.createdAt,
      payload: record,
    });
    this.add(record, event);
    return { record: structuredClone(record), event: structuredClone(event), created: true };
  }

  get(roomId: string, workspaceVersionId: string): WorkspaceVersionRecord | undefined {
    const found = this.byRoom.get(roomId)?.find((record) => record.version.workspaceVersionId === workspaceVersionId);
    return found ? structuredClone(found) : undefined;
  }

  latest(roomId: string): WorkspaceVersionRecord | undefined {
    const records = this.byRoom.get(roomId);
    return records?.length ? structuredClone(records[records.length - 1]!) : undefined;
  }

  list(roomId: string): WorkspaceVersionRecord[] {
    return structuredClone(this.byRoom.get(roomId) ?? []);
  }

  private add(record: WorkspaceVersionRecord, event: RoomEvent): void {
    const records = this.byRoom.get(record.version.roomId) ?? [];
    records.push(structuredClone(record));
    this.byRoom.set(record.version.roomId, records);
    this.events.set(`${record.version.roomId}\0${record.version.workspaceVersionId}`, structuredClone(event));
  }
}
