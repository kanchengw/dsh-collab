import { spawn as spawnChild } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DshRoomWorkspaceBindingService } from "../../src/dsh-room-workspace.js";
import type { RoomWorkspace } from "../../src/room-workspace.js";
import { RoomSessionLinkStore } from "../../src/room-session-links.js";
import type { DshRepositorySubprocess } from "../../src/repository-inspector.js";
import type { WorkspaceVersionFile, WorkspaceVersionRecord } from "../../src/workspace-versions.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function roomWorkspace(roomId: string, source: Record<string, string> = { "README.md": "hello\n" }): Promise<RoomWorkspace> {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-native-room-"));
  roots.push(root);
  const workspacePath = join(root, "workspace");
  const draftsPath = join(root, "drafts");
  const baseManifestPath = join(root, "base-manifest", "current.json");
  await Promise.all([mkdir(workspacePath), mkdir(draftsPath), mkdir(join(root, "base-manifest"))]);
  const files: WorkspaceVersionFile[] = [];
  for (const [path, text] of Object.entries(source)) {
    const content = Buffer.from(text);
    files.push({ path, contentHash: sha256(content), size: content.byteLength, mode: "text" });
    const target = join(workspacePath, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  const manifestHash = sha256(JSON.stringify(files));
  const workspaceVersionId = `version-${roomId}`;
  const record: WorkspaceVersionRecord = {
    version: {
      workspaceVersionId,
      roomId,
      files,
      createdBy: "owner",
      createdAt: 10,
    },
    manifestHash,
    artifact: {
      kind: "workspace-snapshot.v1",
      snapshotId: workspaceVersionId,
      manifestHash,
      totalBytes: files.reduce((total, file) => total + file.size, 0),
    },
  };
  await writeFile(baseManifestPath, JSON.stringify({ version: 1, roomId, record }));
  return { roomId, root, workspacePath, draftsPath, baseManifestPath, record };
}

function localSubprocess(): DshRepositorySubprocess {
  return {
    resolveExecutable: async (command) => command,
    spawn(spec) {
      const child = spawnChild(spec.argv[0]!, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      child.stdout.on("data", (chunk: Buffer) => { stdout = Buffer.concat([stdout, chunk]); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]); });
      return {
        collected: {
          stdout: { readFrom: (offset) => ({ text: stdout.subarray(offset).toString("utf8"), lossy: false }) },
          stderr: { readFrom: (offset) => ({ text: stderr.subarray(offset).toString("utf8"), lossy: false }) },
        },
        done: new Promise((resolveDone, reject) => {
          child.once("error", reject);
          child.once("close", (exitCode, signal) => { resolveDone({ exitCode, signal }); });
        }),
      };
    },
  };
}

class FakeNativeWorkspace {
  readonly sessionIds = new Set<string>();
  attachCalls = 0;
  detachCalls = 0;

  constructor(readonly id: string, readonly path: string) {}

  async attachSession(sessionId: string): Promise<void> {
    this.attachCalls += 1;
    this.sessionIds.add(sessionId);
  }

  async detachSession(sessionId: string): Promise<void> {
    this.detachCalls += 1;
    this.sessionIds.delete(sessionId);
  }
}

class FakeNativeWorkspaceRegistry {
  readonly byPath = new Map<string, FakeNativeWorkspace>();
  createCalls = 0;

  async create(path: string): Promise<FakeNativeWorkspace> {
    this.createCalls += 1;
    const normalized = await realpath(resolve(path));
    const existing = this.byPath.get(normalized);
    if (existing) return existing;
    const workspace = new FakeNativeWorkspace(`native-${this.byPath.size + 1}`, normalized);
    this.byPath.set(normalized, workspace);
    return workspace;
  }

  async resolveByPath(path: string): Promise<FakeNativeWorkspace | undefined> {
    return this.byPath.get(await realpath(resolve(path)));
  }
}

function command(subprocess: DshRepositorySubprocess, cwd: string, argv: string[]): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const handle = subprocess.spawn({
    argv: ["git", ...argv],
    cwd,
    stdio: { stdin: "ignore", stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 1024 * 1024 } },
    graceMs: 1_000,
  });
  return handle.done.then((outcome) => ({
    exitCode: outcome.exitCode,
    stdout: handle.collected.stdout!.readFrom(0).text,
    stderr: handle.collected.stderr!.readFrom(0).text,
  }));
}

