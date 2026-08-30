import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceSnapshotFile, WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { EventLedger } from "../../src/events.js";
import { RoomWorkspaceMaterializer } from "../../src/room-workspace.js";
import { RoomStore } from "../../src/room.js";
import type { WorkspaceVersionArtifactStore, WorkspaceVersionRecord } from "../../src/workspace-versions.js";
import { WorkspaceVersionService } from "../../src/workspace-versions.js";
import { WorkspaceSnapshotStore } from "../../src/workspace-snapshot-store.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function versionFixture(input?: {
  roomId?: string;
  snapshotId?: string;
  files?: Array<{ path: string; content: Uint8Array }>;
}): Promise<{ artifacts: WorkspaceSnapshotStore; record: WorkspaceVersionRecord; ownerContents: Map<string, Uint8Array> }> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "dsh-collab-room-artifact-"));
  roots.push(artifactRoot);
  const roomId = input?.roomId ?? "room-1";
  const rawFiles = input?.files ?? [
    { path: "README.md", content: Buffer.from("hello\n") },
    { path: "src/app.ts", content: Buffer.from("export const app = true;\n") },
  ];
  const files: WorkspaceSnapshotFile[] = rawFiles.map((file) => ({
    path: file.path,
    contentHash: sha256(file.content),
    size: file.content.byteLength,
    source: "tracked",
  }));
  const snapshot: WorkspaceSnapshotPackage = {
    snapshotId: input?.snapshotId ?? "snapshot-1",
    roomId,
    hostSessionId: "session-host",
    roomEventSeq: 0,
    headOid: "a".repeat(40),
    manifestHash: sha256(JSON.stringify(files)),
    files,
    createdAt: 10,
  };
  const ownerContents = new Map(rawFiles.map((file) => [file.path, file.content]));
  const artifacts = new WorkspaceSnapshotStore(artifactRoot);
  await artifacts.save(snapshot, ownerContents);
  const rooms = new RoomStore();
  rooms.createRoom({ roomId, hostId: "host", hostSessionId: "session-host", title: "Room", hostDisplayName: "Host", now: 1 });
  const record = (await new WorkspaceVersionService({ rooms, ledger: new EventLedger(), artifacts })
    .create({ roomId, principalId: "host", snapshotId: snapshot.snapshotId })).record;
  return { artifacts, record, ownerContents };
}

