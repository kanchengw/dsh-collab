import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceSnapshotFile, WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { DshRoomProjectRegistrar } from "../../src/dsh-room-projects.js";
import { OwnerRoomWorkspaceBootstrapper } from "../../src/owner-room-bootstrap.js";
import { RoomProjectStore, type RoomProjectSnapshot } from "../../src/room-projects.js";
import { RoomWorkspaceMaterializer } from "../../src/room-workspace.js";
import { WorkspaceSnapshotStore } from "../../src/workspace-snapshot-store.js";
import type { WorkspaceVersionRecord } from "../../src/workspace-versions.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function initialVersionFixture(roomId = "room-atlas"): Promise<{
  artifacts: WorkspaceSnapshotStore;
  record: WorkspaceVersionRecord;
  sourcePath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-owner-room-"));
  roots.push(root);
  const sourcePath = join(root, "owner-source");
  const artifactPath = join(root, "artifacts");
  await mkdir(sourcePath);
  await writeFile(join(sourcePath, "README.md"), "owner source remains private\n");

  const content = Buffer.from("owner source remains private\n");
  const files: WorkspaceSnapshotFile[] = [{
    path: "README.md",
    contentHash: sha256(content),
    size: content.byteLength,
    source: "tracked",
  }];
  const snapshot: WorkspaceSnapshotPackage = {
    snapshotId: "initial-snapshot",
    roomId,
    hostSessionId: "source-session",
    roomEventSeq: 0,
    manifestHash: sha256(JSON.stringify(files)),
    files,
    createdAt: 10,
  };
  const artifacts = new WorkspaceSnapshotStore(artifactPath);
  await artifacts.save(snapshot, new Map([["README.md", content]]));

  const versionFiles = files.map(({ path, contentHash, size }) => ({ path, contentHash, size, mode: "text" as const }));
  return {
    artifacts,
    sourcePath,
    record: {
      version: {
        workspaceVersionId: snapshot.snapshotId,
        roomId,
        files: versionFiles,
        createdBy: "owner-member",
        createdAt: snapshot.createdAt,
      },
      manifestHash: sha256(JSON.stringify(versionFiles)),
      artifact: {
        kind: "workspace-snapshot.v1",
        snapshotId: snapshot.snapshotId,
        manifestHash: snapshot.manifestHash,
        totalBytes: content.byteLength,
      },
    },
  };
}

async function bootstrapFixture(input: {
  connectWorkspace(): Promise<string>;
  openSession(sessionId: string): void;
}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-owner-workspace-"));
  roots.push(root);
  const store = new RoomProjectStore();
  const snapshots: RoomProjectSnapshot[] = [];
  const dshCalls: unknown[][] = [];
  const registrar = new DshRoomProjectRegistrar({
    store,
    persistence: { save: async (snapshot) => { snapshots.push(snapshot); } },
    workspaces: {
      create: async (path, title) => {
        dshCalls.push(["create", path, title]);
        return { workspaceId: "dsh-workspace-atlas" };
      },
    },
  });
  return {
    bootstrap: (artifacts: WorkspaceSnapshotStore) => new OwnerRoomWorkspaceBootstrapper({
      materializer: new RoomWorkspaceMaterializer({ root, artifacts }),
      registrar,
      workspaceNavigation: {
        connectWorkspace: input.connectWorkspace,
        sessions: { open: input.openSession },
      },
    }),
    dshCalls,
    snapshots,
    store,
  };
}

