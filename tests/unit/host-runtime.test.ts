import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createDshCollabHostRuntime } from "../../src/host-runtime.js";
import { COLLAB_CAPABILITY_HEADER, SIDECAR_REVIEW_CAPABILITY, WORKSPACE_VERSION_CAPABILITY } from "../../src/protocol.js";
import type { WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { TaskStore } from "../../src/tasks.js";

describe("host runtime factory", () => {
  it("allows saved rooms but rejects a second active room in one DSH runtime", async () => {
    const runtime = createDshCollabHostRuntime({
      roomId: "room-1",
      hostId: "host",
      hostSessionId: "session-1",
      title: "Room 1",
      hostDisplayName: "Host",
      sessions: { owns: () => true, followup() {}, steer() {}, cancel() {} },
    });
    runtime.rooms.createRoom({
      roomId: "room-2",
      hostId: "host",
      hostSessionId: "session-2",
      title: "Room 2",
      hostDisplayName: "Host",
    });

    const response = await runtime.gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-2/host",
      auth: { principalId: "host" },
      body: { hostSessionId: "session-2", title: "Room 2" },
    });

    expect(response).toMatchObject({
      status: 409,
      body: { error: { code: "REQUEST_CONFLICT", message: "another collaboration room is already active; stop it before activating another room" } },
    });
    expect(runtime.activeRooms.getActiveRoomId()).toBe("room-1");
    expect(runtime.rooms.getRoom("room-2").title).toBe("Room 2");
    await runtime.dispose();
  });

  it("persists runtime Task events into the Room ledger and restores them", async () => {
    const options = {
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host",
      sessions: { owns: () => true, followup() {}, steer() {}, cancel() {} },
    };
    const first = createDshCollabHostRuntime(options);
    first.taskStore.create({ taskId: "task-1", roomId: "room-1", title: "Task", actor: { memberId: "member-host", principalId: "host" }, eventId: "task-created", now: 1 });
    expect(first.ledger.readAfter("room-1", 0).map((event) => event.type)).toContain("task.created");
    const snapshot = first.snapshot();
    await first.dispose();

    const restored = createDshCollabHostRuntime({ ...options, snapshot });
    expect(restored.taskStore.get("task-1").title).toBe("Task");
    await restored.dispose();
  });

  it("does not mirror Task milestones into the TaskStore on Host restore", async () => {
    const options = {
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host",
      sessions: { owns: () => true, followup() {}, steer() {}, cancel() {} },
    };
    const first = createDshCollabHostRuntime(options);
    first.ledger.append({
      eventId: "milestone-1",
      roomId: "room-1",
      type: "task.milestone",
      actor: { memberId: "member-host", principalId: "host" },
      createdAt: 1,
      payload: { roomId: "room-1", taskId: "task-1", memberId: "member-host", sourceSessionId: "session-1", milestone: "completed", summary: "done" },
    });
    const snapshot = first.snapshot();
    await first.dispose();

    const restored = createDshCollabHostRuntime({ ...options, snapshot });
    expect(restored.ledger.readAfter("room-1", 0).filter((event) => event.type === "task.milestone")).toHaveLength(1);
    expect(restored.taskStore.events("room-1")).toHaveLength(0);
    await restored.dispose();
  });

  it("notifies the production Room Context delivery hook only after ledger commit", async () => {
    const committed: Array<{ eventId: string; seq: number; committedSeq: number }> = [];
    const runtime = createDshCollabHostRuntime({
      roomId: "room-1",
      hostId: "host",
      hostSessionId: "session-1",
      title: "Room",
      hostDisplayName: "Host",
      sessions: { owns: () => true, followup() {}, steer() {}, cancel() {} },
      roomContextDelivery: {
        onCommitted: (event, ledger) => {
          committed.push({ eventId: event.eventId, seq: event.seq, committedSeq: ledger.latestCommittedSeq(event.roomId) });
        },
      },
    });

    runtime.ledger.append({
      eventId: "event-work-update",
      roomId: "room-1",
      type: "work-update.published",
      actor: { memberId: "member-host", principalId: "host" },
      createdAt: 1,
      payload: { roomId: "room-1", updateId: "update-1", authorId: "member-host", summary: "ready", refs: [], createdAt: 1 },
    });
    expect(committed).toEqual([]);
    await runtime.ledger.commit();
    expect(committed).toEqual([{ eventId: "event-work-update", seq: 1, committedSeq: 1 }]);
    await runtime.dispose();
  });

  it("wires WorkspaceVersion publication and restores its Ledger index", async () => {
    const content = Buffer.from("app");
    const files = [{ path: "src/app.ts", contentHash: createHash("sha256").update(content).digest("hex"), size: content.byteLength, source: "tracked" as const }];
    const stored = new Map<string, WorkspaceSnapshotPackage>();
    const workspaceSnapshots = {
      async capture(input: { roomId: string; hostSessionId: string; roomEventSeq: number; snapshotId: string }) {
        const snapshot: WorkspaceSnapshotPackage = {
          snapshotId: input.snapshotId,
          roomId: input.roomId,
          hostSessionId: input.hostSessionId,
          roomEventSeq: input.roomEventSeq,
          headOid: "a".repeat(40),
          manifestHash: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
          files,
          createdAt: 10,
        };
        stored.set(snapshot.snapshotId, snapshot);
        return snapshot;
      },
      load: async (snapshotId: string) => stored.get(snapshotId),
      readFile: async () => content,
      readChunk: async (_snapshotId: string, _path: string, offset: number, length: number) => content.subarray(offset, offset + length),
    };
    const options = {
      roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Room", hostDisplayName: "Host",
      sessions: { owns: () => true, followup() {}, steer() {}, cancel() {} }, workspaceSnapshots, now: () => 10,
    };
    const first = createDshCollabHostRuntime(options);
    const bootstrap = await first.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const headers = {
      authorization: `Bearer ${(bootstrap.body as { roomToken: string }).roomToken}`,
      [COLLAB_CAPABILITY_HEADER]: `${SIDECAR_REVIEW_CAPABILITY},${WORKSPACE_VERSION_CAPABILITY}`,
    };
    await first.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/workspace-sharing", headers, body: { enabled: true } });
    await expect(first.gateway.handle({
      method: "POST", path: "/v1/rooms/room-1/workspace-versions", headers, body: { clientRequestId: "publish-1" },
    })).resolves.toMatchObject({ status: 201 });
    expect(first.workspaceVersions?.latest("room-1")).toBeDefined();
    const snapshot = first.snapshot();
    await first.dispose();

    const restored = createDshCollabHostRuntime({ ...options, snapshot });
    restored.activeRooms.activate("room-1");
    const restoredBootstrap = await restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const restoredHeaders = { ...headers, authorization: `Bearer ${(restoredBootstrap.body as { roomToken: string }).roomToken}` };
    await expect(restored.gateway.handle({
      method: "GET", path: "/v1/rooms/room-1/workspace-sharing", headers: restoredHeaders,
    })).resolves.toMatchObject({ status: 200, body: { state: { enabled: true, revision: 1 } } });
    await expect(restored.gateway.handle({
      method: "GET", path: "/v1/rooms/room-1/workspace-versions/latest", headers: restoredHeaders,
    })).resolves.toMatchObject({ status: 200, body: { record: { version: { roomId: "room-1" } } } });
    await restored.dispose();
  });

  it("persists Review Points and their file anchors while Workspace Sharing restores", async () => {
    const files = [{ path: "src/app.ts", contentHash: createHash("sha256").update("app").digest("hex"), size: 3, source: "tracked" as const }];
    const stored = new Map<string, WorkspaceSnapshotPackage>();
    const workspaceSnapshots = {
      capture: vi.fn(async (input: { roomId: string; hostSessionId: string; roomEventSeq: number; snapshotId: string }) => {
        const value = { snapshotId: input.snapshotId, roomId: input.roomId, hostSessionId: input.hostSessionId, roomEventSeq: input.roomEventSeq, headOid: "a".repeat(40), manifestHash: createHash("sha256").update(JSON.stringify(files)).digest("hex"), files, createdAt: 10 };
        stored.set(value.snapshotId, value);
        return value;
      }),
      load: async (snapshotId: string) => stored.get(snapshotId),
      readChunk: async () => new Uint8Array(),
      captureReviewDiffs: async () => [{ path: "src/app.ts", kind: "text" as const, oldText: "old app", newText: "app" }],
    };
    const options = {
      roomId: "room-1", hostId: "host", hostSessionId: "room-1", title: "Room", hostDisplayName: "Host",
      sessions: { owns: () => true, followup() {}, steer() {}, cancel() {} }, workspaceSnapshots, now: () => 10,
    };
    const first = createDshCollabHostRuntime(options);
    const bootstrap = await first.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const headers = { authorization: `Bearer ${(bootstrap.body as { roomToken: string }).roomToken}`, [COLLAB_CAPABILITY_HEADER]: SIDECAR_REVIEW_CAPABILITY };
    await first.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/workspace-sharing", headers, body: { enabled: true } });
    await expect(first.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/review-points", headers, body: {
      clientRequestId: "review-1", title: "App review", files: [{ path: "src/app.ts", status: "modified", additions: 1, deletions: 0 }],
    } })).resolves.toMatchObject({ status: 201 });
    const snapshot = first.snapshot();
    expect(snapshot.reviewPoints?.reviewPoints).toHaveLength(1);
    await first.dispose();

    const restored = createDshCollabHostRuntime({ ...options, hostSessionId: "room-2", snapshot });
    restored.activeRooms.activate("room-1");
    const shared = await restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const restoredHeaders = { authorization: `Bearer ${(shared.body as { roomToken: string }).roomToken}`, [COLLAB_CAPABILITY_HEADER]: SIDECAR_REVIEW_CAPABILITY };
    const reviewPointId = snapshot.reviewPoints!.reviewPoints[0]!.reviewPointId;
    await expect(restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/review-points", headers: restoredHeaders })).resolves.toMatchObject({
      status: 200,
      body: { reviewPoints: [{ reviewPoint: { title: "App review", mainAgentSessionId: "room-1", files: [{ path: "src/app.ts" }] }, freshness: "current" }] },
    });
    await expect(restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/workspace-sharing", headers: restoredHeaders })).resolves.toMatchObject({ body: { state: { enabled: true } } });
    await expect(restored.gateway.handle({ method: "GET", path: `/v1/rooms/room-1/review-points/${reviewPointId}/diffs/0`, headers: restoredHeaders }))
      .resolves.toMatchObject({ status: 200, body: { diff: { path: "src/app.ts", oldText: "old app", newText: "app" } } });
    const historicalSnapshotId = snapshot.reviewPoints!.reviewPoints[0]!.workspaceSnapshotId;
    await expect(restored.gateway.handle({ method: "GET", path: `/v1/rooms/room-1/workspace-snapshots/${historicalSnapshotId}`, headers: restoredHeaders }))
      .resolves.toMatchObject({ status: 200, body: { snapshot: { hostSessionId: "room-1" } } });
    await expect(restored.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/review-points", headers: restoredHeaders, body: {
      clientRequestId: "review-1", title: "App review", files: [{ path: "src/app.ts", status: "modified", additions: 1, deletions: 0 }],
    } })).resolves.toMatchObject({ status: 201, body: { reviewPoint: { workspaceSnapshotId: historicalSnapshotId } } });
    await restored.dispose();
  });

  it("broadcasts Workspace Sharing changes, restores them on restart, and clears them on stop", async () => {
    const options = {
      roomId: "room-1", hostId: "host", hostSessionId: "room-1", title: "Room", hostDisplayName: "Host",
      sessions: { owns: () => true, followup() {}, steer() {}, cancel() {} },
      now: () => 10,
    };
    const runtime = createDshCollabHostRuntime(options);
    const host = await runtime.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const roomToken = (host.body as { roomToken: string }).roomToken;
    const frames: unknown[] = [];
    runtime.hub.connect({
      connectionId: "connection-1",
      roomId: "room-1",
      token: roomToken,
      onFrame: (frame) => frames.push(frame),
    });
    const headers = { authorization: `Bearer ${roomToken}`, [COLLAB_CAPABILITY_HEADER]: SIDECAR_REVIEW_CAPABILITY };

    expect(await runtime.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/workspace-sharing", headers, body: { enabled: true } })).toMatchObject({ status: 200 });
    expect(frames).toContainEqual(expect.objectContaining({
      kind: "event",
      event: expect.objectContaining({ type: "workspace-sharing.changed", payload: expect.objectContaining({ enabled: true }) }),
    }));
    const snapshot = runtime.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain("workspaceSharing");
    await runtime.dispose();

    const restored = createDshCollabHostRuntime({ ...options, snapshot });
    await restored.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/host", auth: { principalId: "host" }, body: { hostSessionId: "room-1", title: "Room" } });
    const nextHost = await restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const nextHeaders = { authorization: `Bearer ${(nextHost.body as { roomToken: string }).roomToken}`, [COLLAB_CAPABILITY_HEADER]: SIDECAR_REVIEW_CAPABILITY };
    expect(await restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/workspace-sharing", headers: nextHeaders })).toMatchObject({ body: { state: { enabled: true, revision: 1 } } });

    await restored.gateway.handle({ method: "DELETE", path: "/v1/rooms/room-1/host", auth: { principalId: "host" } });
    await restored.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/host", auth: { principalId: "host" }, body: { hostSessionId: "room-1", title: "Room" } });
    const reshared = await restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    const resharedHeaders = { authorization: `Bearer ${(reshared.body as { roomToken: string }).roomToken}`, [COLLAB_CAPABILITY_HEADER]: SIDECAR_REVIEW_CAPABILITY };
    expect(await restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/workspace-sharing", headers: resharedHeaders })).toMatchObject({ body: { state: { enabled: false, revision: 1 } } });
    await restored.dispose();
  });
  it("restores Owned rooms as inactive until explicitly shared in this process", async () => {
    const options = {
      roomId: "room-1", hostId: "host", hostSessionId: "room-1", title: "Room", hostDisplayName: "Host",
      sessions: { owns: (sessionId: string) => sessionId === "room-1", followup() {}, steer() {}, cancel() {} },
      now: () => 10,
    };
    const first = createDshCollabHostRuntime(options);
    const snapshot = first.snapshot();
    await first.dispose();

    const restored = createDshCollabHostRuntime({ ...options, snapshot });
    expect(await restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } })).toMatchObject({ status: 409, body: { error: { code: "ROOM_INACTIVE" } } });
    const shared = await restored.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/host", auth: { principalId: "host" }, body: { hostSessionId: "room-1", title: "Room" } });
    expect(shared).toMatchObject({ status: 200 });
    expect(await restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } })).toMatchObject({ status: 200 });
    const frames: unknown[] = [];
    restored.hub.connect({ connectionId: "connection-1", roomId: "room-1", token: (shared.body as { roomToken: string }).roomToken, onFrame: (frame) => { frames.push(frame); } });
    expect(await restored.gateway.handle({ method: "DELETE", path: "/v1/rooms/room-1/host", auth: { principalId: "host" } })).toMatchObject({ status: 200, body: { sharing: false } });
    expect(frames).toContainEqual(expect.objectContaining({ kind: "closed", reason: "room_not_shared" }));
    expect(await restored.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } })).toMatchObject({ status: 409 });
    expect(restored.rooms.getRoom("room-1")).toMatchObject({ title: "Room" });
    await restored.dispose();
  });

  it("creates one room backed by the trusted DSH session service", async () => {
    const runtime = createDshCollabHostRuntime({ roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", sessions: {
      owns: (sessionId) => sessionId === "session-1",
      followup: () => {}, steer: () => {}, cancel: () => {},
    } });
    expect(runtime.rooms.getRoom("room-1").hostSessionId).toBe("session-1");
    expect(runtime.gateway.tokens).toBeDefined();
    expect(runtime.http.server.listenerCount("upgrade")).toBe(1);
    await runtime.dispose();
  });

  it("applies security settings to room tokens, message size and resource limits", async () => {
    const runtime = createDshCollabHostRuntime({
      roomId: "room-1",
      hostId: "host",
      hostSessionId: "session-1",
      title: "Room",
      hostDisplayName: "Host",
      sessions: { owns: () => true, followup: () => {}, steer: () => {}, cancel: () => {} },
      tokenTtlMs: 25,
      maxMembers: 1,
      maxMessageBytes: 4,
      maxQueue: 2,
      maxConnections: 1,
      now: () => 10,
      tokenFactory: () => "room-token",
    });

    const bootstrapped = await runtime.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    expect(bootstrapped.body).toMatchObject({ expiresAt: 35 });
    const token = (bootstrapped.body as { roomToken: string }).roomToken;
    const firstConnection = runtime.hub.connect({ connectionId: "connection-1", roomId: "room-1", token, onFrame: () => {} });
    expect(() => runtime.hub.connect({ connectionId: "connection-2", roomId: "room-1", token, onFrame: () => {} }))
      .toThrowError(expect.objectContaining({ code: "RESOURCE_LIMIT" }));
    firstConnection.close();
    const oversized = await runtime.gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/messages",
      headers: { authorization: `Bearer ${token}` },
      body: { clientMessageId: "too-large", text: "hello" },
    });
    expect(oversized.status).toBe(422);
    expect(oversized.body).toMatchObject({ error: { code: "INVALID_INPUT" } });

    await runtime.dispose();
  });

  it("snapshots room state and fails a running request when restoring", async () => {
    const options = {
      roomId: "room-1",
      hostId: "host",
      hostSessionId: "session-1",
      title: "Room",
      hostDisplayName: "Host",
      sessions: { owns: () => true, followup: () => {}, steer: () => {}, cancel: () => {} },
      now: () => 10,
    };
    const runtime = createDshCollabHostRuntime(options);
    runtime.rooms.addMember("room-1", { memberId: "member-bob", principalId: "bob", displayName: "Bob", now: 11 });
    runtime.ledger.append({
      eventId: "event-1",
      roomId: "room-1",
      type: "human.message",
      actor: { memberId: "member-bob", principalId: "bob" },
      createdAt: 12,
      payload: { text: "hello" },
    });
    await runtime.gateway.dispatcher.submit({
      principalId: "bob",
      message: { kind: "agent-request", messageId: "message-1", requestId: "request-1", roomId: "room-1", authorMemberId: "member-bob", text: "run tests", target: "dsh", deliveryMode: "followup" },
    });
    await runtime.gateway.dispatcher.drainOne();
    expect(runtime.gateway.dispatcher.get("request-1")?.status).toBe("running");
    const snapshot = runtime.snapshot();
    await runtime.dispose();

    const restored = createDshCollabHostRuntime({ ...options, hostSessionId: "session-2", snapshot });
    expect(restored.rooms.listMembers("room-1")).toHaveLength(2);
    expect(restored.ledger.readAfter("room-1", 0, 10)).toEqual(expect.arrayContaining([expect.objectContaining({ eventId: "event-1", seq: 1 })]));
    expect(restored.gateway.dispatcher.get("request-1")).toMatchObject({
      status: "failed",
      roomId: "room-1",
      claimAttempt: 1,
      error: "Host restarted; delivery outcome is unknown",
    });
    expect(restored.rooms.getRoom("room-1").hostSessionId).toBe("session-2");
    expect(restored.gateway.dispatcher.get("request-1")?.hostSessionId).toBe("session-2");
    await restored.dispose();
  });

  it("fails interrupted work and waits for explicit room sharing before resuming queued requests", async () => {
    const delivered: string[] = [];
    const options = {
      roomId: "room-1",
      hostId: "host",
      hostSessionId: "room-1",
      title: "Room",
      hostDisplayName: "Host",
      sessions: { owns: () => true, followup: () => {}, steer: () => {}, cancel: () => {} },
      now: () => 10,
    };
    const runtime = createDshCollabHostRuntime(options);
    runtime.rooms.addMember("room-1", { memberId: "member-bob", principalId: "bob", displayName: "Bob", now: 11 });
    await runtime.gateway.dispatcher.submit({
      principalId: "bob",
      message: { kind: "agent-request", messageId: "message-1", requestId: "request-1", roomId: "room-1", authorMemberId: "member-bob", text: "continue", target: "dsh", deliveryMode: "followup" },
    });
    await runtime.gateway.dispatcher.submit({
      principalId: "bob",
      message: { kind: "agent-request", messageId: "message-2", requestId: "request-2", roomId: "room-1", authorMemberId: "member-bob", text: "queued", target: "dsh", deliveryMode: "followup" },
    });
    await runtime.gateway.dispatcher.drainOne();
    const snapshot = runtime.snapshot();
    await runtime.dispose();

    const restored = createDshCollabHostRuntime({
      hostId: "host",
      hostDisplayName: "Host",
      snapshot,
      sessions: { owns: (sessionId) => sessionId === "room-1", followup: (input) => { delivered.push(input.requestId); }, steer: () => {}, cancel: () => {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(delivered).toEqual([]);
    expect(restored.gateway.dispatcher.get("request-1")).toMatchObject({ status: "failed", error: "Host restarted; delivery outcome is unknown" });
    expect(restored.gateway.dispatcher.get("request-2")?.status).toBe("queued");
    expect(restored.ledger.readAfter("room-1", 0, 20)).toContainEqual(expect.objectContaining({
      eventId: "request-1:interrupted",
      type: "agent.request.failed",
      payload: expect.objectContaining({ requestId: "request-1" }),
    }));

    expect(await restored.gateway.handle({
      method: "POST",
      path: "/v1/rooms/room-1/host",
      auth: { principalId: "host" },
      body: { hostSessionId: "room-1", title: "Room" },
    })).toMatchObject({ status: 200 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(delivered).toEqual(["request-2"]);
    expect(restored.gateway.dispatcher.get("request-2")?.status).toBe("completed");
    await restored.dispose();
  });

  it("exchanges a restored Participant credential for a fresh room token after Host restart", async () => {
    const tokens = ["invite-secret", "room-token-1", "host-token-2", "room-token-2"];
    const options = {
      roomId: "room-1", hostId: "host", hostSessionId: "room-1", title: "Room", hostDisplayName: "Host",
      sessions: { owns: () => true, followup() {}, steer() {}, cancel() {} },
      port: 0,
      tokenFactory: () => tokens.shift()!,
      resumeCredentialFactory: () => "resume-secret",
    };
    const runtime = createDshCollabHostRuntime(options);
    const invite = await runtime.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/invites", auth: { principalId: "host" }, body: { inviteId: "invite-1", expiresAt: Date.now() + 60_000 } });
    const joined = await runtime.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/join", body: { inviteId: "invite-1", token: (invite.body as { token: string }).token, memberId: "member-bob", displayName: "Bob", resumeCredential: "resume-secret" } });
    expect(joined.body).toMatchObject({ resumeCredential: "resume-secret" });
    const snapshot = runtime.snapshot();
    expect(JSON.stringify(snapshot)).not.toContain("resume-secret");
    await runtime.dispose();

    const restored = createDshCollabHostRuntime({ ...options, snapshot });
    await restored.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/host", auth: { principalId: "host" }, body: { hostSessionId: "room-1", title: "Room" } });
    const resumed = await restored.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/resume", body: { credential: "resume-secret" } });
    expect(resumed.status).toBe(200);
    expect(resumed.body).toMatchObject({ member: { memberId: "member-bob" }, roomToken: "room-token-2" });
    await restored.dispose();
  });
});