describe("DshRoomWorkspaceBindingService", () => {
  it("attaches an existing native Session and creates one clean local Git baseline without creating an Agent", async () => {
    const room = await roomWorkspace("room-1", { "README.md": "hello\n", "src/app.ts": "export const app = true;\n" });
    const nativeWorkspaces = new FakeNativeWorkspaceRegistry();
    const links = new RoomSessionLinkStore();
    const agents = { get: (sessionId: string) => sessionId === "session-1" ? { session: { header: { cwd: room.workspacePath } } } : undefined };
    const subprocess = localSubprocess();
    const service = new DshRoomWorkspaceBindingService({
      agents,
      nativeWorkspaces,
      subprocess,
      roomWorkspaces: { open: async (roomId) => roomId === room.roomId ? room : undefined },
      links,
    });

    const link = await service.bind({ roomId: room.roomId, memberId: "participant-1", sessionId: "session-1" });

    const canonicalWorkspace = await realpath(room.workspacePath);
    expect(link.workspacePath).toBe(canonicalWorkspace);
    expect(nativeWorkspaces.byPath.get(canonicalWorkspace)?.sessionIds).toEqual(new Set(["session-1"]));
    expect("create" in agents).toBe(false);
    expect((await command(subprocess, room.workspacePath, ["status", "--short"])).stdout).toBe("");
    expect((await command(subprocess, room.workspacePath, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    expect((await command(subprocess, room.workspacePath, ["remote"])).stdout).toBe("");

    await writeFile(join(room.workspacePath, "README.md"), "participant edit\n");
    expect((await command(subprocess, room.workspacePath, ["status", "--short"])).stdout).toContain("README.md");
  });

  it("reuses the native Workspace and baseline without hiding local edits", async () => {
    const room = await roomWorkspace("room-repeat");
    const nativeWorkspaces = new FakeNativeWorkspaceRegistry();
    const links = new RoomSessionLinkStore();
    const subprocess = localSubprocess();
    const agents = { get: () => ({ session: { header: { cwd: room.workspacePath } } }) };
    const first = new DshRoomWorkspaceBindingService({ agents, nativeWorkspaces, subprocess, roomWorkspaces: { open: async () => room }, links });
    await first.bind({ roomId: room.roomId, memberId: "participant-1", sessionId: "session-1" });
    await writeFile(join(room.workspacePath, "README.md"), "keep me\n");

    const second = new DshRoomWorkspaceBindingService({ agents, nativeWorkspaces, subprocess, roomWorkspaces: { open: async () => room }, links });
    await second.bind({ roomId: room.roomId, memberId: "participant-1", sessionId: "session-1" });

    expect(await readFile(join(room.workspacePath, "README.md"), "utf8")).toBe("keep me\n");
    expect((await command(subprocess, room.workspacePath, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    expect(nativeWorkspaces.byPath.get(await realpath(room.workspacePath))?.sessionIds).toEqual(new Set(["session-1"]));
  });

  it("rejects missing or mismatched native Sessions and never binds an Owner or another room workspace", async () => {
    const participantRoom = await roomWorkspace("room-participant");
    const ownerWorkspace = await mkdtemp(join(tmpdir(), "dsh-collab-owner-workspace-"));
    roots.push(ownerWorkspace);
    const links = new RoomSessionLinkStore();
    const nativeWorkspaces = new FakeNativeWorkspaceRegistry();
    const base = { nativeWorkspaces, subprocess: localSubprocess(), roomWorkspaces: { open: async () => participantRoom }, links };

    await expect(new DshRoomWorkspaceBindingService({ ...base, agents: { get: () => undefined } })
      .bind({ roomId: participantRoom.roomId, memberId: "participant-1", sessionId: "missing" })).rejects.toThrow(/live native Session/i);
    await expect(new DshRoomWorkspaceBindingService({ ...base, agents: { get: () => ({ session: { header: { cwd: ownerWorkspace } } }) } })
      .bind({ roomId: participantRoom.roomId, memberId: "participant-1", sessionId: "owner-session" })).rejects.toThrow(/cwd/i);
    expect(links.list()).toEqual([]);
    expect(nativeWorkspaces.byPath.size).toBe(0);
  });

  it("does not turn pre-bind modifications into the synthetic baseline", async () => {
    const room = await roomWorkspace("room-dirty");
    await writeFile(join(room.workspacePath, "README.md"), "changed before bind\n");
    const service = new DshRoomWorkspaceBindingService({
      agents: { get: () => ({ session: { header: { cwd: room.workspacePath } } }) },
      nativeWorkspaces: new FakeNativeWorkspaceRegistry(),
      subprocess: localSubprocess(),
      roomWorkspaces: { open: async () => room },
      links: new RoomSessionLinkStore(),
    });

    await expect(service.bind({ roomId: room.roomId, memberId: "participant-1", sessionId: "session-dirty" })).rejects.toThrow(/base version/i);
    expect((await command(localSubprocess(), room.workspacePath, ["rev-parse", "--verify", "HEAD"])).exitCode).not.toBe(0);
  });

  it("detaches the native Session and local link without deleting the Room Workspace", async () => {
    const room = await roomWorkspace("room-unbind");
    const nativeWorkspaces = new FakeNativeWorkspaceRegistry();
    const links = new RoomSessionLinkStore();
    const service = new DshRoomWorkspaceBindingService({
      agents: { get: () => ({ session: { header: { cwd: room.workspacePath } } }) },
      nativeWorkspaces,
      subprocess: localSubprocess(),
      roomWorkspaces: { open: async () => room },
      links,
    });
    await service.bind({ roomId: room.roomId, memberId: "participant-1", sessionId: "session-1" });
    await writeFile(join(room.workspacePath, "local.txt"), "keep");

    await expect(service.unbind("session-1")).resolves.toBe(true);

    expect(links.getBySession("session-1")).toBeUndefined();
    expect(nativeWorkspaces.byPath.get(await realpath(room.workspacePath))?.sessionIds).toEqual(new Set());
    await expect(readFile(join(room.workspacePath, "local.txt"), "utf8")).resolves.toBe("keep");
    await expect(service.unbind("session-1")).resolves.toBe(false);
  });
});
