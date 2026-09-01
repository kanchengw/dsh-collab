import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import type { ChangeSetApplyFileState } from "./change-set-apply.js";
import type { ChangeSetIntegrationWorkspace } from "./change-set-integration.js";
import { CollabError } from "./errors.js";
import type { RoomStore } from "./room.js";
import type { DshSessionService } from "./dsh-host.js";
import { createDshRepositoryCommandPort, type DshRepositorySubprocess } from "./repository-inspector.js";
import type { DshFsTarget, DshWorkspaceFileSystem } from "./workspace-snapshot.js";
import { isSafeWorkspaceSnapshotPath } from "./workspace-snapshot-store.js";

const MAX_CHANGE_SET_FILE_BYTES = 2 * 1024 * 1024;

export interface DshCanonicalFileSystem extends DshWorkspaceFileSystem {
  stat(target: DshFsTarget, signal?: AbortSignal): Promise<{ version: unknown; type: "file" | "directory" | "other"; size?: number } | undefined>;
}

export function supportsDshCanonicalWorkspace(fs: DshWorkspaceFileSystem): fs is DshCanonicalFileSystem {
  const candidate = fs as Partial<DshCanonicalFileSystem>;
  return typeof candidate.stat === "function";
}

function isSafePath(path: string): boolean {
  return isSafeWorkspaceSnapshotPath(path) && !path.split("/").includes(".git");
}

export class DshCanonicalWorkspace implements ChangeSetIntegrationWorkspace {
  constructor(private readonly options: {
    rooms: RoomStore;
    sessions: DshSessionService;
    fs: DshCanonicalFileSystem;
    subprocess: DshRepositorySubprocess;
  }) {}

  async inspect(roomId: string, path: string): Promise<ChangeSetApplyFileState | undefined> {
    const bytes = await this.observe(roomId, path);
    if (!bytes) return undefined;
    return { contentHash: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
  }

  async checkPatch(roomId: string, patch: Uint8Array, reverse = false): Promise<boolean> {
    return await this.executePatch(roomId, patch, reverse, false);
  }

  async applyPatch(roomId: string, patch: Uint8Array, reverse = false): Promise<void> {
    await this.executePatch(roomId, patch, reverse, true);
  }

  private async executePatch(roomId: string, patch: Uint8Array, reverse: boolean, apply: boolean): Promise<boolean> {
    if (!(patch instanceof Uint8Array) || patch.byteLength < 1) {
      throw new CollabError("SNAPSHOT_INVALID", "ChangeSet patch is empty or invalid");
    }
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(patch);
    } catch {
      throw new CollabError("SNAPSHOT_INVALID", "ChangeSet patch is not UTF-8 text");
    }
    const room = this.options.rooms.getRoom(roomId);
    const cwd = this.options.sessions.workspacePath?.(room.hostSessionId);
    if (!cwd) throw new CollabError("ACTION_FORBIDDEN", "Host session does not expose a canonical workspace path");
    const discovery = createDshRepositoryCommandPort({ subprocess: this.options.subprocess, cwd });
    const discovered = await discovery.run(["rev-parse", "--show-toplevel"]);
    if (discovered.exitCode !== 0 || discovered.stdout.trim() === "") {
      throw new CollabError("ACTION_FORBIDDEN", "Host workspace is not a Git repository");
    }
    const [repositoryRoot, sessionRoot] = await Promise.all([
      realpath(resolve(discovered.stdout.trim())),
      realpath(resolve(cwd)),
    ]);
    const nested = relative(repositoryRoot, sessionRoot);
    if (nested !== "") {
      throw new CollabError("ACTION_FORBIDDEN", "Host session workspace must be the Git repository root");
    }
    const commands = createDshRepositoryCommandPort({ subprocess: this.options.subprocess, cwd: repositoryRoot });
    const temporary = await mkdtemp(join(tmpdir(), "dsh-collab-apply-"));
    const patchPath = join(temporary, "changeset.diff");
    try {
      await writeFile(patchPath, patch, { flag: "wx", mode: 0o600 });
      const args = ["apply", "--whitespace=nowarn", ...(reverse ? ["--reverse"] : []), "--", patchPath];
      const checked = await commands.run([args[0]!, "--check", ...args.slice(1)]);
      if (checked.exitCode !== 0) {
        if (!apply) return false;
        throw new CollabError("REQUEST_CONFLICT", reverse
          ? "Owner workspace cannot safely roll back the interrupted ChangeSet"
          : "Owner workspace changed before the ChangeSet patch could be applied");
      }
      if (!apply) return true;
      const applied = await commands.run(args);
      if (applied.exitCode !== 0) {
        throw new CollabError("REQUEST_CONFLICT", reverse
          ? "Owner workspace changed while the interrupted ChangeSet was rolling back"
          : "Owner workspace changed while the ChangeSet patch was being applied");
      }
      return true;
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  private async observe(roomId: string, path: string): Promise<Uint8Array | undefined> {
    const resolved = await this.resolveContained(roomId, path);
    const pathInfo = await this.options.fs.lstat(path, { cwd: resolved.cwd });
    if (!pathInfo) return undefined;
    if (pathInfo.type !== "file") throw new CollabError("SNAPSHOT_INVALID", `canonical workspace path is not a regular file: ${path}`);
    const before = await this.options.fs.stat(resolved.target);
    if (!before || before.type !== "file") throw new CollabError("REQUEST_CONFLICT", `Owner workspace changed during ChangeSet integration: ${path}`);
    const bytes = await this.options.fs.readBytes(resolved.target, undefined, MAX_CHANGE_SET_FILE_BYTES);
    const after = await this.options.fs.stat(resolved.target);
    if (!after || after.type !== "file" || after.version !== before.version) {
      throw new CollabError("REQUEST_CONFLICT", `Owner workspace changed during ChangeSet integration: ${path}`);
    }
    return bytes;
  }

  private async resolveContained(roomId: string, path: string): Promise<{ target: DshFsTarget; cwd: string }> {
    if (!isSafePath(path)) throw new CollabError("SNAPSHOT_INVALID", `canonical workspace path is unsafe: ${path}`);
    const room = this.options.rooms.getRoom(roomId);
    const cwd = this.options.sessions.workspacePath?.(room.hostSessionId);
    if (!cwd) throw new CollabError("ACTION_FORBIDDEN", "Host session does not expose a canonical workspace path");
    const [root, target] = await Promise.all([
      this.options.fs.resolve(".", { cwd }),
      this.options.fs.resolve(path, { cwd }),
    ]);
    if (!this.options.fs.contains(root, target)) {
      throw new CollabError("SNAPSHOT_INVALID", `canonical workspace path escapes the Host workspace: ${path}`);
    }
    return { target, cwd };
  }
}
