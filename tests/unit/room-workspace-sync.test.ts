import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceSnapshotFile, WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { DshRoomWorkspaceBindingService } from "../../src/dsh-room-workspace.js";
import { EventLedger } from "../../src/events.js";
import { RoomSessionLinkStore } from "../../src/room-session-links.js";
import { RoomWorkspaceMaterializer } from "../../src/room-workspace.js";
import { RoomWorkspaceSyncService } from "../../src/room-workspace-sync.js";
import { RoomStore } from "../../src/room.js";
import { WorkspaceSnapshotStore } from "../../src/workspace-snapshot-store.js";
import type { WorkspaceVersionArtifactStore, WorkspaceVersionRecord } from "../../src/workspace-versions.js";
import { WorkspaceVersionService } from "../../src/workspace-versions.js";
import { gitCommand, localDshSubprocess } from "../helpers/local-dsh-subprocess.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface VersionFixture {
  artifacts: WorkspaceSnapshotStore;
  versions: WorkspaceVersionService;
  save: (snapshotId: string, raw: Array<{ path: string; text: string }>, createdAt: number) => Promise<void>;
  current: WorkspaceVersionRecord;
  target: WorkspaceVersionRecord;
}

function crashTransaction(workspaceRoot: string): {
  transactionId: string;
  backupName: string;
  stagingName: string;
  manifestTempName: string;
} {
  const transactionId = randomUUID();
  const stagingName = `.s-${transactionId.replaceAll("-", "").slice(0, 12)}`;
  roots.push(join(dirname(workspaceRoot), stagingName));
  return {
    transactionId,
    backupName: `.workspace-sync-backup-${transactionId}`,
    stagingName,
    manifestTempName: `current.json.sync-${transactionId}.tmp`,
  };
}

async function versionFixture(): Promise<VersionFixture> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "dsh-collab-sync-artifacts-"));
  roots.push(artifactRoot);
  const artifacts = new WorkspaceSnapshotStore(artifactRoot);
  const rooms = new RoomStore();
  const ledger = new EventLedger();
  rooms.createRoom({ roomId: "room-1", hostId: "owner", hostSessionId: "session-owner", title: "Room", hostDisplayName: "Owner", now: 1 });
  const versions = new WorkspaceVersionService({ rooms, ledger, artifacts });

  const save = async (snapshotId: string, raw: Array<{ path: string; text: string }>, createdAt: number): Promise<void> => {
    const files: WorkspaceSnapshotFile[] = raw.map(({ path, text }) => {
      const content = Buffer.from(text);
      return { path, contentHash: sha256(content), size: content.byteLength, source: "tracked" };
    });
    const snapshot: WorkspaceSnapshotPackage = {
      snapshotId,
      roomId: "room-1",
      hostSessionId: "session-owner",
      roomEventSeq: 0,
      headOid: String(createdAt).padStart(40, "a").slice(-40),
      manifestHash: sha256(JSON.stringify(files)),
      files,
      createdAt,
    };
    await artifacts.save(snapshot, new Map(raw.map(({ path, text }) => [path, Buffer.from(text)])));
  };

  await save("version-1", [{ path: "README.md", text: "one\n" }, { path: "src/app.ts", text: "export const value = 1;\n" }], 10);
  const current = (await versions.create({ roomId: "room-1", principalId: "owner", snapshotId: "version-1" })).record;
  await save("version-2", [{ path: "README.md", text: "two\n" }, { path: "src/next.ts", text: "export const value = 2;\n" }], 20);
  const target = (await versions.create({
    roomId: "room-1",
    principalId: "owner",
    snapshotId: "version-2",
    parentVersionId: current.version.workspaceVersionId,
  })).record;
  return { artifacts, versions, save, current, target };
}

async function materializedFixture(input: { workspaceRoot?: string } = {}): Promise<VersionFixture & { materializer: RoomWorkspaceMaterializer; workspaceRoot: string }> {
  const fixture = await versionFixture();
  const workspaceRoot = input.workspaceRoot ?? await mkdtemp(join(tmpdir(), "dsh-collab-sync-rooms-"));
  if (!input.workspaceRoot) roots.push(workspaceRoot);
  const materializer = new RoomWorkspaceMaterializer({ root: workspaceRoot, artifacts: fixture.artifacts });
  const workspace = await materializer.materialize({ roomId: "room-1", record: fixture.current });
  const subprocess = localDshSubprocess();
  await new DshRoomWorkspaceBindingService({
    agents: { get: () => ({ session: { header: { cwd: workspace.workspacePath } } }) },
    nativeWorkspaces: {
      create: async (path) => ({ id: "native-1", path, attachSession: async () => {}, detachSession: async () => {} }),
      resolveByPath: async () => undefined,
    },
    subprocess,
    roomWorkspaces: materializer,
    links: new RoomSessionLinkStore(),
  }).bind({ roomId: "room-1", memberId: "participant-1", sessionId: "session-1" });
  return { ...fixture, materializer, workspaceRoot };
}

