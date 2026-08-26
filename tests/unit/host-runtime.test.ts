import { describe, expect, it } from "vitest";
import { createDshCollabHostRuntime } from "../../src/host-runtime.js";

describe("host runtime factory", () => {
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
      now: () => 10,
      tokenFactory: () => "room-token",
    });

    const bootstrapped = await runtime.gateway.handle({ method: "GET", path: "/v1/rooms/room-1/bootstrap", auth: { principalId: "host" } });
    expect(bootstrapped.body).toMatchObject({ expiresAt: 35 });
    const token = (bootstrapped.body as { roomToken: string }).roomToken;
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

  it("snapshots and restores room state, ledger events and queued requests", async () => {
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
    expect(restored.gateway.dispatcher.get("request-1")).toMatchObject({ status: "running", roomId: "room-1", claimAttempt: 2 });
    expect(restored.rooms.getRoom("room-1").hostSessionId).toBe("session-2");
    expect(restored.gateway.dispatcher.get("request-1")?.hostSessionId).toBe("session-2");
    await restored.dispose();
  });

  it("automatically resumes an interrupted Agent request after restore", async () => {
    const delivered: string[] = [];
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
    await runtime.gateway.dispatcher.submit({
      principalId: "bob",
      message: { kind: "agent-request", messageId: "message-1", requestId: "request-1", roomId: "room-1", authorMemberId: "member-bob", text: "continue", target: "dsh", deliveryMode: "followup" },
    });
    await runtime.gateway.dispatcher.drainOne();
    const snapshot = runtime.snapshot();
    delete snapshot.dispatcher.records.find((record) => record.requestId === "request-1")?.claimAttempt;
    await runtime.dispose();

    const restored = createDshCollabHostRuntime({
      ...options,
      hostSessionId: "session-2",
      snapshot,
      sessions: { owns: () => true, followup: (input) => { delivered.push(input.requestId); }, steer: () => {}, cancel: () => {} },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(delivered).toEqual(["request-1"]);
    expect(restored.gateway.dispatcher.get("request-1")?.status).toBe("completed");
    expect(restored.ledger.readAfter("room-1", 0, 20)).toContainEqual(expect.objectContaining({ eventId: "request-1:claimed:2" }));
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
    const joined = await runtime.gateway.handle({ method: "POST", path: "/v1/rooms/room-1/join", body: { inviteId: "invite-1", token: (invite.body as { token: string }).token, memberId: "member-bob", displayName: "Bob" } });
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
