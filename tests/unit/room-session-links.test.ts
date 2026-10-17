import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RoomSessionLinkFile,
  RoomSessionLinkStore,
  resolveDefaultRoomSessionLinkFile,
  type RoomSessionLinkSnapshot,
} from "../../src/room-session-links.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(name: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `dsh-collab-${name}-`));
  directories.push(directory);
  return directory;
}

describe("RoomSessionLinkStore", () => {
  it("binds one native Session to the matching room workspace", async () => {
    const workspacePath = await workspace("workspace");
    const store = new RoomSessionLinkStore();

    const link = store.bind({
      roomId: " room-1 ",
      memberId: " member-1 ",
      sessionId: " session-1 ",
      workspacePath: workspacePath + "/.",
      sessionCwd: workspacePath,
    });

    expect(link).toEqual({
      roomId: "room-1",
      memberId: "member-1",
      sessionId: "session-1",
      workspacePath,
      lastInjectedRoomSeq: 0,
      active: true,
    });
    expect(store.getBySession("session-1")).toEqual(link);
  });

  it("rejects a cwd outside the target workspace and cross-room rebinding", async () => {
    const firstWorkspace = await workspace("first");
    const secondWorkspace = await workspace("second");
    const store = new RoomSessionLinkStore();

    expect(() => store.bind({
      roomId: "room-1",
      memberId: "member-1",
      sessionId: "session-1",
      workspacePath: firstWorkspace,
      sessionCwd: secondWorkspace,
    })).toThrow("cwd");

    store.bind({ roomId: "room-1", memberId: "member-1", sessionId: "session-1", workspacePath: firstWorkspace, sessionCwd: firstWorkspace });
    expect(() => store.bind({
      roomId: "room-2",
      memberId: "member-1",
      sessionId: "session-1",
      workspacePath: secondWorkspace,
      sessionCwd: secondWorkspace,
    })).toThrow("another room or member");
    expect(() => store.bind({
      roomId: "room-1",
      memberId: "member-2",
      sessionId: "session-1",
      workspacePath: firstWorkspace,
      sessionCwd: firstWorkspace,
    })).toThrow("another room or member");
  });

  it("deactivates a Session without losing its delivery cursor", async () => {
    const workspacePath = await workspace("deactivate");
    const store = new RoomSessionLinkStore();
    const link = store.bind({ roomId: "room-1", memberId: "member-1", sessionId: "session-1", workspacePath, sessionCwd: workspacePath });
    store.advanceCursor("session-1", 7);

    expect(store.deactivate("session-1")).toMatchObject({ active: false, lastInjectedRoomSeq: 7 });
    expect(store.getBySession("session-1")).toMatchObject({ active: false, lastInjectedRoomSeq: 7, roomId: link.roomId });
    expect(store.bind({ roomId: "room-1", memberId: "member-1", sessionId: "session-1", workspacePath, sessionCwd: workspacePath })).toMatchObject({ active: true, lastInjectedRoomSeq: 7 });
  });

  it("replaces a stale member identity only for the same room Session and workspace", async () => {
    const workspacePath = await workspace("rejoin");
    const otherWorkspace = await workspace("other");
    const store = new RoomSessionLinkStore();
    store.bind({ roomId: "room-1", memberId: "member-old", sessionId: "session-1", workspacePath, sessionCwd: workspacePath });
    store.advanceCursor("session-1", 12);

    const rebound = store.rebindMember({
      roomId: "room-1",
      memberId: "member-current",
      sessionId: "session-1",
      workspacePath,
      sessionCwd: workspacePath,
    });

    expect(rebound).toEqual({
      roomId: "room-1",
      memberId: "member-current",
      sessionId: "session-1",
      workspacePath,
      lastInjectedRoomSeq: 0,
      active: true,
    });
    expect(store.getActive("room-1", "member-old")).toBeUndefined();
    expect(() => store.rebindMember({
      roomId: "room-2",
      memberId: "member-next",
      sessionId: "session-1",
      workspacePath,
      sessionCwd: workspacePath,
    })).toThrow("another room");
    expect(() => store.rebindMember({
      roomId: "room-1",
      memberId: "member-next",
      sessionId: "session-1",
      workspacePath: otherWorkspace,
      sessionCwd: otherWorkspace,
    })).toThrow("another workspace");
  });

  it("keeps only the newest explicitly bound Session active per room member", async () => {
    const workspacePath = await workspace("workspace");
    const store = new RoomSessionLinkStore();
    store.bind({ roomId: "room-1", memberId: "member-1", sessionId: "session-1", workspacePath, sessionCwd: workspacePath });

    const newest = store.bind({ roomId: "room-1", memberId: "member-1", sessionId: "session-2", workspacePath, sessionCwd: workspacePath });

    expect(store.getBySession("session-1")?.active).toBe(false);
    expect(store.getActive("room-1", "member-1")).toEqual(newest);
    expect(store.list()).toHaveLength(2);
  });

  it("advances the injection cursor monotonically and treats the same seq as idempotent", async () => {
    const workspacePath = await workspace("workspace");
    const store = new RoomSessionLinkStore();
    store.bind({ roomId: "room-1", memberId: "member-1", sessionId: "session-1", workspacePath, sessionCwd: workspacePath });

    expect(store.advanceCursor("session-1", 8).lastInjectedRoomSeq).toBe(8);
    expect(store.advanceCursor("session-1", 8).lastInjectedRoomSeq).toBe(8);
    expect(() => store.advanceCursor("session-1", 7)).toThrow("cannot move backwards");
    expect(() => store.advanceCursor("session-1", -1)).toThrow("non-negative");
  });

  it("unbinds the Session without deleting its workspace", async () => {
    const workspacePath = await workspace("workspace");
    const marker = join(workspacePath, "local-change.txt");
    await writeFile(marker, "keep", "utf8");
    const store = new RoomSessionLinkStore();
    store.bind({ roomId: "room-1", memberId: "member-1", sessionId: "session-1", workspacePath, sessionCwd: workspacePath });

    expect(store.unbind("session-1")).toBe(true);
    expect(store.unbind("session-1")).toBe(false);
    expect(store.getBySession("session-1")).toBeUndefined();
    await expect(readFile(marker, "utf8")).resolves.toBe("keep");
  });

  it("restores durable links without representing an online connection", async () => {
    const workspacePath = await workspace("workspace");
    const original = new RoomSessionLinkStore();
    original.bind({ roomId: "room-1", memberId: "member-1", sessionId: "session-1", workspacePath, sessionCwd: workspacePath });
    original.advanceCursor("session-1", 12);

    const snapshot = original.snapshot();
    const restored = RoomSessionLinkStore.fromSnapshot(snapshot);

    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.getActive("room-1", "member-1")?.lastInjectedRoomSeq).toBe(12);
    expect(JSON.stringify(restored.snapshot())).not.toMatch(/connected|online|gateway|credential/i);
  });

  it("fails closed on malformed, duplicate, or multiply-active snapshots", async () => {
    const workspacePath = await workspace("workspace");
    const link = { roomId: "room-1", memberId: "member-1", sessionId: "session-1", workspacePath, lastInjectedRoomSeq: 0, active: true };

    expect(() => RoomSessionLinkStore.fromSnapshot({ version: 2, links: [] } as unknown as RoomSessionLinkSnapshot)).toThrow("snapshot");
    expect(() => RoomSessionLinkStore.fromSnapshot({ version: 1, links: [link, link] })).toThrow("snapshot");
    expect(() => RoomSessionLinkStore.fromSnapshot({ version: 1, links: [
      link,
      { ...link, sessionId: "session-2" },
    ] })).toThrow("snapshot");
    expect(() => RoomSessionLinkStore.fromSnapshot({ version: 1, links: [{ ...link, lastInjectedRoomSeq: -1 }] })).toThrow("snapshot");
  });
});

describe("RoomSessionLinkFile", () => {
  it("uses local DSH storage and atomically round-trips validated snapshots", async () => {
    expect(resolveDefaultRoomSessionLinkFile({ DSH_HOME: "C:\\dsh-test" })).toBe(join("C:\\dsh-test", "collab", "v2", "session-links.json"));
    const root = await workspace("state");
    const workspacePath = await workspace("workspace");
    const path = join(root, "nested", "session-links.json");
    const file = new RoomSessionLinkFile(path);
    const store = new RoomSessionLinkStore();
    store.bind({ roomId: "room-1", memberId: "member-1", sessionId: "session-1", workspacePath, sessionCwd: workspacePath });

    await file.save(store.snapshot());

    await expect(file.load()).resolves.toEqual(store.snapshot());
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(store.snapshot());
  });

  it("treats absence as empty state and rejects malformed persisted data", async () => {
    const root = await workspace("state");
    const path = join(root, "session-links.json");
    const file = new RoomSessionLinkFile(path);

    await expect(file.load()).resolves.toBeUndefined();
    await writeFile(path, JSON.stringify({ version: 1, links: [{ active: true }] }), "utf8");
    await expect(file.load()).rejects.toThrow("state is malformed");
  });
});
