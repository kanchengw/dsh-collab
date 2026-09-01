import { randomUUID } from "node:crypto";
import { cp, lstat, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createDshRepositoryCommandPort, RepositoryInspector, type DshRepositorySubprocess, type RepositoryCommandPort, type RepositoryCommandResult } from "./repository-inspector.js";
import { findRoomWorkspaceChangedPaths, removeRoomWorkspaceSyncJournal, RoomWorkspaceMaterializer, writeRoomWorkspaceSyncJournal, type RoomWorkspace } from "./room-workspace.js";
import { validateWorkspaceVersionRecord, type WorkspaceVersionArtifactStore, type WorkspaceVersionRecord } from "./workspace-versions.js";

export type RoomWorkspaceSyncResult =
  | { status: "current"; versionId: string; workspace: RoomWorkspace }
  | { status: "blocked"; reason: "dirty"; currentVersionId: string; targetVersionId: string; paths: string[] }
  | { status: "advanced"; previousVersionId: string; versionId: string; workspace: RoomWorkspace };

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function failure(command: string, result: RepositoryCommandResult): Error {
  const detail = result.stderr.trim();
  return new Error(`git ${command} failed with exit code ${String(result.exitCode)}${detail === "" ? "" : `: ${detail}`}`);
}

async function requiredRun(commands: RepositoryCommandPort, argv: readonly string[]): Promise<RepositoryCommandResult> {
  const result = await commands.run(argv);
  if (result.exitCode !== 0) throw failure(argv.join(" "), result);
  return result;
}

async function configValue(commands: RepositoryCommandPort, key: string): Promise<string | undefined> {
  const result = await commands.run(["config", "--local", "--get", key]);
  if (result.exitCode === 1) return undefined;
  if (result.exitCode !== 0) throw failure(`config --local --get ${key}`, result);
  return result.stdout.trim();
}

async function assertBaselineIdentity(commands: RepositoryCommandPort, workspace: RoomWorkspace): Promise<void> {
  const [roomId, workspaceVersionId] = await Promise.all([
    configValue(commands, "collab.roomid"),
    configValue(commands, "collab.workspaceversion"),
  ]);
  if (roomId !== workspace.roomId || workspaceVersionId !== workspace.record.version.workspaceVersionId) {
    throw new Error("Room Workspace Git baseline identity does not match its base version");
  }
}

async function amendBaseline(commands: RepositoryCommandPort, target: WorkspaceVersionRecord): Promise<void> {
  await requiredRun(commands, ["config", "--local", "collab.workspaceversion", target.version.workspaceVersionId]);
  await requiredRun(commands, ["add", "--all"]);
  await requiredRun(commands, [
    "-c", "user.name=DSH Collab",
    "-c", "user.email=dsh-collab@localhost",
    "commit", "--amend", "--allow-empty", "--no-edit", "--no-gpg-sign", "--no-verify",
  ]);
  const status = await requiredRun(commands, ["status", "--short"]);
  if (status.stdout !== "") throw new Error("Synthetic Git baseline is not clean after fast-forward");
}

async function dirtyPaths(workspace: RoomWorkspace, subprocess: DshRepositorySubprocess): Promise<string[]> {
  const commands = createDshRepositoryCommandPort({ subprocess, cwd: workspace.workspacePath });
  await assertBaselineIdentity(commands, workspace);
  const inspection = await new RepositoryInspector(commands).inspect();
  if (inspection.kind !== "repository") throw new Error("Room Workspace synthetic Git baseline is missing");
  const paths = new Set(await findRoomWorkspaceChangedPaths(workspace));
  for (const file of inspection.files) paths.add(file.path);
  return [...paths].sort((left, right) => left.localeCompare(right));
}

interface RoomWorkspaceSyncInput {
  roomId: string;
  target: WorkspaceVersionRecord;
}

export class RoomWorkspaceSyncService {
  private readonly syncing = new Set<string>();

  constructor(private readonly options: {
    roomWorkspaces: { open(roomId: string): Promise<RoomWorkspace | undefined> };
    artifacts: WorkspaceVersionArtifactStore;
    subprocess: DshRepositorySubprocess;
  }) {}

  async sync(input: RoomWorkspaceSyncInput): Promise<RoomWorkspaceSyncResult> {
    return await this.runExclusive(input, false);
  }

  async discardAndSync(input: RoomWorkspaceSyncInput): Promise<RoomWorkspaceSyncResult> {
    return await this.runExclusive(input, true);
  }

  private async runExclusive(input: RoomWorkspaceSyncInput, discardLocalChanges: boolean): Promise<RoomWorkspaceSyncResult> {
    if (this.syncing.has(input.roomId)) throw new Error("Room Workspace sync is already running");
    this.syncing.add(input.roomId);
    try {
      return await this.syncRoom(input, discardLocalChanges);
    } finally {
      this.syncing.delete(input.roomId);
    }
  }

