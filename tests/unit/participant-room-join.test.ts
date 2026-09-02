import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceSnapshotFile, WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { DshRoomProjectRegistrar } from "../../src/dsh-room-projects.js";
import { ParticipantRoomWorkspaceJoiner } from "../../src/participant-room-join.js";
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

async function latestVersionFixture(roomId = "room-atlas"): Promise<{
  artifacts: WorkspaceSnapshotStore;
  record: WorkspaceVersionRecord;
}> {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-participant-room-"));
  roots.push(root);
  const content = Buffer.from("export const shared = true;\n");
  const files: WorkspaceSnapshotFile[] = [{
    path: "src/shared.ts",
    contentHash: sha256(content),
    size: content.byteLength,
    source: "tracked",
  }];
  const snapshot: WorkspaceSnapshotPackage = {
    snapshotId: "published-snapshot",
    roomId,
    hostSessionId: "legacy-host-session",
    roomEventSeq: 2,
    manifestHash: sha256(JSON.stringify(files)),
    files,
    createdAt: 20,
  };
  const artifacts = new WorkspaceSnapshotStore(join(root, "artifacts"));
  await artifacts.save(snapshot, new Map([["src/shared.ts", content]]));
  const versionFiles = files.map(({ path, contentHash, size }) => ({ path, contentHash, size, mode: "text" as const }));
  return {
    artifacts,
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

async function joinerFixture(input: { downloadLatest(input: { roomId: string; token: string }): Promise<{ record: WorkspaceVersionRecord }> }) {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-participant-workspace-"));
  roots.push(root);
  const store = new RoomProjectStore();
  const snapshots: RoomProjectSnapshot[] = [];
  const dshCalls: unknown[][] = [];
  const registrar = new DshRoomProjectRegistrar({
    store,
    persistence: { save: async (snapshot) => { snapshots.push(snapshot); } },
    workspaces: {
      create: async (request) => {
        dshCalls.push(["create", request]);
        return { workspaceId: "dsh-workspace-atlas" };
      },
      rename: async (workspaceId, title) => { dshCalls.push(["rename", workspaceId, title]); },
    },
  });
  return {
    createJoiner: (artifacts: WorkspaceSnapshotStore) => new ParticipantRoomWorkspaceJoiner({
      versions: input,
      materializer: new RoomWorkspaceMaterializer({ root, artifacts }),
      registrar,
    }),
    dshCalls,
    snapshots,
    store,
  };
}

describe("ParticipantRoomWorkspaceJoiner", () => {
  it("downloads only on explicit join, materializes one local Room Workspace, and registers its native project", async () => {
    const latest = await latestVersionFixture();
    const downloads: Array<{ roomId: string; token: string }> = [];
    const fixture = await joinerFixture({
      downloadLatest: async (input) => {
        downloads.push(input);
        return { record: latest.record };
      },
    });
    const joiner = fixture.createJoiner(latest.artifacts);

    expect(downloads).toEqual([]);
    const joined = await joiner.join({ roomId: "room-atlas", memberId: "participant-member", roomTitle: "Atlas", token: "room-token" });

    expect(downloads).toEqual([{ roomId: "room-atlas", token: "room-token" }]);
    expect(await readFile(join(joined.workspace.workspacePath, "src", "shared.ts"), "utf8")).toBe("export const shared = true;\n");
    expect(fixture.dshCalls).toEqual([
      ["create", { path: joined.workspace.workspacePath }],
      ["rename", "dsh-workspace-atlas", "Atlas"],
    ]);
    expect(joined.project).toEqual({
      roomId: "room-atlas",
      memberId: "participant-member",
      roomTitle: "Atlas",
      workspacePath: joined.workspace.workspacePath,
      nativeWorkspaceId: "dsh-workspace-atlas",
    });
    expect(fixture.snapshots).toHaveLength(1);
  });

  it("does not create a local project before an explicit latest-version download succeeds", async () => {
    const latest = await latestVersionFixture();
    const fixture = await joinerFixture({
      downloadLatest: async () => { throw new Error("room is unavailable"); },
    });

    await expect(fixture.createJoiner(latest.artifacts).join({
      roomId: "room-atlas", memberId: "participant-member", roomTitle: "Atlas", token: "room-token",
    })).rejects.toThrow("room is unavailable");

    expect(fixture.store.list()).toEqual([]);
    expect(fixture.dshCalls).toEqual([]);
  });

  it("rejects a downloaded version from another room before materializing or registering it", async () => {
    const latest = await latestVersionFixture("room-other");
    const fixture = await joinerFixture({ downloadLatest: async () => ({ record: latest.record }) });

    await expect(fixture.createJoiner(latest.artifacts).join({
      roomId: "room-atlas", memberId: "participant-member", roomTitle: "Atlas", token: "room-token",
    })).rejects.toThrow("different room");

    expect(fixture.store.list()).toEqual([]);
    expect(fixture.dshCalls).toEqual([]);
  });
});