describe("OwnerRoomWorkspaceBootstrapper", () => {
  it("supports server-side prepare and complete without browser navigation", async () => {
    const initial = await initialVersionFixture();
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-owner-workspace-server-"));
    roots.push(root);
    const store = new RoomProjectStore();
    const bootstrap = new OwnerRoomWorkspaceBootstrapper({
      materializer: new RoomWorkspaceMaterializer({ root, artifacts: initial.artifacts }),
      registrar: new DshRoomProjectRegistrar({
        store,
        persistence: { save: async () => {} },
        workspaces: { create: async () => ({ workspaceId: "dsh-workspace-atlas" }) },
      }),
    });

    const prepared = await bootstrap.prepare({
      roomId: "room-atlas",
      memberId: "owner-member",
      roomTitle: "Atlas",
      initialVersion: initial.record,
    });
    await bootstrap.complete({ roomId: "room-atlas", sessionId: "host-primary-session" });

    expect(prepared.project.nativeWorkspaceId).toBe("dsh-workspace-atlas");
    expect(store.get("room-atlas")?.hostPrimarySessionId).toBe("host-primary-session");
  });

  it("rejects the legacy one-step create before side effects when browser navigation is unavailable", async () => {
    const initial = await initialVersionFixture();
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-owner-workspace-no-navigation-"));
    roots.push(root);
    const store = new RoomProjectStore();
    const bootstrap = new OwnerRoomWorkspaceBootstrapper({
      materializer: new RoomWorkspaceMaterializer({ root, artifacts: initial.artifacts }),
      registrar: new DshRoomProjectRegistrar({
        store,
        persistence: { save: async () => {} },
        workspaces: { create: async () => ({ workspaceId: "dsh-workspace-atlas" }) },
      }),
    });

    await expect(bootstrap.create({
      roomId: "room-atlas",
      memberId: "owner-member",
      roomTitle: "Atlas",
      initialVersion: initial.record,
    })).rejects.toThrow(/navigation/i);
    expect(store.list()).toEqual([]);
  });

  it("materializes an immutable source version before registering a native project and fresh Host Primary Session", async () => {
    const initial = await initialVersionFixture();
    const calls: string[] = [];
    const fixture = await bootstrapFixture({
      connectWorkspace: async () => {
        calls.push("connect");
        return "host-primary-session";
      },
      openSession: (sessionId) => calls.push("open:" + sessionId),
    });

    const created = await fixture.bootstrap(initial.artifacts).create({
      roomId: "room-atlas",
      memberId: "owner-member",
      roomTitle: "Atlas",
      initialVersion: initial.record,
    });

    expect(await readFile(join(initial.sourcePath, "README.md"), "utf8")).toBe("owner source remains private\n");
    expect(await readFile(join(created.workspace.workspacePath, "README.md"), "utf8")).toBe("owner source remains private\n");
    expect(fixture.dshCalls).toEqual([["create", created.workspace.workspacePath, "Atlas"]]);
    expect(calls).toEqual(["connect", "open:host-primary-session"]);
    expect(created.project).toMatchObject({
      roomId: "room-atlas",
      nativeWorkspaceId: "dsh-workspace-atlas",
      hostPrimarySessionId: "host-primary-session",
    });
    expect(fixture.snapshots).toHaveLength(2);
  });

  it("does not assign a Host Primary Session when native DSH connection fails", async () => {
    const initial = await initialVersionFixture();
    const fixture = await bootstrapFixture({
      connectWorkspace: async () => { throw new Error("DSH connect unavailable"); },
      openSession: (sessionId) => { throw new Error("unexpected open: " + sessionId); },
    });

    await expect(fixture.bootstrap(initial.artifacts).create({
      roomId: "room-atlas",
      memberId: "owner-member",
      roomTitle: "Atlas",
      initialVersion: initial.record,
    })).rejects.toThrow("DSH connect unavailable");

    expect(await readFile(join(initial.sourcePath, "README.md"), "utf8")).toBe("owner source remains private\n");
    expect(fixture.store.get("room-atlas")).toMatchObject({
      nativeWorkspaceId: "dsh-workspace-atlas",
    });
    expect(fixture.store.get("room-atlas")?.hostPrimarySessionId).toBeUndefined();
  });

  it("rejects an initial version from another room before creating files or native DSH state", async () => {
    const initial = await initialVersionFixture("room-other");
    const fixture = await bootstrapFixture({
      connectWorkspace: async () => "host-primary-session",
      openSession: () => { throw new Error("unexpected open"); },
    });

    await expect(fixture.bootstrap(initial.artifacts).create({
      roomId: "room-atlas",
      memberId: "owner-member",
      roomTitle: "Atlas",
      initialVersion: initial.record,
    })).rejects.toThrow("different room");

    expect(fixture.store.list()).toEqual([]);
    expect(fixture.dshCalls).toEqual([]);
  });
});
