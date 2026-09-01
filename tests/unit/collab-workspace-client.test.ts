import { describe, expect, it, vi } from "vitest";
import { DshCollabWorkspacePorts } from "../../src/collab-workspace-client.js";
import type { DshCollabClientSnapshot } from "../../src/dsh-client.js";

const room: DshCollabClientSnapshot = {
  roomId: "room-1",
  memberId: "member-alice",
  roomTitle: "Release",
  hostDisplayName: "Host",
  role: "participant" as const,
  connection: "online" as const,
  onlineCount: 2,
  canSteer: false,
  members: [{ memberId: "member-alice", displayName: "Alice" }],
  roomEvents: [],
};

describe("DshCollabWorkspacePorts", () => {
  it("projects production Changes and Reviews through the loopback RPC without persisting the room bearer", async () => {
    const changes = {
      roomId: "room-1", role: "participant" as const, connection: "online" as const,
      workspace: { kind: "ready" as const, path: "C:\\rooms\\room-1", baseVersionId: "v1", latestVersionId: "v1", dirtyPaths: [], linked: false },
      staged: [],
    };
    const reviews = {
      roomId: "room-1", role: "participant" as const, currentMemberId: "member-alice", connection: "online" as const,
      members: room.members, reviews: [],
    };
    const rpc = { call: vi.fn(async () => ({ ok: true, value: { changes, reviews } })) };
    const source = {
      getSnapshot: () => room,
      subscribe: () => () => {},
      getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://10.0.0.1:4310/collab", roomToken: "transient-room-token" }),
    };
    const ports = new DshCollabWorkspacePorts({ rpc, source });
    const scoped = ports.forSession("session-1");

    await ports.activateSession("session-1", "room-1");

    expect(scoped.changes.getSnapshot()).toEqual(changes);
    expect(scoped.reviews.getSnapshot()).toEqual(reviews);
    expect(rpc.call).toHaveBeenCalledWith("/dsh-collab", "workspace/refresh", expect.objectContaining({
      sessionId: "session-1",
      room: expect.objectContaining({ roomId: "room-1", memberId: "member-alice", role: "participant" }),
      remote: { gatewayEndpoint: "ws://10.0.0.1:4310/collab", roomToken: "transient-room-token" },
    }));
    expect(JSON.stringify(scoped.changes.getSnapshot())).not.toContain("transient-room-token");
    ports.dispose();
  });

  it("routes explicit UI actions to one session-scoped backend projection", async () => {
    const rpc = { call: vi.fn(async (_channel: string, endpoint: string) => ({ ok: true, value: {
      changes: { roomId: "room-1", role: "participant", connection: "online", workspace: { kind: "unavailable" }, staged: [] },
      reviews: { roomId: "room-1", role: "participant", currentMemberId: "member-alice", connection: "online", members: room.members, reviews: [] },
      endpoint,
    } })) };
    const ports = new DshCollabWorkspacePorts({
      rpc,
      source: { getSnapshot: () => room, subscribe: () => () => {}, getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://host/collab", roomToken: "token" }) },
    });
    const scoped = ports.forSession("session-1");
    await ports.activateSession("session-1", "room-1");
    rpc.call.mockClear();

    await scoped.changes.createDraft({ title: "Fix", summary: "Fix race" });
    await scoped.reviews.assignReviewer("a".repeat(64), "member-alice");

    expect(rpc.call.mock.calls.map((call) => call[1])).toEqual(["workspace/changes/create-draft", "workspace/reviews/assign"]);
    ports.dispose();
  });

  it("opens an unlinked Participant Room Workspace through the native DSH navigator", async () => {
    const openWorkspace = vi.fn(async () => {});
    const changes = {
      roomId: "room-1", role: "participant" as const, connection: "online" as const,
      workspace: { kind: "ready" as const, path: "C:\\rooms\\room-1", baseVersionId: "v1", latestVersionId: "v1", dirtyPaths: [], linked: false },
      staged: [],
    };
    const ports = new DshCollabWorkspacePorts({
      rpc: { call: vi.fn(async () => ({ ok: true, value: {
        changes,
        reviews: { roomId: "room-1", role: "participant", currentMemberId: "member-alice", connection: "online", members: room.members, reviews: [] },
      } })) },
      source: {
        getSnapshot: () => ({ ...room, gatewayEndpoint: "ws://10.0.0.1:4310/collab" }),
        subscribe: () => () => {},
        getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://10.0.0.1:4310/collab", roomToken: "token" }),
      },
      openWorkspace,
    });
    const scoped = ports.forSession("session-old");
    await ports.activateSession("session-old", "room-1");

    await scoped.changes.openWorkspace?.();

    expect(openWorkspace).toHaveBeenCalledWith({
      roomId: "room-1",
      path: "C:\\rooms\\room-1",
      gatewayEndpoint: "ws://10.0.0.1:4310/collab",
      roomTitle: "Release",
      hostDisplayName: "Host",
    });
    ports.dispose();
  });

  it("keeps a loaded workspace projection across same-room discussion updates", async () => {
    let snapshot = room;
    let sourceListener: (() => void) | undefined;
    const changes = {
      roomId: "room-1", role: "participant" as const, connection: "online" as const,
      workspace: { kind: "ready" as const, path: "C:\\rooms\\room-1", baseVersionId: "v1", latestVersionId: "v1", dirtyPaths: [], linked: false },
      staged: [],
    };
    const reviews = {
      roomId: "room-1", role: "participant" as const, currentMemberId: "member-alice", connection: "online" as const,
      members: room.members, reviews: [],
    };
    const ports = new DshCollabWorkspacePorts({
      rpc: { call: vi.fn(async () => ({ ok: true, value: { changes, reviews } })) },
      source: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { sourceListener = listener; return () => {}; },
        getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://host/collab", roomToken: "token" }),
      },
    });
    const scoped = ports.forSession("session-1");
    await ports.activateSession("session-1", "room-1");

    snapshot = { ...room, onlineCount: 3 };
    sourceListener?.();

    expect(scoped.changes.getSnapshot().workspace).toMatchObject({ kind: "ready", baseVersionId: "v1" });
    ports.dispose();
  });

  it("activates one Session projection and forwards later room events through lightweight context sync", async () => {
    let snapshot = room;
    let sourceListener: (() => void) | undefined;
    const rpc = { call: vi.fn(async (_channel: string, endpoint: string) => endpoint === "workspace/context-sync"
      ? { ok: true, value: { synced: true } }
      : { ok: true, value: {
          changes: { roomId: "room-1", role: "participant", connection: "online", workspace: { kind: "unavailable" }, staged: [] },
          reviews: { roomId: "room-1", role: "participant", currentMemberId: "member-alice", connection: "online", members: room.members, reviews: [] },
        } }) };
    const ports = new DshCollabWorkspacePorts({
      rpc,
      source: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { sourceListener = listener; return () => {}; },
        getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://host/collab", roomToken: "token" }),
      },
    });

    await (ports as unknown as { activateSession(sessionId: string, roomId: string): Promise<void> }).activateSession("session-1", "room-1");
    expect(rpc.call.mock.calls.map((call) => call[1])).toEqual(["workspace/refresh"]);

    snapshot = { ...room, roomEvents: [{
      eventId: "event-1", roomId: "room-1", seq: 1, type: "human.message", createdAt: 1,
      actor: { memberId: "member-alice", principalId: "principal-alice" },
      payload: { kind: "human", visibility: "room", messageId: "message-1", roomId: "room-1", authorMemberId: "member-alice", text: "hello" },
    }] };
    sourceListener?.();
    await vi.waitFor(() => { expect(rpc.call.mock.calls.map((call) => call[1])).toEqual(["workspace/refresh", "workspace/context-sync"]); });
    ports.dispose();
  });

  it("exposes explicit Owner Workspace Sharing instead of publishing through an unreachable disabled route", async () => {
    let snapshot: DshCollabClientSnapshot = { ...room, role: "host", workspaceSharing: { roomId: "room-1", enabled: false, revision: 0 } };
    const setWorkspaceSharing = vi.fn(async (roomId: string, enabled: boolean) => {
      snapshot = { ...snapshot, workspaceSharing: enabled
        ? { roomId, enabled: true, enabledBy: "member-alice", enabledAt: 10, revision: 1 }
        : { roomId, enabled: false, revision: 1 } };
      return snapshot.workspaceSharing!;
    });
    const rpc = { call: vi.fn(async () => ({ ok: true, value: {
      changes: { roomId: "room-1", role: "owner", connection: "online", workspace: { kind: "owner" }, staged: [] },
      reviews: { roomId: "room-1", role: "owner", currentMemberId: "member-alice", connection: "online", members: room.members, reviews: [] },
    } })) };
    const ports = new DshCollabWorkspacePorts({
      rpc,
      source: {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        getWorkspaceSharing: async () => snapshot.workspaceSharing!,
        setWorkspaceSharing,
        getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://host/collab", roomToken: "token" }),
      },
    });
    const scoped = ports.forSession("session-owner");
    await ports.activateSession("session-owner", "room-1");

    await scoped.changes.setWorkspaceSharing?.(true);

    expect(setWorkspaceSharing).toHaveBeenCalledWith("room-1", true);
    expect(scoped.changes.getSnapshot()).toMatchObject({ workspaceSharingEnabled: true });
    ports.dispose();
  });

  it("does not call the protected workspace route while Workspace Sharing is disabled", async () => {
    const snapshot: DshCollabClientSnapshot = {
      ...room,
      role: "host",
      workspaceSharing: { roomId: "room-1", enabled: false, revision: 0 },
    };
    const rpc = { call: vi.fn(async () => { throw new Error("Workspace Sharing is disabled"); }) };
    const ports = new DshCollabWorkspacePorts({
      rpc,
      source: {
        getSnapshot: () => snapshot,
        subscribe: () => () => {},
        getWorkspaceSharing: async () => snapshot.workspaceSharing!,
        setWorkspaceSharing: async () => snapshot.workspaceSharing!,
        getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://host/collab", roomToken: "token" }),
      },
    });
    const scoped = ports.forSession("session-owner");

    await ports.activateSession("session-owner", "room-1");
    await scoped.changes.refresh();

    expect(rpc.call).not.toHaveBeenCalled();
    expect(scoped.changes.getSnapshot()).toMatchObject({ workspaceSharingEnabled: false });
    expect(scoped.changes.getSnapshot()).not.toHaveProperty("error");
    ports.dispose();
  });

  it("refreshes the active Session projection for durable collaboration events and coalesces bursts", async () => {
    let snapshot = room;
    let sourceListener: (() => void) | undefined;
    let releasePendingRefresh: (() => void) | undefined;
    const projection = {
      changes: { roomId: "room-1", role: "participant" as const, connection: "online" as const, workspace: { kind: "unavailable" as const }, staged: [] },
      reviews: { roomId: "room-1", role: "participant" as const, currentMemberId: "member-alice", connection: "online" as const, members: room.members, reviews: [] },
    };
    const rpc = { call: vi.fn(async (_channel: string, _endpoint: string, _payload: unknown) => {
      if (rpc.call.mock.calls.length === 2) {
        await new Promise<void>((resolve) => { releasePendingRefresh = resolve; });
      }
      return { ok: true, value: projection };
    }) };
    const ports = new DshCollabWorkspacePorts({
      rpc,
      source: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { sourceListener = listener; return () => { sourceListener = undefined; }; },
        getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://host/collab", roomToken: "token" }),
      },
    });
    await ports.activateSession("session-1", "room-1");

    const collaborationEvent = (seq: number) => ({
      eventId: `change-${String(seq)}`,
      roomId: "room-1",
      seq,
      type: "changeset.submitted" as const,
      actor: { memberId: "member-alice", principalId: "principal-alice" },
      createdAt: seq,
      payload: { changeSetId: `change-${String(seq)}`, authorId: "member-alice", title: `Change ${String(seq)}`, summary: "Summary", submittedAt: seq },
    });
    snapshot = { ...snapshot, roomEvents: [collaborationEvent(1)] };
    sourceListener?.();
    await vi.waitFor(() => { expect(rpc.call).toHaveBeenCalledTimes(2); });
    snapshot = { ...snapshot, roomEvents: [collaborationEvent(1), collaborationEvent(2)] };
    sourceListener?.();
    snapshot = { ...snapshot, roomEvents: [collaborationEvent(1), collaborationEvent(2), collaborationEvent(3)] };
    sourceListener?.();
    releasePendingRefresh?.();

    await vi.waitFor(() => { expect(rpc.call).toHaveBeenCalledTimes(3); });
    expect(rpc.call.mock.calls.map((call) => call[1])).toEqual(["workspace/refresh", "workspace/refresh", "workspace/refresh"]);
    ports.dispose();
    expect(sourceListener).toBeUndefined();
  });

  it("rejects a queued Session action after the global source switches rooms", async () => {
    let snapshot = room;
    let sourceListener: (() => void) | undefined;
    const rpc = { call: vi.fn(async (_channel: string, _endpoint: string, payload: unknown) => {
      const selectedRoom = (payload as { room: { roomId: string; memberId: string } }).room;
      return { ok: true, value: {
        changes: { roomId: selectedRoom.roomId, role: "participant", connection: "online", workspace: { kind: "unavailable" }, staged: [] },
        reviews: { roomId: selectedRoom.roomId, role: "participant", currentMemberId: selectedRoom.memberId, connection: "online", members: [{ memberId: selectedRoom.memberId, displayName: selectedRoom.memberId }], reviews: [] },
      } };
    }) };
    const ports = new DshCollabWorkspacePorts({
      rpc,
      source: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { sourceListener = listener; return () => {}; },
        getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://host/collab", roomToken: "token" }),
      },
    });
    const scoped = ports.forSession("session-1");
    await ports.activateSession("session-1", "room-1");

    const pending = scoped.changes.sync();
    snapshot = { ...room, roomId: "room-2", memberId: "member-bob", members: [{ memberId: "member-bob", displayName: "Bob" }] };
    sourceListener?.();

    await expect(pending).rejects.toThrow("selected collaboration room is not connected");
    expect(rpc.call).toHaveBeenCalledTimes(1);
    expect((rpc.call.mock.calls[0]?.[2] as { room: { roomId: string } }).room.roomId).toBe("room-1");
    ports.dispose();
  });

  it("does not let a stale room response overwrite the fallback installed by a room switch", async () => {
    let snapshot = room;
    let sourceListener: (() => void) | undefined;
    let markRequestStarted: (() => void) | undefined;
    let releaseResponse: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
    const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const rpc = { call: vi.fn(async () => {
      markRequestStarted?.();
      await responseReleased;
      return { ok: true, value: {
        changes: { roomId: "room-1", role: "participant", connection: "online", workspace: { kind: "unavailable" }, staged: [] },
        reviews: { roomId: "room-1", role: "participant", currentMemberId: "member-alice", connection: "online", members: room.members, reviews: [] },
      } };
    }) };
    const ports = new DshCollabWorkspacePorts({
      rpc,
      source: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { sourceListener = listener; return () => {}; },
        getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://host/collab", roomToken: "token" }),
      },
    });
    const scoped = ports.forSession("session-1");

    const activation = ports.activateSession("session-1", "room-1");
    await requestStarted;
    snapshot = { ...room, roomId: "room-2", memberId: "member-bob", members: [{ memberId: "member-bob", displayName: "Bob" }] };
    sourceListener?.();
    releaseResponse?.();

    await expect(activation).rejects.toThrow("selected collaboration room is not connected");
    expect(scoped.changes.getSnapshot()).toMatchObject({ roomId: "room-2", workspace: { kind: "unavailable" } });
    ports.dispose();
  });

  it("revalidates a room response again before installing its projection", async () => {
    let snapshot = room;
    let sourceListener: (() => void) | undefined;
    let switchAfterValidation = false;
    const source = {
      getSnapshot: () => {
        if (switchAfterValidation) {
          switchAfterValidation = false;
          queueMicrotask(() => {
            snapshot = { ...room, roomId: "room-2", memberId: "member-bob", members: [{ memberId: "member-bob", displayName: "Bob" }] };
            sourceListener?.();
          });
        }
        return snapshot;
      },
      subscribe: (listener: () => void) => { sourceListener = listener; return () => {}; },
      getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://host/collab", roomToken: "token" }),
    };
    const rpc = { call: vi.fn(async () => {
      switchAfterValidation = true;
      return { ok: true, value: {
        changes: { roomId: "room-1", role: "participant", connection: "online", workspace: { kind: "unavailable" }, staged: [] },
        reviews: { roomId: "room-1", role: "participant", currentMemberId: "member-alice", connection: "online", members: room.members, reviews: [] },
      } };
    }) };
    const ports = new DshCollabWorkspacePorts({ rpc, source });
    const scoped = ports.forSession("session-1");

    await expect(ports.activateSession("session-1", "room-1")).rejects.toThrow("selected collaboration room is not connected");
    expect(scoped.changes.getSnapshot()).toMatchObject({ roomId: "room-2", workspace: { kind: "unavailable" } });
    ports.dispose();
  });

  it("does not install stale Workspace Sharing state after the selected room changes", async () => {
    let snapshot: DshCollabClientSnapshot = { ...room, role: "host", workspaceSharing: { roomId: "room-1", enabled: false, revision: 0 } };
    let sourceListener: (() => void) | undefined;
    let releaseSharing: (() => void) | undefined;
    const sharingReleased = new Promise<void>((resolve) => { releaseSharing = resolve; });
    const ports = new DshCollabWorkspacePorts({
      rpc: { call: vi.fn(async () => { throw new Error("stale activation must not reach RPC"); }) },
      source: {
        getSnapshot: () => snapshot,
        subscribe: (listener) => { sourceListener = listener; return () => {}; },
        getWorkspaceSharing: async () => { await sharingReleased; return { enabled: true }; },
        getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://host/collab", roomToken: "token" }),
      },
    });
    const scoped = ports.forSession("session-owner");

    const activation = ports.activateSession("session-owner", "room-1");
    snapshot = { ...room, roomId: "room-2", memberId: "member-bob", members: [{ memberId: "member-bob", displayName: "Bob" }] };
    sourceListener?.();
    releaseSharing?.();

    await expect(activation).rejects.toThrow("selected collaboration room is not connected");
    expect(scoped.changes.getSnapshot()).not.toHaveProperty("workspaceSharingEnabled");
    ports.dispose();
  });

  it("invalidates previously returned Session ports when the aggregate is disposed", async () => {
    let markRequestStarted: (() => void) | undefined;
    let releaseResponse: (() => void) | undefined;
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve; });
    const responseReleased = new Promise<void>((resolve) => { releaseResponse = resolve; });
    const removeSourceListener = vi.fn();
    const rpc = { call: vi.fn(async () => {
      markRequestStarted?.();
      await responseReleased;
      return { ok: true, value: {
        changes: { roomId: "room-1", role: "participant", connection: "online", workspace: { kind: "unavailable" }, staged: [] },
        reviews: { roomId: "room-1", role: "participant", currentMemberId: "member-alice", connection: "online", members: room.members, reviews: [] },
      } };
    }) };
    const ports = new DshCollabWorkspacePorts({
      rpc,
      source: {
        getSnapshot: () => room,
        subscribe: () => removeSourceListener,
        getLocalSnapshotAccess: () => ({ gatewayEndpoint: "ws://host/collab", roomToken: "token" }),
      },
    });
    const scoped = ports.forSession("session-1");
    const listener = vi.fn();
    scoped.changes.subscribe(listener);
    const activation = ports.activateSession("session-1", "room-1");
    await requestStarted;

    ports.dispose();
    releaseResponse?.();

    await expect(activation).rejects.toThrow("disposed");
    await expect(scoped.changes.refresh()).rejects.toThrow("disposed");
    expect(() => scoped.changes.subscribe(() => {})).toThrow("disposed");
    expect(() => ports.forSession("session-2")).toThrow("disposed");
    expect(listener).not.toHaveBeenCalled();
    expect(removeSourceListener).toHaveBeenCalledOnce();
  });
});
