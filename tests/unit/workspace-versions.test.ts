import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshotFile, WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { EventLedger } from "../../src/events.js";
import { RoomStore } from "../../src/room.js";
import {
  WorkspaceVersionService,
  validateWorkspaceVersionRecord,
} from "../../src/workspace-versions.js";
import { WorkspaceSnapshotStore } from "../../src/workspace-snapshot-store.js";
import { WorkspaceSnapshotCapture, type WorkspaceFilePort } from "../../src/workspace-snapshot.js";
import type { RepositoryCommandPort } from "../../src/repository-inspector.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rooms(): RoomStore {
  const store = new RoomStore();
  store.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Room", hostDisplayName: "Host", now: 1 });
  store.addMember("room-1", { memberId: "member-alice", principalId: "alice", displayName: "Alice", now: 2 });
  return store;
}

async function artifact(input: {
  root: string;
  snapshotId?: string;
  roomId?: string;
  hostSessionId?: string;
  createdAt?: number;
  files?: Array<{ path: string; content: Uint8Array; source?: WorkspaceSnapshotFile["source"] }>;
}): Promise<{ snapshot: WorkspaceSnapshotPackage; store: WorkspaceSnapshotStore }> {
  const files: Array<{ path: string; content: Uint8Array; source?: WorkspaceSnapshotFile["source"] }> = input.files ?? [
    { path: "README.md", content: Buffer.from("hello\n") },
    { path: "assets/logo.bin", content: Uint8Array.from([0, 1, 2]) },
  ];
  const manifest: WorkspaceSnapshotFile[] = files.map((file) => ({
    path: file.path,
    contentHash: sha256(file.content),
    size: file.content.byteLength,
    source: file.source ?? "tracked",
  }));
  const snapshot: WorkspaceSnapshotPackage = {
    snapshotId: input.snapshotId ?? "snapshot-1",
    roomId: input.roomId ?? "room-1",
    hostSessionId: input.hostSessionId ?? "session-host",
    roomEventSeq: 0,
    headOid: "a".repeat(40),
    manifestHash: sha256(JSON.stringify(manifest)),
    files: manifest,
    createdAt: input.createdAt ?? 100,
  };
  const store = new WorkspaceSnapshotStore(input.root);
  await store.save(snapshot, new Map(files.map((file) => [file.path, file.content])));
  return { snapshot, store };
}

