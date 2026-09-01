import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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

export interface RoomWorkspaceSyncJournalRecord {
  version: 1;
  roomId: string;
  ownerPid: number;
  previousVersionId: string;
  targetVersionId: string;
  backupName: string;
  stagingName: string;
  manifestTempName: string;
}

const WORKSPACE_SYNC_JOURNAL = "workspace-sync.json";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const SYNC_STAGING_NAME = /^\.s-[0-9a-f]{12}$/;

export interface RoomWorkspace {
  roomId: string;
  root: string;
  workspacePath: string;
  draftsPath: string;
  baseManifestPath: string;
  record: WorkspaceVersionRecord;
}

export async function findRoomWorkspaceChangedPaths(workspace: RoomWorkspace): Promise<string[]> {
  const record = validateWorkspaceVersionRecord(workspace.record);
  const actual = new Map<string, "file" | "unsupported">();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === workspace.workspacePath && entry.name === ".git") continue;
      const path = resolve(directory, entry.name);
      const relativePath = relative(workspace.workspacePath, path).split(sep).join("/");
      const info = await lstat(path);
      if (info.isSymbolicLink()) actual.set(relativePath, "unsupported");
      else if (info.isDirectory()) await visit(path);
      else actual.set(relativePath, info.isFile() ? "file" : "unsupported");
    }
  };
  await visit(workspace.workspacePath);

  const expected = new Map(record.version.files.map((file) => [file.path, file]));
  const changed = new Set<string>();
  for (const [path, kind] of actual) {
    const file = expected.get(path);
    if (!file || kind !== "file") {
      changed.add(path);
      continue;
    }
    const content = await readFile(resolve(workspace.workspacePath, ...path.split("/")));
    if (content.byteLength !== file.size || hash(content) !== file.contentHash) changed.add(path);
  }
  for (const path of expected.keys()) {
    if (!actual.has(path)) changed.add(path);
  }
  return [...changed].sort((left, right) => left.localeCompare(right));
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

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function syncJournal(value: unknown, roomId: string): RoomWorkspaceSyncJournalRecord {
  const journal = value as RoomWorkspaceSyncJournalRecord;
  if (!journal || typeof journal !== "object" || Array.isArray(journal)) throw new Error("Room Workspace sync journal is malformed");
  exactFields(journal as unknown as Record<string, unknown>, [
    "version", "roomId", "ownerPid", "previousVersionId", "targetVersionId", "backupName", "stagingName", "manifestTempName",
  ], "Room Workspace sync journal");
  if (journal.version !== 1 || journal.roomId !== roomId || !Number.isSafeInteger(journal.ownerPid) || journal.ownerPid < 1
    || typeof journal.previousVersionId !== "string" || journal.previousVersionId.trim() === ""
    || typeof journal.targetVersionId !== "string" || journal.targetVersionId.trim() === ""
    || !(new RegExp(`^\\.workspace-sync-backup-${UUID}$`)).test(journal.backupName)
    || !SYNC_STAGING_NAME.test(journal.stagingName)
    || !(new RegExp(`^current\\.json\\.sync-${UUID}\\.tmp$`)).test(journal.manifestTempName)) {
    throw new Error("Room Workspace sync journal is invalid");
  }
  return journal;
}

async function recoverInterruptedSync(root: string, roomId: string): Promise<void> {
  const journalPath = join(root, WORKSPACE_SYNC_JOURNAL);
  if (!await exists(journalPath)) return;
  await assertFile(journalPath, "Room Workspace sync journal");
  const journal = syncJournal(parseObject(await readFile(journalPath, "utf8"), "Room Workspace sync journal"), roomId);
  if (processIsAlive(journal.ownerPid)) throw new Error("Room Workspace sync is still running in another process");

  const workspacePath = join(root, "workspace");
  const backupPath = join(root, journal.backupName);
  const stagingPath = join(dirname(dirname(root)), journal.stagingName);
  const manifestTempPath = join(root, "base-manifest", journal.manifestTempName);
  const manifestPath = join(root, "base-manifest", "current.json");
  const base = parseObject(await readFile(manifestPath, "utf8"), "Room Workspace base manifest");
  const record = validateWorkspaceVersionRecord(base.record);
  const currentVersionId = record.version.workspaceVersionId;

  if (currentVersionId === journal.targetVersionId) {
    if (!await exists(workspacePath)) throw new Error("Committed Room Workspace sync is missing its workspace");
  } else if (currentVersionId === journal.previousVersionId) {
    if (await exists(backupPath)) {
      if (await exists(workspacePath)) {
        await assertFile(manifestTempPath, "Room Workspace target manifest");
        const targetBase = parseObject(await readFile(manifestTempPath, "utf8"), "Room Workspace target manifest");
        exactFields(targetBase, ["version", "roomId", "record"], "Room Workspace target manifest");
        if (targetBase.version !== 1 || targetBase.roomId !== roomId) throw new Error("Room Workspace target manifest does not match room");
        const targetRecord = validateWorkspaceVersionRecord(targetBase.record);
        if (targetRecord.version.workspaceVersionId !== journal.targetVersionId) throw new Error("Room Workspace target manifest does not match its sync journal");
        const changed = await findRoomWorkspaceChangedPaths({
          roomId,
          root,
          workspacePath,
          draftsPath: join(root, "drafts"),
          baseManifestPath: manifestTempPath,
          record: targetRecord,
        });
        if (changed.length > 0) throw new Error("Room Workspace changed after the interrupted sync; manual recovery is required");
      }
      const failedPath = join(root, `.workspace-sync-recovery-${randomUUID()}`);
      if (await exists(workspacePath)) await rename(workspacePath, failedPath);
      await rename(backupPath, workspacePath);
      await rm(failedPath, { recursive: true, force: true });
    } else if (!await exists(workspacePath)) {
      throw new Error("Interrupted Room Workspace sync cannot restore its previous workspace");
    }
  } else {
    throw new Error("Room Workspace sync journal does not match its base manifest");
  }

  await Promise.all([
    rm(backupPath, { recursive: true, force: true }),
    rm(stagingPath, { recursive: true, force: true }),
    rm(manifestTempPath, { force: true }),
  ]);
  await rm(journalPath, { force: true });
}

export async function writeRoomWorkspaceSyncJournal(workspace: RoomWorkspace, journal: RoomWorkspaceSyncJournalRecord): Promise<void> {
  const validated = syncJournal(journal, workspace.roomId);
  await writeFile(join(workspace.root, WORKSPACE_SYNC_JOURNAL), JSON.stringify(validated, null, 2) + "\n", { flag: "wx", mode: 0o600 });
}

export async function removeRoomWorkspaceSyncJournal(workspace: RoomWorkspace): Promise<void> {
  await rm(join(workspace.root, WORKSPACE_SYNC_JOURNAL), { force: true });
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
    await assertDirectory(root, "Room Workspace");
    await recoverInterruptedSync(root, roomId);
    const workspacePath = join(root, "workspace");
    const draftsPath = join(root, "drafts");
    const baseManifestPath = join(root, "base-manifest", "current.json");
    await Promise.all([
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
