import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDefaultCollabRoomWorkspaceDir } from "./persistence.js";
import { validateWorkspaceSnapshotPackage } from "./workspace-snapshot-store.js";
import { validateWorkspaceVersionRecord, type WorkspaceVersionArtifactStore, type WorkspaceVersionRecord } from "./workspace-versions.js";

interface StoredRoomIdentity {
  version: 1;
  roomId: string;
}

interface StoredBaseManifest {
  version: 1;
  roomId: string;
  record: WorkspaceVersionRecord;
}

export interface RoomWorkspace {
  roomId: string;
  root: string;
  workspacePath: string;
  draftsPath: string;
  baseManifestPath: string;
  record: WorkspaceVersionRecord;
}

function hash(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function requiredRoomId(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("roomId must not be blank");
  return value.trim();
}

function roomDirectory(root: string, roomId: string): string {
  return join(root, hash(roomId));
}

function parseObject(text: string, label: string): Record<string, unknown> {
  try {
    const value = JSON.parse(text) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid object");
    return value as Record<string, unknown>;
  } catch (error) {
    throw new Error(`${label} is malformed`, { cause: error });
  }
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  if (Object.keys(value).some((field) => !allowed.has(field))) throw new Error(`${label} contains an unsupported field`);
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a safe directory`);
}

async function assertFile(path: string, label: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a safe file`);
}

export class RoomWorkspaceMaterializer {
  private readonly root: string;

  constructor(private readonly options: { root?: string; artifacts: WorkspaceVersionArtifactStore }) {
    this.root = options.root ?? resolveDefaultCollabRoomWorkspaceDir();
  }

  async materialize(input: { roomId: string; record: WorkspaceVersionRecord }): Promise<RoomWorkspace> {
    const roomId = requiredRoomId(input.roomId);
    const record = validateWorkspaceVersionRecord(input.record);
    if (record.version.roomId !== roomId) throw new Error("Workspace Version belongs to a different room");
    const existing = await this.open(roomId);
    if (existing) {
      if (existing.record.version.workspaceVersionId !== record.version.workspaceVersionId || JSON.stringify(existing.record) !== JSON.stringify(record)) {
        throw new Error("Room Workspace already uses a different base version");
      }
      return existing;
    }

    const snapshot = await this.options.artifacts.load(record.artifact.snapshotId);
    if (!snapshot) throw new Error("Workspace Version artifact does not exist");
    const validatedSnapshot = validateWorkspaceSnapshotPackage(snapshot, record.artifact.snapshotId);
    if (validatedSnapshot.roomId !== roomId || validatedSnapshot.manifestHash !== record.artifact.manifestHash
      || validatedSnapshot.files.length !== record.version.files.length
      || record.version.files.some((file, index) => {
        const source = validatedSnapshot.files[index];
        return !source || file.path !== source.path || file.contentHash !== source.contentHash || file.size !== source.size;
      })) {
      throw new Error("Workspace Version artifact binding is invalid");
    }

    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const destination = roomDirectory(this.root, roomId);
    const temporary = join(this.root, `.${hash(roomId)}.${randomUUID()}.tmp`);
    const workspacePath = join(temporary, "workspace");
    const draftsPath = join(temporary, "drafts");
    const baseManifestDirectory = join(temporary, "base-manifest");
    try {
      await Promise.all([
        mkdir(workspacePath, { recursive: true, mode: 0o700 }),
        mkdir(draftsPath, { recursive: true, mode: 0o700 }),
        mkdir(baseManifestDirectory, { recursive: true, mode: 0o700 }),
      ]);
      for (const file of record.version.files) {
        const content = await this.options.artifacts.readFile(record.artifact.snapshotId, file.path);
        if (content.byteLength !== file.size || hash(content) !== file.contentHash) throw new Error(`Workspace Version artifact is corrupted: ${file.path}`);
        const target = join(workspacePath, ...file.path.split("/"));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        await writeFile(target, content, { flag: "wx", mode: 0o600 });
      }
      const identity: StoredRoomIdentity = { version: 1, roomId };
      const base: StoredBaseManifest = { version: 1, roomId, record };
      await writeFile(join(temporary, "room.json"), JSON.stringify(identity, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await writeFile(join(baseManifestDirectory, "current.json"), JSON.stringify(base, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      const raced = await this.open(roomId);
      if (raced && raced.record.version.workspaceVersionId === record.version.workspaceVersionId && JSON.stringify(raced.record) === JSON.stringify(record)) return raced;
      throw error;
    }
    const completed = await this.open(roomId);
    if (!completed) throw new Error("Room Workspace disappeared after materialization");
    return completed;
  }

  async open(roomIdValue: string): Promise<RoomWorkspace | undefined> {
    const roomId = requiredRoomId(roomIdValue);
    const root = roomDirectory(this.root, roomId);
    try {
      await access(root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const workspacePath = join(root, "workspace");
    const draftsPath = join(root, "drafts");
    const baseManifestPath = join(root, "base-manifest", "current.json");
    await Promise.all([
      assertDirectory(root, "Room Workspace"),
      assertDirectory(workspacePath, "Room Workspace files"),
      assertDirectory(draftsPath, "Room Workspace drafts"),
      assertDirectory(join(root, "base-manifest"), "Room Workspace base manifest"),
      assertFile(join(root, "room.json"), "Room Workspace identity"),
      assertFile(baseManifestPath, "Room Workspace base manifest"),
    ]);
    const identity = parseObject(await readFile(join(root, "room.json"), "utf8"), "Room Workspace identity");
    exactFields(identity, ["version", "roomId"], "Room Workspace identity");
    if (identity.version !== 1 || identity.roomId !== roomId) throw new Error("Room Workspace identity does not match room");
    const base = parseObject(await readFile(baseManifestPath, "utf8"), "Room Workspace base manifest");
    exactFields(base, ["version", "roomId", "record"], "Room Workspace base manifest");
    if (base.version !== 1 || base.roomId !== roomId) throw new Error("Room Workspace base manifest does not match room");
    const record = validateWorkspaceVersionRecord(base.record);
    if (record.version.roomId !== roomId) throw new Error("Room Workspace base version belongs to a different room");
    return { roomId, root, workspacePath, draftsPath, baseManifestPath, record };
  }
}