describe("WorkspaceVersion domain/store", () => {
  it("registers a complete immutable Snapshot artifact as a durable Owner version", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-version-"));
    roots.push(root);
    const { snapshot, store } = await artifact({ root });
    const roomStore = rooms();
    const ledger = new EventLedger();
    const service = new WorkspaceVersionService({ rooms: roomStore, ledger, artifacts: store });

    const result = await service.create({ roomId: "room-1", principalId: "host", snapshotId: snapshot.snapshotId });

    expect(result.created).toBe(true);
    expect(result.record.version).toEqual({
      workspaceVersionId: "snapshot-1",
      roomId: "room-1",
      headOid: "a".repeat(40),
      files: [
        { path: "README.md", contentHash: sha256("hello\n"), size: 6, mode: "text" },
        { path: "assets/logo.bin", contentHash: sha256(Uint8Array.from([0, 1, 2])), size: 3, mode: "binary" },
      ],
      createdBy: "member-host",
      createdAt: 100,
    });
    expect(result.record.manifestHash).toBe(sha256(JSON.stringify(result.record.version.files)));
    expect(result.record.artifact).toEqual({
      kind: "workspace-snapshot.v1",
      snapshotId: "snapshot-1",
      manifestHash: snapshot.manifestHash,
      totalBytes: 9,
    });
    expect(result.event).toMatchObject({
      eventId: "workspace-version:snapshot-1",
      type: "workspace-version.published",
      actor: { memberId: "member-host", principalId: "host" },
      createdAt: 100,
      payload: result.record,
    });
    expect(service.get("room-1", "snapshot-1")).toEqual(result.record);
    expect(service.latest("room-1")).toEqual(result.record);
  });

  it("is idempotent for the same artifact and creates a strict parent chain", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-version-"));
    roots.push(root);
    const firstArtifact = await artifact({ root, snapshotId: "snapshot-1", createdAt: 100 });
    await artifact({ root, snapshotId: "snapshot-2", createdAt: 200, files: [{ path: "README.md", content: Buffer.from("next\n") }] });
    const ledger = new EventLedger();
    const service = new WorkspaceVersionService({ rooms: rooms(), ledger, artifacts: firstArtifact.store });

    const first = await service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-1" });
    expect(await service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-1" })).toEqual({ ...first, created: false });
    await expect(service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-2" })).rejects.toThrow("parent");
    const second = await service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-2", parentVersionId: "snapshot-1" });

    expect(second.record.version.parentVersionId).toBe("snapshot-1");
    expect(service.list("room-1").map((record) => record.version.workspaceVersionId)).toEqual(["snapshot-1", "snapshot-2"]);
    expect(ledger.latestSeq("room-1")).toBe(2);
  });

  it("serializes concurrent retries and rejects concurrent sibling versions", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-version-"));
    roots.push(root);
    const firstArtifact = await artifact({ root, snapshotId: "snapshot-1", createdAt: 100 });
    await artifact({ root, snapshotId: "snapshot-2", createdAt: 200, files: [{ path: "README.md", content: Buffer.from("second\n") }] });
    await artifact({ root, snapshotId: "snapshot-3", createdAt: 300, files: [{ path: "README.md", content: Buffer.from("third\n") }] });
    const ledger = new EventLedger();
    const service = new WorkspaceVersionService({ rooms: rooms(), ledger, artifacts: firstArtifact.store });

    const retries = await Promise.all([
      service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-1" }),
      service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-1" }),
    ]);
    expect(retries.filter((result) => result.created)).toHaveLength(1);
    expect(service.list("room-1")).toHaveLength(1);

    const siblings = await Promise.allSettled([
      service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-2", parentVersionId: "snapshot-1" }),
      service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-3", parentVersionId: "snapshot-1" }),
    ]);
    expect(siblings.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(siblings.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(service.list("room-1")).toHaveLength(2);
    expect(ledger.latestSeq("room-1")).toBe(2);
  });

  it("keeps content manifest hashes stable across distinct artifact identities", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-version-"));
    roots.push(root);
    const firstArtifact = await artifact({ root, snapshotId: "snapshot-1", createdAt: 100 });
    await artifact({ root, snapshotId: "snapshot-2", createdAt: 200 });
    const service = new WorkspaceVersionService({ rooms: rooms(), ledger: new EventLedger(), artifacts: firstArtifact.store });

    const first = await service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-1" });
    const second = await service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-2", parentVersionId: "snapshot-1" });

    expect(second.record.manifestHash).toBe(first.record.manifestHash);
    expect(second.record.version.workspaceVersionId).not.toBe(first.record.version.workspaceVersionId);
  });

  it("rejects non-Owner publication, wrong room/session artifacts, and corrupted blobs", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-version-"));
    roots.push(root);
    const { store } = await artifact({ root, snapshotId: "snapshot-1" });
    await artifact({ root, snapshotId: "snapshot-room-2", roomId: "room-2" });
    await artifact({ root, snapshotId: "snapshot-wrong-session", hostSessionId: "session-other" });
    const service = new WorkspaceVersionService({ rooms: rooms(), ledger: new EventLedger(), artifacts: store });

    await expect(service.create({ roomId: "room-1", principalId: "alice", snapshotId: "snapshot-1" })).rejects.toThrow("allowed");
    await expect(service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-room-2" })).rejects.toThrow("room");
    await expect(service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-wrong-session" })).rejects.toThrow("Session");
    const snapshot = await store.load("snapshot-1");
    await writeFile(join(root, "snapshot-1", "blobs", snapshot!.files[0]!.contentHash), "tampered");
    await expect(service.create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-1" })).rejects.toThrow("corrupted");
  });

  it("restores its metadata index from valid Ledger events and rejects forged records", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-version-"));
    roots.push(root);
    const { store } = await artifact({ root });
    const roomStore = rooms();
    const ledger = new EventLedger();
    const created = await new WorkspaceVersionService({ rooms: roomStore, ledger, artifacts: store })
      .create({ roomId: "room-1", principalId: "host", snapshotId: "snapshot-1" });

    const restored = new WorkspaceVersionService({ rooms: RoomStore.fromSnapshot(roomStore.snapshot()), ledger: EventLedger.fromSnapshot(ledger.snapshot()), artifacts: store });
    expect(restored.latest("room-1")).toEqual(created.record);

    const forged = ledger.snapshot();
    (forged.rooms[0]!.events[0]!.payload as Record<string, unknown>).transcript = "private";
    expect(() => new WorkspaceVersionService({ rooms: roomStore, ledger: EventLedger.fromSnapshot(forged), artifacts: store })).toThrow("snapshot");
    expect(() => validateWorkspaceVersionRecord({ ...created.record, manifestHash: "0".repeat(64) })).toThrow("manifest");
  });

  it("reuses Git capture scope and excludes metadata, ignored output, and symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-version-"));
    roots.push(root);
    const run = vi.fn<RepositoryCommandPort["run"]>(async (args) => {
      const command = args.join(" ");
      if (command === "rev-parse --show-toplevel") return { exitCode: 0, stdout: "C:/repo\n", stderr: "" };
      if (command === "rev-parse --verify --quiet HEAD") return { exitCode: 0, stdout: `${"a".repeat(40)}\n`, stderr: "" };
      if (command === "ls-files -z --cached") return { exitCode: 0, stdout: ".git/config\0src/tracked.ts\0link.ts\0", stderr: "" };
      if (command === "ls-files -z --others --exclude-standard") return { exitCode: 0, stdout: "src/new.ts\0", stderr: "" };
      throw new Error(command);
    });
    const contents = new Map([["src/tracked.ts", Buffer.from("tracked")], ["src/new.ts", Buffer.from("new")]]);
    const files: WorkspaceFilePort = {
      inspect: async (path) => path === "link.ts" ? "symlink" : "file",
      read: async (path) => contents.get(path)!,
    };
    const capture = new WorkspaceSnapshotCapture({ commands: { run }, files, store: new WorkspaceSnapshotStore(root), snapshotIdFactory: () => "snapshot-1", now: () => 100 });

    const snapshot = await capture.capture({ roomId: "room-1", hostSessionId: "session-host", roomEventSeq: 0 });

    expect(run).toHaveBeenCalledWith(["ls-files", "-z", "--others", "--exclude-standard"], undefined);
    expect(snapshot.files.map((file) => file.path)).toEqual(["src/new.ts", "src/tracked.ts"]);
  });

  it("rejects non-Git and path-escaping capture input before a version exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-version-"));
    roots.push(root);
    const files: WorkspaceFilePort = { inspect: async () => "file", read: async () => Buffer.from("x") };
    const nonGit = new WorkspaceSnapshotCapture({
      commands: { run: async () => ({ exitCode: 128, stdout: "", stderr: "fatal: not a git repository" }) },
      files,
      store: new WorkspaceSnapshotStore(join(root, "non-git")),
    });
    await expect(nonGit.capture({ roomId: "room-1", hostSessionId: "session-host", roomEventSeq: 0 })).rejects.toMatchObject({ code: "WORKSPACE_NOT_GIT" });

    const escape = new WorkspaceSnapshotCapture({
      commands: { run: async (args) => {
        const command = args.join(" ");
        if (command === "rev-parse --show-toplevel") return { exitCode: 0, stdout: "C:/repo\n", stderr: "" };
        if (command === "rev-parse --verify --quiet HEAD") return { exitCode: 1, stdout: "", stderr: "" };
        if (command === "ls-files -z --cached") return { exitCode: 0, stdout: "../secret\0", stderr: "" };
        return { exitCode: 0, stdout: "", stderr: "" };
      } },
      files,
      store: new WorkspaceSnapshotStore(join(root, "escape")),
    });
    await expect(escape.capture({ roomId: "room-1", hostSessionId: "session-host", roomEventSeq: 0 })).rejects.toMatchObject({ code: "WORKSPACE_PATH_UNSAFE" });
  });
});
