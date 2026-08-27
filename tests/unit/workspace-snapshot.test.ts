import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RepositoryCommandPort } from "../../src/repository-inspector.js";
import {
  WorkspaceSnapshotCapture,
  createDshWorkspaceFilePort,
  type WorkspaceFilePort,
} from "../../src/workspace-snapshot.js";
import { WorkspaceSnapshotStore } from "../../src/workspace-snapshot-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function sha256(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function commandPort(outputs: Record<string, { exitCode: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const port: RepositoryCommandPort = {
    async run(argv) {
      calls.push([...argv]);
      const output = outputs[argv.join(" ")];
      if (!output) throw new Error(`unexpected command: ${argv.join(" ")}`);
      return { exitCode: output.exitCode, stdout: output.stdout ?? "", stderr: output.stderr ?? "" };
    },
  };
  return { calls, port };
}

describe("WorkspaceSnapshotCapture", () => {
  it("captures tracked and non-ignored untracked files as an immutable persisted package", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-snapshots-"));
    temporaryDirectories.push(root);
    const commands = commandPort({
      "rev-parse --show-toplevel": { exitCode: 0, stdout: "C:/repo\n" },
      "rev-parse --verify --quiet HEAD": { exitCode: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n" },
      "ls-files -z --cached": { exitCode: 0, stdout: "src/a.ts\0deleted.ts\0link.ts\0.git/config\0" },
      "ls-files -z --others --exclude-standard": { exitCode: 0, stdout: "notes.txt\0untracked-link\0" },
    });
    const contents = new Map<string, Uint8Array>([
      ["src/a.ts", Buffer.from("export const a = 1;\n")],
      ["notes.txt", Buffer.from("review me\n")],
    ]);
    const files: WorkspaceFilePort = {
      inspect: async (path) => path === "deleted.ts" ? "missing" : path.includes("link") ? "symlink" : "file",
      read: async (path) => contents.get(path) ?? (() => { throw new Error(`unexpected read: ${path}`); })(),
    };
    const store = new WorkspaceSnapshotStore(root);
    const capture = new WorkspaceSnapshotCapture({
      commands: commands.port,
      files,
      store,
      now: () => 20,
      snapshotIdFactory: () => "snapshot-1",
    });

    const snapshot = await capture.capture({ roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 7 });

    const expectedFiles = [
      { path: "notes.txt", contentHash: sha256("review me\n"), size: 10, source: "untracked" as const },
      { path: "src/a.ts", contentHash: sha256("export const a = 1;\n"), size: 20, source: "tracked" as const },
    ];
    expect(snapshot).toEqual({
      snapshotId: "snapshot-1",
      roomId: "room-1",
      hostSessionId: "session-1",
      roomEventSeq: 7,
      headOid: "0123456789abcdef0123456789abcdef01234567",
      manifestHash: sha256(JSON.stringify(expectedFiles)),
      files: expectedFiles,
      createdAt: 20,
    });
    expect(commands.calls).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["rev-parse", "--verify", "--quiet", "HEAD"],
      ["ls-files", "-z", "--cached"],
      ["ls-files", "-z", "--others", "--exclude-standard"],
    ]);

    const restored = new WorkspaceSnapshotStore(root);
    await expect(restored.load("snapshot-1")).resolves.toEqual(snapshot);
    await expect(restored.readFile("snapshot-1", "src/a.ts")).resolves.toEqual(Buffer.from("export const a = 1;\n"));
    await expect(restored.readFile("snapshot-1", "missing.ts")).rejects.toThrow("not in snapshot");
    await expect(store.save(snapshot, contents)).rejects.toThrow("already exists");
  });

  it("rejects non-Git workspaces and paths outside the fixed Git scope", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-snapshots-"));
    temporaryDirectories.push(root);
    const notGit = commandPort({
      "rev-parse --show-toplevel": { exitCode: 128, stderr: "fatal: not a git repository" },
    });
    const store = new WorkspaceSnapshotStore(root);
    const files: WorkspaceFilePort = { inspect: async () => "file", read: async () => new Uint8Array() };
    await expect(new WorkspaceSnapshotCapture({ commands: notGit.port, files, store }).capture({
      roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 0,
    })).rejects.toMatchObject({ code: "WORKSPACE_NOT_GIT" });

    const escaped = commandPort({
      "rev-parse --show-toplevel": { exitCode: 0, stdout: "C:/repo\n" },
      "rev-parse --verify --quiet HEAD": { exitCode: 0, stdout: "head\n" },
      "ls-files -z --cached": { exitCode: 0, stdout: "../secret.txt\0" },
      "ls-files -z --others --exclude-standard": { exitCode: 0, stdout: "" },
    });
    await expect(new WorkspaceSnapshotCapture({ commands: escaped.port, files, store }).capture({
      roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 0,
    })).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });

    const brokenHead = commandPort({
      "rev-parse --show-toplevel": { exitCode: 0, stdout: "C:/repo\n" },
      "rev-parse --verify --quiet HEAD": { exitCode: 2, stderr: "fatal: cannot read HEAD" },
    });
    await expect(new WorkspaceSnapshotCapture({ commands: brokenHead.port, files, store }).capture({
      roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 0,
    })).rejects.toMatchObject({ code: "WORKSPACE_CAPTURE_FAILED" });
  });

  it("binds DSH filesystem reads to the trusted Host cwd and rejects symlinks or containment escapes", async () => {
    const rootTarget = { targetKey: "root", displayPath: "C:/repo" };
    const fileTarget = { targetKey: "file", displayPath: "C:/repo/a.ts" };
    const outsideTarget = { targetKey: "outside", displayPath: "C:/other/a.ts" };
    const fs = {
      resolve: vi.fn(async (path: string) => path === "." ? rootTarget : path === "outside.ts" ? outsideTarget : fileTarget),
      contains: vi.fn((_root: object, target: object) => target !== outsideTarget),
      lstat: vi.fn(async (path: string) => ({ version: "v1", type: path === "link.ts" ? "symlink" as const : "file" as const, size: 2 })),
      readBytes: vi.fn(async () => Buffer.from("ok")),
    };
    const signal = new AbortController().signal;
    const files = createDshWorkspaceFilePort({ fs, cwd: "C:/trusted/session-workspace" });

    await expect(files.inspect("a.ts", signal)).resolves.toBe("file");
    await expect(files.inspect("link.ts", signal)).resolves.toBe("symlink");
    await expect(files.inspect("outside.ts", signal)).resolves.toBe("outside");
    await expect(files.read("a.ts", signal)).resolves.toEqual(Buffer.from("ok"));
    expect(fs.lstat).toHaveBeenCalledWith("a.ts", { cwd: "C:/trusted/session-workspace" }, signal);
    expect(fs.resolve).toHaveBeenCalledWith("a.ts", { cwd: "C:/trusted/session-workspace", signal });
    expect(fs.readBytes).toHaveBeenCalledWith(fileTarget, signal, Number.MAX_SAFE_INTEGER);
    expect(fs.lstat).not.toHaveBeenCalledWith("outside.ts", expect.anything(), expect.anything());
  });

  it("rejects malformed persisted snapshot identity and file paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-snapshots-"));
    temporaryDirectories.push(root);
    const directory = join(root, "snapshot-1");
    await mkdir(directory, { recursive: true });
    const files = [{ path: "../secret.txt", contentHash: sha256("secret"), size: 6, source: "tracked" }];
    await writeFile(join(directory, "manifest.json"), JSON.stringify({
      version: 1,
      snapshot: {
        snapshotId: "different-snapshot",
        roomId: "room-1",
        hostSessionId: "session-1",
        roomEventSeq: 0,
        manifestHash: sha256(JSON.stringify(files)),
        files,
        createdAt: 20,
      },
    }));

    await expect(new WorkspaceSnapshotStore(root).load("snapshot-1")).rejects.toThrow("manifest is malformed");
  });

  it("bounds Host capture before an oversized repository can become a transport artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-snapshots-"));
    temporaryDirectories.push(root);
    const commands = commandPort({
      "rev-parse --show-toplevel": { exitCode: 0, stdout: "C:/repo\n" },
      "rev-parse --verify --quiet HEAD": { exitCode: 1 },
      "ls-files -z --cached": { exitCode: 0, stdout: "large.bin\0" },
      "ls-files -z --others --exclude-standard": { exitCode: 0, stdout: "" },
    });
    const read = vi.fn(async () => Buffer.alloc(5));
    const capture = new WorkspaceSnapshotCapture({
      commands: commands.port,
      files: { inspect: async () => "file", read },
      store: new WorkspaceSnapshotStore(root),
      maxFileBytes: 4,
      maxTotalBytes: 4,
    });

    await expect(capture.capture({ roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 0 }))
      .rejects.toMatchObject({ code: "WORKSPACE_LIMIT" });
    expect(read).toHaveBeenCalledWith("large.bin", undefined, 4);
  });
});
