import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerRoomProjectService } from "../../src/owner-room-project.js";
import { RoomProjectStore } from "../../src/room-projects.js";
import { RoomStore } from "../../src/room.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(input: {
  workspacePath?: (sessionId: string) => string | Promise<string | undefined> | undefined;
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-owner-project-"));
  roots.push(root);
  const sourcePath = join(root, "source");
  const workspacePath = join(root, "room-workspace");
  await mkdir(sourcePath);
  await mkdir(workspacePath);

  const calls: string[] = [];
  const rooms = new RoomStore();
  const roomProjects = new RoomProjectStore();
  const sessionPaths = new Map([["source-session", sourcePath]]);
  let workspaceCaptureError: Error | undefined;
  const snapshot = {
    snapshotId: "snapshot-initial",
    roomId: "room-fixed",
    hostSessionId: "source-session",
    roomEventSeq: 1,
    manifestHash: "a".repeat(64),
    files: [],
    createdAt: 10,
  };
  const initialVersion = {
    version: {
      workspaceVersionId: snapshot.snapshotId,
      roomId: snapshot.roomId,
      files: [],
      createdBy: "member-host",
      createdAt: snapshot.createdAt,
    },
    manifestHash: "b".repeat(64),
    artifact: {
      kind: "workspace-snapshot.v1" as const,
      snapshotId: snapshot.snapshotId,
      manifestHash: snapshot.manifestHash,
      totalBytes: 0,
    },
  };
  const bootstrap = {
    prepare: vi.fn(async (input: { roomId: string; memberId: string; roomTitle: string; sourcePath: string }) => {
      calls.push("bootstrap");
      let project = roomProjects.register({
        roomId: input.roomId,
        memberId: input.memberId,
        roomTitle: input.roomTitle,
        workspacePath,
        sourcePath: input.sourcePath,
      });
      project = roomProjects.setNativeWorkspaceId({ roomId: input.roomId, nativeWorkspaceId: "native-room" });
      return { project, workspace: { roomId: input.roomId, workspacePath, snapshotId: snapshot.snapshotId } };
    }),
    complete: vi.fn(async (input: { roomId: string; sessionId: string }) => {
      calls.push("record-session");
      return roomProjects.setHostPrimarySessionId(input);
    }),
  };
  const service = new OwnerRoomProjectService({
    hostId: "host-principal",
    hostDisplayName: "Host",
    sessions: { workspacePath: input.workspacePath ?? ((sessionId: string) => sessionPaths.get(sessionId)) },
    rooms,
    roomProjects,
    ledger: { latestSeq: () => { calls.push("ledger"); return 1; }, discardRoom: () => { calls.push("discard"); } },
    workspace: {
      setSharing: () => { calls.push("sharing"); return {} as never; },
      clearRoom: () => { calls.push("clear-sharing"); },
      captureLatest: async () => { calls.push("snapshot"); if (workspaceCaptureError) throw workspaceCaptureError; return snapshot; },
    },
    workspaceVersions: {
      create: async () => { calls.push("version"); return { record: initialVersion } as never; },
    },
    bootstrap,
    commitCriticalState: async () => { calls.push("commit"); },
    createRoomId: () => "room-fixed",
  });

  return { bootstrap, calls, roomProjects, rooms, service, sessionPaths, sourcePath, workspacePath, get workspaceCaptureError() { return workspaceCaptureError; }, set workspaceCaptureError(value: Error | undefined) { workspaceCaptureError = value; } };
}

