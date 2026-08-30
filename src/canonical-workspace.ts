import { createHash } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { ChangeSetApplyFileState } from "./change-set-apply.js";
import type { ChangeSetIntegrationWorkspace } from "./change-set-integration.js";
import { CollabError } from "./errors.js";
import type { RoomStore } from "./room.js";
import type { DshSessionService } from "./dsh-host.js";
import type { DshFsTarget, DshWorkspaceFileSystem } from "./workspace-snapshot.js";
import { isSafeWorkspaceSnapshotPath } from "./workspace-snapshot-store.js";

const MAX_CHANGE_SET_FILE_BYTES = 2 * 1024 * 1024;

export interface DshCanonicalFileSystem extends DshWorkspaceFileSystem {
  processPath(target: DshFsTarget): string;
  writeText(target: DshFsTarget, content: string): Promise<unknown>;
}

export function supportsDshCanonicalWorkspace(fs: DshWorkspaceFileSystem): fs is DshCanonicalFileSystem {
  const candidate = fs as Partial<DshCanonicalFileSystem>;
  return typeof candidate.processPath === "function" && typeof candidate.writeText === "function";
}

function isSafePath(path: string): boolean {
  return isSafeWorkspaceSnapshotPath(path) && !path.split("/").includes(".git");
}

export class DshCanonicalWorkspace implements ChangeSetIntegrationWorkspace {
  constructor(private readonly options: {
    rooms: RoomStore;
    sessions: DshSessionService;
    fs: DshCanonicalFileSystem;
  }) {}

  async inspect(roomId: string, path: string): Promise<ChangeSetApplyFileState | undefined> {
    const file = await this.resolveFile(roomId, path);
    if (!file) return undefined;
    const bytes = await this.options.fs.readBytes(file.target, undefined, MAX_CHANGE_SET_FILE_BYTES);
    return { contentHash: createHash("sha256").update(bytes).digest("hex"), size: bytes.byteLength };
  }

  forRoom(roomId: string) {
    return {
      read: async (path: string): Promise<Uint8Array | undefined> => {
        const file = await this.resolveFile(roomId, path);
        return file ? await this.options.fs.readBytes(file.target, undefined, MAX_CHANGE_SET_FILE_BYTES) : undefined;
      },
      replace: async (path: string, bytes: Uint8Array): Promise<void> => {
        const target = await this.resolveContained(roomId, path);
        const info = await this.options.fs.lstat(path, { cwd: target.cwd });
        if (info && info.type !== "file") throw new CollabError("SNAPSHOT_INVALID", `canonical workspace target is not a regular file: ${path}`);
        let content: string;
        try {
          content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
        } catch {
          throw new CollabError("SNAPSHOT_INVALID", `ChangeSet result is not UTF-8 text: ${path}`);
        }
        await this.options.fs.writeText(target.target, content);
      },
      remove: async (path: string): Promise<void> => {
        const target = await this.resolveContained(roomId, path);
        const info = await this.options.fs.lstat(path, { cwd: target.cwd });
        if (!info) return;
        if (info.type !== "file") throw new CollabError("SNAPSHOT_INVALID", `canonical workspace target is not a regular file: ${path}`);
        try {
          await unlink(this.options.fs.processPath(target.target));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      },
    };
  }

  private async resolveFile(roomId: string, path: string): Promise<{ target: DshFsTarget; cwd: string } | undefined> {
    const resolved = await this.resolveContained(roomId, path);
    const info = await this.options.fs.lstat(path, { cwd: resolved.cwd });
    if (!info) return undefined;
    if (info.type !== "file") throw new CollabError("SNAPSHOT_INVALID", `canonical workspace path is not a regular file: ${path}`);
    return resolved;
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
