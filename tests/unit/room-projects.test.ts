import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RoomProjectFile,
  RoomProjectStore,
  resolveDefaultRoomProjectFile,
  type RoomProjectSnapshot,
} from "../../src/room-projects.js";
import { createRoomProjectId } from "../../src/room-project-identity.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `dsh-collab-room-project-${name}-`));
  directories.push(directory);
  return directory;
}

describe("RoomProjectStore", () => {
  it("registers one local room project and normalizes its path", async () => {
    const workspacePath = await workspace("project");
    const store = new RoomProjectStore();

    const project = store.register({
      roomId: " room-1 ",
      memberId: " member-1 ",
      roomTitle: "  Atlas  ",
      workspacePath: workspacePath + "/.",
    });

    expect(project).toEqual({
      roomId: "room-1",
      memberId: "member-1",
      roomTitle: "Atlas",
      workspacePath,
    });
    expect(store.get("room-1")).toEqual(project);
    expect(store.getByWorkspacePath(workspacePath)).toEqual(project);
  });

  it("rejects mapping one workspace to different rooms or moving an existing room", async () => {
    const firstWorkspace = await workspace("first");
    const secondWorkspace = await workspace("second");
    const store = new RoomProjectStore();
    store.register({ roomId: "room-1", memberId: "member-1", roomTitle: "One", workspacePath: firstWorkspace });

    expect(() => store.register({ roomId: "room-2", memberId: "member-2", roomTitle: "Two", workspacePath: firstWorkspace })).toThrow(/workspace/i);
    expect(() => store.register({ roomId: "room-1", memberId: "member-1", roomTitle: "One", workspacePath: secondWorkspace })).toThrow("another workspace");
  });

  it("updates the native Workspace id and replaces a rejoined member explicitly", async () => {
    const workspacePath = await workspace("rejoin");
    const store = new RoomProjectStore();
    store.register({ roomId: "room-1", memberId: "member-old", roomTitle: "Atlas", workspacePath });

    expect(store.setNativeWorkspaceId({ roomId: "room-1", nativeWorkspaceId: "dsh-ws-1" })).toMatchObject({
      memberId: "member-old",
      nativeWorkspaceId: "dsh-ws-1",
    });
    expect(store.replaceMember({ roomId: "room-1", memberId: "member-new" })).toEqual({
      roomId: "room-1",
      memberId: "member-new",
      roomTitle: "Atlas",
      workspacePath,
      nativeWorkspaceId: "dsh-ws-1",
    });
  });

  it("keeps an idempotent registration attached to its native Workspace and rejects ownership conflicts", async () => {
    const firstWorkspace = await workspace("idempotent-first");
    const secondWorkspace = await workspace("idempotent-second");
    const store = new RoomProjectStore();
    store.register({ roomId: "room-1", memberId: "member-1", roomTitle: "Atlas", workspacePath: firstWorkspace });
    store.setNativeWorkspaceId({ roomId: "room-1", nativeWorkspaceId: "dsh-ws-1" });

    expect(store.register({ roomId: "room-1", memberId: "member-1", roomTitle: "Atlas refresh", workspacePath: firstWorkspace })).toEqual({
      roomId: "room-1",
      memberId: "member-1",
      roomTitle: "Atlas refresh",
      workspacePath: firstWorkspace,
      nativeWorkspaceId: "dsh-ws-1",
    });
    expect(() => store.register({ roomId: "room-1", memberId: "member-2", roomTitle: "Atlas", workspacePath: firstWorkspace })).toThrow("another member");

    store.register({ roomId: "room-2", memberId: "member-2", roomTitle: "Borealis", workspacePath: secondWorkspace });
    expect(() => store.setNativeWorkspaceId({ roomId: "room-2", nativeWorkspaceId: "dsh-ws-1" })).toThrow("another Room Project");
  });

  it("keeps an opaque room id separate from its one Host Primary Session", async () => {
    const firstWorkspace = await workspace("primary-first");
    const secondWorkspace = await workspace("primary-second");
    const store = new RoomProjectStore();
    const roomId = createRoomProjectId(() => "17d4a418-bb9c-4f80-a8ac-90c0353cb7b1");
    store.register({ roomId, memberId: "member-owner", roomTitle: "Atlas", workspacePath: firstWorkspace });
    store.register({ roomId: "room-2", memberId: "member-owner", roomTitle: "Borealis", workspacePath: secondWorkspace });

    expect(roomId).toBe("room-17d4a418-bb9c-4f80-a8ac-90c0353cb7b1");
    expect(roomId).not.toBe("native-session-1");
    expect(store.setHostPrimarySessionId({ roomId, sessionId: "native-session-1" })).toMatchObject({
      roomId,
      hostPrimarySessionId: "native-session-1",
    });
    expect(store.setHostPrimarySessionId({ roomId, sessionId: "native-session-1" })).toMatchObject({
      hostPrimarySessionId: "native-session-1",
    });
    expect(() => store.setHostPrimarySessionId({ roomId, sessionId: "native-session-2" })).toThrow("already has a Host Primary Session");
    expect(() => store.setHostPrimarySessionId({ roomId: "room-2", sessionId: "native-session-1" })).toThrow("another Room Project");
  });

  it("round-trips validated state and fails closed for malformed or duplicated records", async () => {
    const workspacePath = await workspace("restore");
    const store = new RoomProjectStore();
    store.register({ roomId: "room-1", memberId: "member-1", roomTitle: "Atlas", workspacePath });
    const snapshot = store.snapshot();

    expect(RoomProjectStore.fromSnapshot(snapshot).snapshot()).toEqual(snapshot);
    expect(() => RoomProjectStore.fromSnapshot({ version: 2, projects: [] } as unknown as RoomProjectSnapshot)).toThrow("snapshot");
    expect(() => RoomProjectStore.fromSnapshot({ version: 1, projects: [snapshot.projects[0]!, snapshot.projects[0]!] })).toThrow("snapshot");
  });
});

describe("RoomProjectFile", () => {
  it("uses local DSH state and atomically persists a validated project snapshot", async () => {
    expect(resolveDefaultRoomProjectFile({ DSH_HOME: "C:\\dsh-test" })).toBe(join("C:\\dsh-test", "collab", "v3", "room-projects.json"));
    const root = await workspace("state");
    const workspacePath = await workspace("workspace");
    const path = join(root, "nested", "room-projects.json");
    const file = new RoomProjectFile(path);
    const store = new RoomProjectStore();
    store.register({ roomId: "room-1", memberId: "member-1", roomTitle: "Atlas", workspacePath });
    store.setHostPrimarySessionId({ roomId: "room-1", sessionId: "native-session-1" });

    await file.save(store.snapshot());

    await expect(file.load()).resolves.toEqual(store.snapshot());
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(store.snapshot());
  });

  it("treats an absent file as no projects and rejects malformed persisted data", async () => {
    const root = await workspace("missing");
    const path = join(root, "room-projects.json");
    const file = new RoomProjectFile(path);

    await expect(file.load()).resolves.toBeUndefined();
    await writeFile(path, JSON.stringify({ version: 1, projects: [{ roomId: "room-1" }] }), "utf8");
    await expect(file.load()).rejects.toThrow("state is malformed");
  });
});
