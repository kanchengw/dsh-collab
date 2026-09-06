import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DshRoomProjectRegistrar } from "../../src/dsh-room-projects.js";
import { RoomProjectStore, type RoomProjectSnapshot } from "../../src/room-projects.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `dsh-collab-dsh-room-project-${name}-`));
  directories.push(directory);
  return directory;
}

function registrarFixture() {
  const store = new RoomProjectStore();
  const calls: unknown[][] = [];
  const snapshots: RoomProjectSnapshot[] = [];
  const registrar = new DshRoomProjectRegistrar({
    store,
    persistence: { save: async (snapshot) => { snapshots.push(snapshot); } },
    workspaces: {
      create: async (path, title) => {
        calls.push(["create", path, title]);
        return { workspaceId: "dsh-workspace-1" };
      },
    },
  });
  return { calls, registrar, snapshots, store };
}

describe("DshRoomProjectRegistrar", () => {
  it("canonicalizes an existing workspace before calling the DSH registry", async () => {
    const path = await workspace("canonical-target");
    const alias = join(path, "..", "canonical-alias");
    await symlink(path, alias, "junction");
    directories.push(alias);
    const { calls, registrar, store } = registrarFixture();

    await registrar.register({ roomId: "room-canonical", memberId: "member-1", roomTitle: "Atlas", workspacePath: alias });

    expect(calls[0]).toEqual(["create", path, "Atlas"]);
    expect(store.get("room-canonical")?.workspacePath).toBe(path);
  });

  it("fails before mutating Collab state when the workspace directory does not exist", async () => {
    const missing = join(await workspace("missing-parent"), "not-created");
    const { calls, registrar, store } = registrarFixture();

    await expect(registrar.register({ roomId: "room-missing", memberId: "member-1", roomTitle: "Atlas", workspacePath: missing }))
      .rejects.toThrow(/workspace|ENOENT/i);

    expect(calls).toEqual([]);
    expect(store.get("room-missing")).toBeUndefined();
  });

  it("creates, names, and durably records the first native DSH project", async () => {
    const path = await workspace("first");
    const { calls, registrar, snapshots, store } = registrarFixture();

    await expect(registrar.register({ roomId: "room-1", memberId: "member-1", roomTitle: "Atlas", workspacePath: path })).resolves.toEqual({
      roomId: "room-1",
      memberId: "member-1",
      roomTitle: "Atlas",
      workspacePath: path,
      nativeWorkspaceId: "dsh-workspace-1",
    });

    expect(calls).toEqual([["create", path, "Atlas"]]);
    expect(snapshots).toEqual([store.snapshot()]);
  });

  it("reuses a registered native DSH project without overwriting a user rename", async () => {
    const path = await workspace("reuse");
    const { calls, registrar, snapshots, store } = registrarFixture();
    store.register({ roomId: "room-1", memberId: "member-1", roomTitle: "Atlas", workspacePath: path });
    store.setNativeWorkspaceId({ roomId: "room-1", nativeWorkspaceId: "dsh-workspace-1" });

    await expect(registrar.register({ roomId: "room-1", memberId: "member-1", roomTitle: "Atlas renamed", workspacePath: path })).resolves.toMatchObject({
      roomTitle: "Atlas renamed",
      nativeWorkspaceId: "dsh-workspace-1",
    });

    expect(calls).toEqual([]);
    expect(snapshots).toEqual([store.snapshot()]);
  });

  it("does not commit a local registration when DSH creation fails", async () => {
    const path = await workspace("failure");
    const store = new RoomProjectStore();
    const snapshots: RoomProjectSnapshot[] = [];
    const registrar = new DshRoomProjectRegistrar({
      store,
      persistence: { save: async (snapshot) => { snapshots.push(snapshot); } },
      workspaces: { create: async () => { throw new Error("DSH unavailable"); } },
    });

    await expect(registrar.register({ roomId: "room-1", memberId: "member-1", roomTitle: "Atlas", workspacePath: path })).rejects.toThrow("DSH unavailable");
    expect(store.list()).toEqual([]);
    expect(snapshots).toEqual([]);
  });

  it("does not commit a local registration when DSH creation fails", async () => {
    const path = await workspace("create-failure");
    const store = new RoomProjectStore();
    const snapshots: RoomProjectSnapshot[] = [];
    const registrar = new DshRoomProjectRegistrar({
      store,
      persistence: { save: async (snapshot) => { snapshots.push(snapshot); } },
      workspaces: { create: async () => { throw new Error("DSH create unavailable"); } },
    });

    await expect(registrar.register({ roomId: "room-1", memberId: "member-1", roomTitle: "Atlas", workspacePath: path })).rejects.toThrow("DSH create unavailable");
    expect(store.list()).toEqual([]);
    expect(snapshots).toEqual([]);
  });
});