  private async syncRoom(input: RoomWorkspaceSyncInput, discardLocalChanges: boolean): Promise<RoomWorkspaceSyncResult> {
    const target = validateWorkspaceVersionRecord(input.target);
    if (target.version.roomId !== input.roomId) throw new Error("Target Workspace Version belongs to a different room");
    const current = await this.options.roomWorkspaces.open(input.roomId);
    if (!current) throw new Error("Room Workspace does not exist");
    const currentVersionId = current.record.version.workspaceVersionId;
    const targetVersionId = target.version.workspaceVersionId;
    if (targetVersionId === currentVersionId) {
      if (JSON.stringify(target) !== JSON.stringify(current.record)) throw new Error("Current Workspace Version identity conflicts with its base manifest");
      return { status: "current", versionId: currentVersionId, workspace: current };
    }
    if (target.version.parentVersionId !== currentVersionId) {
      throw new Error("Target Workspace Version is not a direct successor of the current base");
    }

    const currentDirtyPaths = await dirtyPaths(current, this.options.subprocess);
    if (!discardLocalChanges && currentDirtyPaths.length > 0) {
      return {
        status: "blocked",
        reason: "dirty",
        currentVersionId,
        targetVersionId,
        paths: currentDirtyPaths,
      };
    }

    const transactionId = randomUUID();
    const stagingName = `.s-${transactionId.replaceAll("-", "").slice(0, 12)}`;
    const backupName = `.workspace-sync-backup-${transactionId}`;
    const manifestTempName = `current.json.sync-${transactionId}.tmp`;
    const stagingRoot = join(dirname(dirname(current.root)), stagingName);
    const backupWorkspace = join(current.root, backupName);
    const failedWorkspace = join(current.root, `.workspace-sync-failed-${randomUUID()}`);
    const manifestTemp = join(dirname(current.baseManifestPath), manifestTempName);
    let backupCreated = false;
    let replacementVisible = false;
    let committed = false;
    try {
      const staged = await new RoomWorkspaceMaterializer({ root: stagingRoot, artifacts: this.options.artifacts })
        .materialize({ roomId: input.roomId, record: target });
      const gitMetadata = await lstat(join(current.workspacePath, ".git"));
      if (!gitMetadata.isDirectory() || gitMetadata.isSymbolicLink()) {
        throw new Error("Room Workspace synthetic Git metadata is not a local directory");
      }
      await cp(join(current.workspacePath, ".git"), join(staged.workspacePath, ".git"), { recursive: true, errorOnExist: true });
      await amendBaseline(createDshRepositoryCommandPort({ subprocess: this.options.subprocess, cwd: staged.workspacePath }), target);
      await writeFile(manifestTemp, JSON.stringify({ version: 1, roomId: input.roomId, record: target }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await writeRoomWorkspaceSyncJournal(current, {
        version: 1,
        roomId: input.roomId,
        ownerPid: process.pid,
        previousVersionId: currentVersionId,
        targetVersionId,
        backupName,
        stagingName,
        manifestTempName,
      });

      await rename(current.workspacePath, backupWorkspace);
      backupCreated = true;
      if (!discardLocalChanges) {
        const lateDirtyPaths = await dirtyPaths({ ...current, workspacePath: backupWorkspace }, this.options.subprocess);
        if (lateDirtyPaths.length > 0) {
          await rename(backupWorkspace, current.workspacePath);
          backupCreated = false;
          await Promise.all([
            rm(manifestTemp, { force: true }),
            rm(stagingRoot, { recursive: true, force: true }),
          ]);
          await removeRoomWorkspaceSyncJournal(current);
          return { status: "blocked", reason: "dirty", currentVersionId, targetVersionId, paths: lateDirtyPaths };
        }
      }
      await rename(staged.workspacePath, current.workspacePath);
      replacementVisible = true;
      await rename(manifestTemp, current.baseManifestPath);
      committed = true;

      await Promise.all([
        rm(backupWorkspace, { recursive: true, force: true }),
        rm(stagingRoot, { recursive: true, force: true }),
      ]).catch(() => undefined);
      await removeRoomWorkspaceSyncJournal(current);
    } catch (error) {
      await rm(manifestTemp, { force: true }).catch(() => undefined);
      if (!committed && backupCreated) {
        if (replacementVisible || await exists(current.workspacePath)) await rename(current.workspacePath, failedWorkspace);
        await rename(backupWorkspace, current.workspacePath);
        await rm(failedWorkspace, { recursive: true, force: true }).catch(() => undefined);
      }
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      if (!committed && (!backupCreated || await exists(current.workspacePath))) {
        await removeRoomWorkspaceSyncJournal(current).catch(() => undefined);
      }
      throw error;
    }

    const workspace = await this.options.roomWorkspaces.open(input.roomId);
    if (!workspace) throw new Error("Room Workspace disappeared after fast-forward");
    return { status: "advanced", previousVersionId: currentVersionId, versionId: targetVersionId, workspace };
  }
}