describe("RoomWorkspaceSyncService", () => {
  it("recovers the previous workspace after a process exits with the live workspace renamed away", async () => {
    const fixture = await materializedFixture();
    const workspace = (await fixture.materializer.open("room-1"))!;
    const { backupName, stagingName, manifestTempName } = crashTransaction(fixture.workspaceRoot);
    await rename(workspace.workspacePath, join(workspace.root, backupName));
    await mkdir(join(dirname(fixture.workspaceRoot), stagingName));
    await writeFile(join(workspace.root, "workspace-sync.json"), JSON.stringify({
      version: 1,
      roomId: "room-1",
      ownerPid: 2147483647,
      previousVersionId: fixture.current.version.workspaceVersionId,
      targetVersionId: fixture.target.version.workspaceVersionId,
      backupName,
      stagingName,
      manifestTempName,
    }));

    const restarted = new RoomWorkspaceMaterializer({ root: fixture.workspaceRoot, artifacts: fixture.artifacts });
    const recovered = await restarted.open("room-1");

    expect(recovered?.record).toEqual(fixture.current);
    expect(await readFile(join(recovered!.workspacePath, "README.md"), "utf8")).toBe("one\n");
    expect((await readdir(workspace.root)).filter((name) => name.includes("sync"))).toEqual([]);
    expect((await readdir(fixture.workspaceRoot)).filter((name) => name.includes("sync"))).toEqual([]);
    await expect(lstat(join(dirname(fixture.workspaceRoot), stagingName))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rolls back a promoted workspace when the process exits before committing its base manifest", async () => {
    const fixture = await materializedFixture();
    const workspace = (await fixture.materializer.open("room-1"))!;
    const { backupName, stagingName, manifestTempName } = crashTransaction(fixture.workspaceRoot);
    const staging = new RoomWorkspaceMaterializer({ root: join(dirname(fixture.workspaceRoot), stagingName), artifacts: fixture.artifacts });
    const promoted = await staging.materialize({ roomId: "room-1", record: fixture.target });
    await rename(workspace.workspacePath, join(workspace.root, backupName));
    await rename(promoted.workspacePath, workspace.workspacePath);
    await writeFile(join(workspace.baseManifestPath, "..", manifestTempName), JSON.stringify({
      version: 1,
      roomId: "room-1",
      record: fixture.target,
    }));
    await writeFile(join(workspace.root, "workspace-sync.json"), JSON.stringify({
      version: 1,
      roomId: "room-1",
      ownerPid: 2147483647,
      previousVersionId: fixture.current.version.workspaceVersionId,
      targetVersionId: fixture.target.version.workspaceVersionId,
      backupName,
      stagingName,
      manifestTempName,
    }));

    const restarted = new RoomWorkspaceMaterializer({ root: fixture.workspaceRoot, artifacts: fixture.artifacts });
    const recovered = await restarted.open("room-1");

    expect(recovered?.record).toEqual(fixture.current);
    expect(await readFile(join(recovered!.workspacePath, "README.md"), "utf8")).toBe("one\n");
    expect((await readdir(workspace.root)).filter((name) => name.includes("sync"))).toEqual([]);
    expect((await readdir(fixture.workspaceRoot)).filter((name) => name.includes("sync"))).toEqual([]);
    await expect(lstat(join(dirname(fixture.workspaceRoot), stagingName))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses crash rollback when the promoted workspace was edited after the crash", async () => {
    const fixture = await materializedFixture();
    const workspace = (await fixture.materializer.open("room-1"))!;
    const { backupName, stagingName, manifestTempName } = crashTransaction(fixture.workspaceRoot);
    const staging = new RoomWorkspaceMaterializer({ root: join(dirname(fixture.workspaceRoot), stagingName), artifacts: fixture.artifacts });
    const promoted = await staging.materialize({ roomId: "room-1", record: fixture.target });
    await rename(workspace.workspacePath, join(workspace.root, backupName));
    await rename(promoted.workspacePath, workspace.workspacePath);
    await writeFile(join(workspace.workspacePath, "README.md"), "post-crash edit\n");
    await writeFile(join(workspace.baseManifestPath, "..", manifestTempName), JSON.stringify({
      version: 1,
      roomId: "room-1",
      record: fixture.target,
    }));
    await writeFile(join(workspace.root, "workspace-sync.json"), JSON.stringify({
      version: 1,
      roomId: "room-1",
      ownerPid: 2147483647,
      previousVersionId: fixture.current.version.workspaceVersionId,
      targetVersionId: fixture.target.version.workspaceVersionId,
      backupName,
      stagingName,
      manifestTempName,
    }));

    const restarted = new RoomWorkspaceMaterializer({ root: fixture.workspaceRoot, artifacts: fixture.artifacts });
    await expect(restarted.open("room-1")).rejects.toThrow(/changed after the interrupted sync/i);
    expect(await readFile(join(workspace.workspacePath, "README.md"), "utf8")).toBe("post-crash edit\n");
    expect(await readFile(join(workspace.root, backupName, "README.md"), "utf8")).toBe("one\n");
  });

  it("initializes a clean participant baseline before the first sync", async () => {
    const fixture = await versionFixture();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "dsh-collab-sync-unbound-rooms-"));
    roots.push(workspaceRoot);
    const materializer = new RoomWorkspaceMaterializer({ root: workspaceRoot, artifacts: fixture.artifacts });
    const materialized = await materializer.materialize({ roomId: "room-1", record: fixture.current });
    const subprocess = localDshSubprocess();
    const service = new RoomWorkspaceSyncService({ roomWorkspaces: materializer, artifacts: fixture.artifacts, subprocess });

    const result = await service.sync({ roomId: "room-1", target: fixture.target });

    expect(result.status).toBe("advanced");
    const opened = await materializer.open("room-1");
    expect(opened?.record).toEqual(fixture.target);
    expect((await gitCommand(subprocess, materialized.workspacePath, ["config", "--local", "--get", "collab.roomid"])).stdout.trim()).toBe("room-1");
    expect((await gitCommand(subprocess, opened!.workspacePath, ["config", "--local", "--get", "collab.workspaceversion"])).stdout.trim()).toBe("version-2");
    expect((await gitCommand(subprocess, opened!.workspacePath, ["status", "--short"])).stdout).toBe("");
  });
  it("fast-forwards a clean workspace and amends the one local baseline", async () => {
    const fixture = await materializedFixture();
    const subprocess = localDshSubprocess();
    const service = new RoomWorkspaceSyncService({ roomWorkspaces: fixture.materializer, artifacts: fixture.artifacts, subprocess });
    const before = (await fixture.materializer.open("room-1"))!;
    await writeFile(join(before.draftsPath, "local-draft.txt"), "keep\n");

    const result = await service.sync({ roomId: "room-1", target: fixture.target });

    expect(result.status).toBe("advanced");
    const opened = await fixture.materializer.open("room-1");
    expect(opened?.record).toEqual(fixture.target);
    expect(await readFile(join(opened!.workspacePath, "README.md"), "utf8")).toBe("two\n");
    await expect(readFile(join(opened!.workspacePath, "src/app.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(opened!.workspacePath, "src/next.ts"), "utf8")).toContain("value = 2");
    expect(await readFile(join(opened!.draftsPath, "local-draft.txt"), "utf8")).toBe("keep\n");
    expect((await gitCommand(subprocess, opened!.workspacePath, ["status", "--short"])).stdout).toBe("");
    expect((await gitCommand(subprocess, opened!.workspacePath, ["rev-list", "--count", "HEAD"])).stdout.trim()).toBe("1");
    expect((await gitCommand(subprocess, opened!.workspacePath, ["config", "--local", "--get", "collab.workspaceversion"])).stdout.trim()).toBe("version-2");
  }, 10_000);

  it("blocks a dirty workspace without replacing files or advancing the base", async () => {
    const fixture = await materializedFixture();
    const workspace = (await fixture.materializer.open("room-1"))!;
    await writeFile(join(workspace.workspacePath, "README.md"), "participant work\n");
    await writeFile(join(workspace.workspacePath, "untracked.txt"), "draft\n");
    const subprocess = localDshSubprocess();
    await gitCommand(subprocess, workspace.workspacePath, ["add", "--all"]);
    await gitCommand(subprocess, workspace.workspacePath, ["-c", "user.name=Participant", "-c", "user.email=participant@localhost", "commit", "--no-gpg-sign", "--no-verify", "-m", "local work"]);
    expect((await gitCommand(subprocess, workspace.workspacePath, ["status", "--short"])).stdout).toBe("");
    const service = new RoomWorkspaceSyncService({ roomWorkspaces: fixture.materializer, artifacts: fixture.artifacts, subprocess });

    const result = await service.sync({ roomId: "room-1", target: fixture.target });

    expect(result).toMatchObject({
      status: "blocked",
      reason: "dirty",
      currentVersionId: "version-1",
      targetVersionId: "version-2",
    });
    if (result.status === "blocked") expect(result.paths).toEqual(["README.md", "untracked.txt"]);
    const opened = await fixture.materializer.open("room-1");
    expect(opened?.record).toEqual(fixture.current);
    expect(await readFile(join(opened!.workspacePath, "README.md"), "utf8")).toBe("participant work\n");
    expect((await readdir(fixture.workspaceRoot)).some((name) => name.includes("sync"))).toBe(false);
  });

  it("initializes the synthetic baseline before discarding dirty files from a fresh materialized workspace", async () => {
    const fixture = await versionFixture();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "dsh-collab-sync-fresh-"));
    roots.push(workspaceRoot);
    const materializer = new RoomWorkspaceMaterializer({ root: workspaceRoot, artifacts: fixture.artifacts });
    const workspace = await materializer.materialize({ roomId: "room-1", record: fixture.current });
    const subprocess = localDshSubprocess();
    await gitCommand(subprocess, workspace.workspacePath, ["init"]);
    await gitCommand(subprocess, workspace.workspacePath, ["config", "core.autocrlf", "true"]);
    await writeFile(join(workspace.workspacePath, "local.txt"), "discard me\n");
    const service = new RoomWorkspaceSyncService({ roomWorkspaces: materializer, artifacts: fixture.artifacts, subprocess });

    await expect(service.discardAndSync({ roomId: "room-1", target: fixture.target })).resolves.toMatchObject({ status: "advanced", versionId: "version-2" });
    const opened = (await materializer.open("room-1"))!;
    await expect(readFile(join(opened.workspacePath, "local.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("only discards local changes through the explicit discard operation", async () => {
    const fixture = await materializedFixture();
    const workspace = (await fixture.materializer.open("room-1"))!;
    await writeFile(join(workspace.workspacePath, "README.md"), "discard me\n");
    await writeFile(join(workspace.workspacePath, "untracked.txt"), "discard me too\n");
    await writeFile(join(workspace.draftsPath, "saved-draft.txt"), "keep me\n");
    const subprocess = localDshSubprocess();
    const service = new RoomWorkspaceSyncService({ roomWorkspaces: fixture.materializer, artifacts: fixture.artifacts, subprocess });

    const result = await service.discardAndSync({ roomId: "room-1", target: fixture.target });

    expect(result).toMatchObject({ status: "advanced", previousVersionId: "version-1", versionId: "version-2" });
    const opened = (await fixture.materializer.open("room-1"))!;
    expect(await readFile(join(opened.workspacePath, "README.md"), "utf8")).toBe("two\n");
    await expect(readFile(join(opened.workspacePath, "untracked.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(opened.draftsPath, "saved-draft.txt"), "utf8")).toBe("keep me\n");
    expect((await gitCommand(subprocess, opened.workspacePath, ["status", "--short"])).stdout).toBe("");
  });

  it.runIf(process.platform === "win32")("keeps the temporary Git workspace below the Windows path limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-sync-long-"));
    roots.push(root);
    const workspaceRoot = join(root, "x".repeat(Math.max(1, 90 - root.length - 1)));
    await mkdir(workspaceRoot, { recursive: true });
    const fixture = await materializedFixture({ workspaceRoot });
    const workspace = (await fixture.materializer.open("room-1"))!;
    await writeFile(join(workspace.workspacePath, "README.md"), "discard me\n");
    const service = new RoomWorkspaceSyncService({
      roomWorkspaces: fixture.materializer,
      artifacts: fixture.artifacts,
      subprocess: localDshSubprocess(),
    });

    await expect(service.discardAndSync({ roomId: "room-1", target: fixture.target }))
      .resolves.toMatchObject({ status: "advanced", versionId: "version-2" });
  }, 10_000);

  it("blocks and restores a local edit that arrives while the target is being staged", async () => {
    const fixture = await materializedFixture();
    const workspace = (await fixture.materializer.open("room-1"))!;
    let injected = false;
    const racingArtifacts: WorkspaceVersionArtifactStore = {
      load: (snapshotId) => fixture.artifacts.load(snapshotId),
      readFile: async (snapshotId, path) => {
        if (!injected && snapshotId === "version-2" && path === "src/next.ts") {
          injected = true;
          await writeFile(join(workspace.workspacePath, "README.md"), "late local edit\n");
        }
        return await fixture.artifacts.readFile(snapshotId, path);
      },
    };
    const service = new RoomWorkspaceSyncService({ roomWorkspaces: fixture.materializer, artifacts: racingArtifacts, subprocess: localDshSubprocess() });

    const result = await service.sync({ roomId: "room-1", target: fixture.target });

    expect(result).toMatchObject({ status: "blocked", reason: "dirty", paths: ["README.md"] });
    const opened = (await fixture.materializer.open("room-1"))!;
    expect(opened.record).toEqual(fixture.current);
    expect(await readFile(join(opened.workspacePath, "README.md"), "utf8")).toBe("late local edit\n");
    expect((await readdir(fixture.workspaceRoot)).some((name) => name.includes("sync"))).toBe(false);
  });

  it("advances to a later published version when the room history contains the skipped parents", async () => {
    const fixture = await materializedFixture();
    await fixture.save("version-3", [{ path: "README.md", text: "three\n" }, { path: "src/next.ts", text: "export const value = 3;\n" }], 30);
    const later = (await fixture.versions.create({
      roomId: "room-1",
      principalId: "owner",
      snapshotId: "version-3",
      parentVersionId: fixture.target.version.workspaceVersionId,
    })).record;
    const service = new RoomWorkspaceSyncService({ roomWorkspaces: fixture.materializer, artifacts: fixture.artifacts, subprocess: localDshSubprocess() });

    await expect(service.discardAndSync({
      roomId: "room-1",
      target: later,
      knownVersions: [fixture.target, later],
    })).resolves.toMatchObject({ status: "advanced", previousVersionId: "version-1", versionId: "version-3" });
    const opened = (await fixture.materializer.open("room-1"))!;
    expect(opened.record).toEqual(later);
    expect(await readFile(join(opened.workspacePath, "README.md"), "utf8")).toBe("three\n");
  });

  it("is idempotent for the current target and rejects non-linear or cross-room targets", async () => {
    const fixture = await materializedFixture();
    const service = new RoomWorkspaceSyncService({ roomWorkspaces: fixture.materializer, artifacts: fixture.artifacts, subprocess: localDshSubprocess() });
    await service.sync({ roomId: "room-1", target: fixture.target });

    await expect(service.sync({ roomId: "room-1", target: fixture.target })).resolves.toMatchObject({ status: "current", versionId: "version-2" });
    const wrongParent = structuredClone(fixture.current);
    wrongParent.version.workspaceVersionId = "version-3";
    wrongParent.artifact.snapshotId = "version-3";
    wrongParent.version.parentVersionId = "version-0";
    await expect(service.sync({ roomId: "room-1", target: wrongParent })).rejects.toThrow(/ancestry|based on the current workspace/i);
    const wrongRoom = structuredClone(fixture.target);
    wrongRoom.version.roomId = "room-2";
    await expect(service.sync({ roomId: "room-1", target: wrongRoom })).rejects.toThrow(/room/i);
    expect((await fixture.materializer.open("room-1"))?.record).toEqual(fixture.target);
  });

  it("leaves the old workspace and base visible when target staging fails", async () => {
    const fixture = await materializedFixture();
    const failingArtifacts: WorkspaceVersionArtifactStore = {
      load: (snapshotId) => fixture.artifacts.load(snapshotId),
      readFile: async (snapshotId, path) => {
        if (snapshotId === "version-2" && path === "src/next.ts") throw new Error("target download interrupted");
        return await fixture.artifacts.readFile(snapshotId, path);
      },
    };
    const service = new RoomWorkspaceSyncService({ roomWorkspaces: fixture.materializer, artifacts: failingArtifacts, subprocess: localDshSubprocess() });

    await expect(service.sync({ roomId: "room-1", target: fixture.target })).rejects.toThrow("interrupted");

    const opened = await fixture.materializer.open("room-1");
    expect(opened?.record).toEqual(fixture.current);
    expect(await readFile(join(opened!.workspacePath, "README.md"), "utf8")).toBe("one\n");
    expect((await readdir(fixture.workspaceRoot)).some((name) => name.includes("sync"))).toBe(false);
  });
});