describe("OwnerRoomProjectService", () => {
  it("creates the Room, initial immutable version, and registered native Workspace in order", async () => {
    const value = await fixture();
    const createRoom = vi.spyOn(value.rooms, "createRoom").mockImplementation((input) => {
      value.calls.push("room");
      return RoomStore.prototype.createRoom.call(value.rooms, input);
    });

    await expect(value.service.prepare({
      sourcePath: value.sourcePath,
      sourceSessionId: "source-session",
      roomTitle: "Atlas",
    })).resolves.toEqual({
      roomId: "room-fixed",
      workspacePath: value.workspacePath,
      nativeWorkspaceId: "native-room",
    });

    expect(createRoom).toHaveBeenCalledWith(expect.objectContaining({
      roomId: "room-fixed",
      hostId: "host-principal",
      hostSessionId: "source-session",
      title: "Atlas",
      hostDisplayName: "Host",
    }));
    expect(value.bootstrap.prepare).toHaveBeenCalledWith(expect.objectContaining({
      roomTitle: "Atlas",
      nativeWorkspaceTitle: "source \u00b7 Atlas",
    }));
    expect(value.roomProjects.get("room-fixed")).toMatchObject({ workspacePath: value.workspacePath, sourcePath: value.sourcePath });
    expect(value.calls).toEqual(["room", "sharing", "ledger", "snapshot", "version", "bootstrap", "commit"]);
  });

  it("rejects a selected directory that is not the source Session cwd before creating state", async () => {
    const value = await fixture();
    const otherPath = join(value.sourcePath, "other");
    await mkdir(otherPath);
    const createRoom = vi.spyOn(value.rooms, "createRoom");

    await expect(value.service.prepare({
      sourcePath: otherPath,
      sourceSessionId: "source-session",
      roomTitle: "Atlas",
    })).rejects.toThrow(/session|workspace|directory|path/i);

    expect(createRoom).not.toHaveBeenCalled();
    expect(value.bootstrap.prepare).not.toHaveBeenCalled();
    expect(value.calls).toEqual([]);
  });

  it("rolls back the provisional Room when the initial Snapshot capture fails", async () => {
    const value = await fixture();
    value.workspaceCaptureError = new Error("Workspace Snapshot exceeds the file count limit");

    await expect(value.service.prepare({
      sourcePath: value.sourcePath,
      sourceSessionId: "source-session",
      roomTitle: "Atlas",
    })).rejects.toThrow("Workspace Snapshot exceeds the file count limit");

    expect(value.rooms.snapshot().rooms).toHaveLength(0);
    expect(value.roomProjects.list()).toHaveLength(0);
  });
  it("accepts a source Session workspace path resolved from the cold Session query", async () => {
    const value = await fixture({ workspacePath: async (sessionId) => value.sessionPaths.get(sessionId) });

    await expect(value.service.prepare({
      sourcePath: value.sourcePath,
      sourceSessionId: "source-session",
      roomTitle: "Atlas",
    })).resolves.toMatchObject({ roomId: "room-fixed" });
  });

  it("completes the browser-created Session by rebinding both Room and Room Project", async () => {
    const value = await fixture();
    await value.service.prepare({ sourcePath: value.sourcePath, sourceSessionId: "source-session", roomTitle: "Atlas" });
    value.calls.length = 0;
    value.sessionPaths.set("host-primary-session", value.workspacePath);

    await expect(value.service.complete({
      roomId: "room-fixed",
      sourceSessionId: "source-session",
      hostPrimarySessionId: "host-primary-session",
    })).resolves.toEqual({ roomId: "room-fixed", hostPrimarySessionId: "host-primary-session" });

    expect(value.rooms.getRoom("room-fixed").hostSessionId).toBe("host-primary-session");
    expect(value.roomProjects.get("room-fixed")?.hostPrimarySessionId).toBe("host-primary-session");
    expect(value.calls).toEqual(["record-session", "commit"]);
  });

  it("leaves prepare state retryable when the browser has not created a Session yet", async () => {
    const value = await fixture();
    const prepared = await value.service.prepare({ sourcePath: value.sourcePath, sourceSessionId: "source-session", roomTitle: "Atlas" });

    expect(prepared.nativeWorkspaceId).toBe("native-room");
    expect(value.rooms.getRoom("room-fixed").hostSessionId).toBe("source-session");
    expect(value.roomProjects.get("room-fixed")?.hostPrimarySessionId).toBeUndefined();

    value.sessionPaths.set("host-primary-session", value.workspacePath);
    await expect(value.service.complete({
      roomId: "room-fixed",
      sourceSessionId: "source-session",
      hostPrimarySessionId: "host-primary-session",
    })).resolves.toMatchObject({ hostPrimarySessionId: "host-primary-session" });
  });

  it("rejects a stale source Session before persisting the Host Primary Session", async () => {
    const value = await fixture();
    await value.service.prepare({ sourcePath: value.sourcePath, sourceSessionId: "source-session", roomTitle: "Atlas" });
    value.calls.length = 0;
    value.sessionPaths.set("host-primary-session", value.workspacePath);
    value.rooms.rebindHostSession({
      roomId: "room-fixed",
      hostId: "host-principal",
      fromSessionId: "source-session",
      toSessionId: "other-session",
    });

    await expect(value.service.complete({
      roomId: "room-fixed",
      sourceSessionId: "source-session",
      hostPrimarySessionId: "host-primary-session",
    })).rejects.toThrow(/session|conflict/i);

    expect(value.bootstrap.complete).not.toHaveBeenCalled();
    expect(value.roomProjects.get("room-fixed")?.hostPrimarySessionId).toBeUndefined();
  });
});
