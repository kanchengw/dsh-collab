import { createHash, randomUUID } from "node:crypto";
import type { WorkspaceSnapshotFile, WorkspaceSnapshotPackage } from "./collaboration-types.js";
import type { RepositoryCommandPort, RepositoryCommandResult } from "./repository-inspector.js";
import { WorkspaceSnapshotStore } from "./workspace-snapshot-store.js";

export type WorkspaceFileInspection = "file" | "missing" | "symlink" | "other" | "outside";

export interface WorkspaceFilePort {
  inspect(path: string, signal?: AbortSignal): Promise<WorkspaceFileInspection>;
  read(path: string, signal?: AbortSignal, maxBytes?: number): Promise<Uint8Array>;
}

export type WorkspaceSnapshotErrorCode = "WORKSPACE_NOT_GIT" | "WORKSPACE_PATH_UNSAFE" | "WORKSPACE_CAPTURE_FAILED" | "WORKSPACE_LIMIT";

export class WorkspaceSnapshotError extends Error {
  constructor(readonly code: WorkspaceSnapshotErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "WorkspaceSnapshotError";
  }
}

function hash(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function commandFailure(command: string, result: RepositoryCommandResult): WorkspaceSnapshotError {
  const detail = result.stderr.trim();
  return new WorkspaceSnapshotError(
    "WORKSPACE_CAPTURE_FAILED",
    `git ${command} failed with exit code ${String(result.exitCode)}${detail === "" ? "" : `: ${detail}`}`,
  );
}

function paths(output: string): string[] {
  return output.split("\0").filter((path) => path !== "");
}

function assertSafePath(path: string): void {
  const segments = path.split("/");
  if (path === "" || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || path.includes("\\") || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new WorkspaceSnapshotError("WORKSPACE_PATH_UNSAFE", `Workspace path is unsafe: ${path}`);
  }
}

function isGitMetadata(path: string): boolean {
  return path === ".git" || path.startsWith(".git/");
}

export class WorkspaceSnapshotCapture {
  private readonly now: () => number;
  private readonly snapshotIdFactory: () => string;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalBytes: number;

  constructor(private readonly options: {
    commands: RepositoryCommandPort;
    files: WorkspaceFilePort;
    store: WorkspaceSnapshotStore;
    now?: () => number;
    snapshotIdFactory?: () => string;
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalBytes?: number;
  }) {
    this.now = options.now ?? (() => Date.now());
    this.snapshotIdFactory = options.snapshotIdFactory ?? randomUUID;
    this.maxFiles = options.maxFiles ?? 10_000;
    this.maxFileBytes = options.maxFileBytes ?? 64 * 1024 * 1024;
    this.maxTotalBytes = options.maxTotalBytes ?? 256 * 1024 * 1024;
    for (const [name, value] of [["maxFiles", this.maxFiles], ["maxFileBytes", this.maxFileBytes], ["maxTotalBytes", this.maxTotalBytes]] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
    }
  }

  async capture(input: { roomId: string; hostSessionId: string; roomEventSeq: number; snapshotId?: string; signal?: AbortSignal }): Promise<WorkspaceSnapshotPackage> {
    const root = await this.options.commands.run(["rev-parse", "--show-toplevel"], input.signal);
    if (root.exitCode !== 0) {
      if (/not a git repository/i.test(root.stderr)) {
        throw new WorkspaceSnapshotError("WORKSPACE_NOT_GIT", "Workspace Snapshot requires a Git repository");
      }
      throw commandFailure("rev-parse", root);
    }
    const head = await this.options.commands.run(["rev-parse", "--verify", "--quiet", "HEAD"], input.signal);
    if (head.exitCode !== 0 && head.exitCode !== 1) throw commandFailure("rev-parse HEAD", head);
    const tracked = await this.options.commands.run(["ls-files", "-z", "--cached"], input.signal);
    if (tracked.exitCode !== 0) throw commandFailure("ls-files --cached", tracked);
    const untracked = await this.options.commands.run(["ls-files", "-z", "--others", "--exclude-standard"], input.signal);
    if (untracked.exitCode !== 0) throw commandFailure("ls-files --others", untracked);

    const candidates = new Map<string, WorkspaceSnapshotFile["source"]>();
    for (const path of paths(tracked.stdout)) candidates.set(path, "tracked");
    for (const path of paths(untracked.stdout)) if (!candidates.has(path)) candidates.set(path, "untracked");
    const contents = new Map<string, Uint8Array>();
    const files: WorkspaceSnapshotFile[] = [];
    let totalBytes = 0;
    for (const [path, source] of [...candidates].sort(([left], [right]) => left.localeCompare(right))) {
      assertSafePath(path);
      if (isGitMetadata(path)) continue;
      const inspection = await this.options.files.inspect(path, input.signal);
      if (inspection === "missing" || inspection === "symlink" || inspection === "other") continue;
      if (inspection === "outside") throw new WorkspaceSnapshotError("WORKSPACE_PATH_UNSAFE", `Workspace path escapes repository root: ${path}`);
      if (files.length >= this.maxFiles) throw new WorkspaceSnapshotError("WORKSPACE_LIMIT", "Workspace Snapshot exceeds the file count limit");
      const readLimit = Math.min(this.maxFileBytes, this.maxTotalBytes - totalBytes);
      let content: Uint8Array;
      try {
        content = await this.options.files.read(path, input.signal, readLimit);
      } catch (error) {
        if ((error as { code?: unknown }).code === "FS_TOO_LARGE") {
          throw new WorkspaceSnapshotError("WORKSPACE_LIMIT", "Workspace Snapshot exceeds the byte limit", { cause: error });
        }
        throw error;
      }
      if (content.byteLength > readLimit) throw new WorkspaceSnapshotError("WORKSPACE_LIMIT", "Workspace Snapshot exceeds the byte limit");
      totalBytes += content.byteLength;
      contents.set(path, content);
      files.push({ path, contentHash: hash(content), size: content.byteLength, source });
    }

    const snapshot: WorkspaceSnapshotPackage = {
      snapshotId: input.snapshotId ?? this.snapshotIdFactory(),
      roomId: input.roomId,
      hostSessionId: input.hostSessionId,
      roomEventSeq: input.roomEventSeq,
      ...(head.exitCode === 0 && head.stdout.trim() !== "" ? { headOid: head.stdout.trim() } : {}),
      manifestHash: hash(JSON.stringify(files)),
      files,
      createdAt: this.now(),
    };
    await this.options.store.save(snapshot, contents);
    return snapshot;
  }
}

export interface DshFsTarget {
  targetKey: unknown;
  displayPath: string;
}

export interface DshWorkspaceFileSystem {
  resolve(path: string, options?: { cwd?: string; signal?: AbortSignal }): Promise<DshFsTarget>;
  contains(parent: DshFsTarget, child: DshFsTarget): boolean;
  processPath?(target: DshFsTarget): string;
  lstat(path: string, options?: { cwd?: string }, signal?: AbortSignal): Promise<{ type: "file" | "directory" | "symlink" | "other" } | undefined>;
  readBytes(target: DshFsTarget, signal: AbortSignal | undefined, maxBytes: number): Promise<Uint8Array>;
  writeText?(target: DshFsTarget, content: string): Promise<unknown>;
}

export function createDshWorkspaceFilePort(input: { fs: DshWorkspaceFileSystem; cwd: string }): WorkspaceFilePort {
  const resolveContained = async (path: string, signal?: AbortSignal): Promise<DshFsTarget | undefined> => {
    const root = await input.fs.resolve(".", { cwd: input.cwd, signal });
    const target = await input.fs.resolve(path, { cwd: input.cwd, signal });
    return input.fs.contains(root, target) ? target : undefined;
  };
  return {
    async inspect(path, signal): Promise<WorkspaceFileInspection> {
      const target = await resolveContained(path, signal);
      if (!target) return "outside";
      const info = await input.fs.lstat(path, { cwd: input.cwd }, signal);
      if (!info) return "missing";
      if (info.type !== "file") return info.type === "symlink" ? "symlink" : "other";
      return "file";
    },
    async read(path, signal, maxBytes = Number.MAX_SAFE_INTEGER): Promise<Uint8Array> {
      const target = await resolveContained(path, signal);
      if (!target) throw new WorkspaceSnapshotError("WORKSPACE_PATH_UNSAFE", `Workspace path escapes repository root: ${path}`);
      const info = await input.fs.lstat(path, { cwd: input.cwd }, signal);
      if (!info || info.type !== "file") throw new WorkspaceSnapshotError("WORKSPACE_PATH_UNSAFE", `Workspace file is no longer a regular file: ${path}`);
      return await input.fs.readBytes(target, signal, maxBytes);
    },
  };
}