describe("RoomWorkspaceMaterializer", () => {
  it("atomically creates a writable workspace, base manifest, and drafts directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-rooms-"));
    roots.push(root);
    const fixture = await versionFixture();
    const materializer = new RoomWorkspaceMaterializer({ root, artifacts: fixture.artifacts });

    const workspace = await materializer.materialize({ roomId: "room-1", record: fixture.record });

    expect(relative(root, workspace.root)).not.toMatch(/^\.\./);
    expect(await readFile(join(workspace.workspacePath, "README.md"), "utf8")).toBe("hello\n");
    expect((await stat(workspace.workspacePath)).isDirectory()).toBe(true);
    expect((await stat(workspace.draftsPath)).isDirectory()).toBe(true);
    expect(JSON.parse(await readFile(workspace.baseManifestPath, "utf8"))).toEqual({ version: 1, roomId: "room-1", record: fixture.record });
    await writeFile(join(workspace.workspacePath, "README.md"), "participant edit\n");
    expect(await readFile(join(workspace.workspacePath, "README.md"), "utf8")).toBe("participant edit\n");
    expect(await fixture.artifacts.readFile("snapshot-1", "README.md")).toEqual(fixture.ownerContents.get("README.md"));
  });

  it("preserves local edits on repeat materialization and restores the same workspace after restart", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-rooms-"));
    roots.push(root);
    const fixture = await versionFixture();
    const firstMaterializer = new RoomWorkspaceMaterializer({ root, artifacts: fixture.artifacts });
    const first = await firstMaterializer.materialize({ roomId: "room-1", record: fixture.record });
    await writeFile(join(first.workspacePath, "README.md"), "keep me\n");
    await writeFile(join(first.draftsPath, "draft.txt"), "draft");

    const repeated = await firstMaterializer.materialize({ roomId: "room-1", record: fixture.record });
    const restored = await new RoomWorkspaceMaterializer({ root, artifacts: fixture.artifacts }).open("room-1");

    expect(repeated.root).toBe(first.root);
    expect(restored?.root).toBe(first.root);
    expect(await readFile(join(restored!.workspacePath, "README.md"), "utf8")).toBe("keep me\n");
    expect(await readFile(join(restored!.draftsPath, "draft.txt"), "utf8")).toBe("draft");
  });

  it("converges concurrent materialization of the same immutable base", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-rooms-"));
    roots.push(root);
    const fixture = await versionFixture();
    const left = new RoomWorkspaceMaterializer({ root, artifacts: fixture.artifacts });
    const right = new RoomWorkspaceMaterializer({ root, artifacts: fixture.artifacts });

    const [first, second] = await Promise.all([
      left.materialize({ roomId: "room-1", record: fixture.record }),
      right.materialize({ roomId: "room-1", record: fixture.record }),
    ]);

    expect(second.root).toBe(first.root);
    expect(await readFile(join(first.workspacePath, "README.md"), "utf8")).toBe("hello\n");
    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("removes temporary state when artifact reading fails and never exposes a half workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-rooms-"));
    roots.push(root);
    const fixture = await versionFixture();
    const failingArtifacts: WorkspaceVersionArtifactStore = {
      load: (snapshotId) => fixture.artifacts.load(snapshotId),
      readFile: async (snapshotId, path) => {
        if (path === "src/app.ts") throw new Error("download interrupted");
        return await fixture.artifacts.readFile(snapshotId, path);
      },
    };
    const materializer = new RoomWorkspaceMaterializer({ root, artifacts: failingArtifacts });

    await expect(materializer.materialize({ roomId: "room-1", record: fixture.record })).rejects.toThrow("interrupted");
    await expect(materializer.open("room-1")).resolves.toBeUndefined();
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("ignores abandoned temp directories and rejects replacing an existing different base", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-rooms-"));
    roots.push(root);
    const firstFixture = await versionFixture({ snapshotId: "snapshot-1" });
    const secondFixture = await versionFixture({ snapshotId: "snapshot-2", files: [{ path: "README.md", content: Buffer.from("next\n") }] });
    const materializer = new RoomWorkspaceMaterializer({ root, artifacts: firstFixture.artifacts });
    await mkdir(join(root, ".abandoned.tmp"));
    await expect(materializer.open("room-1")).resolves.toBeUndefined();
    await materializer.materialize({ roomId: "room-1", record: firstFixture.record });

    const secondMaterializer = new RoomWorkspaceMaterializer({ root, artifacts: secondFixture.artifacts });
    await expect(secondMaterializer.materialize({ roomId: "room-1", record: secondFixture.record })).rejects.toThrow("base");
    expect(await readFile(join((await materializer.open("room-1"))!.workspacePath, "README.md"), "utf8")).toBe("hello\n");
  });

  it("contains hostile room ids and rejects unsafe artifact paths before writing", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-rooms-"));
    roots.push(root);
    const roomId = "../../outside:C:\\repo";
    const fixture = await versionFixture({ roomId });
    const materializer = new RoomWorkspaceMaterializer({ root, artifacts: fixture.artifacts });
    const workspace = await materializer.materialize({ roomId, record: fixture.record });
    expect(relative(root, workspace.root)).not.toMatch(/^\.\./);

    const forged = structuredClone(fixture.record);
    forged.version.files[0]!.path = "../secret";
    await expect(materializer.materialize({ roomId: "another-room", record: forged })).rejects.toThrow(/path|room/i);
  });
});
