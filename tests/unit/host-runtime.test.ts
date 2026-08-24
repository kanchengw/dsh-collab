import { describe, expect, it } from "vitest";
import { createDshCollabHostRuntime } from "../../src/host-runtime.js";

describe("host runtime factory", () => {
  it("creates one room backed by the trusted DSH session service", async () => {
    const runtime = createDshCollabHostRuntime({ roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", sessions: {
      owns: (sessionId) => sessionId === "session-1",
      followup: () => {}, steer: () => {}, cancel: () => {},
    } });
    expect(runtime.rooms.getRoom("room-1").hostSessionId).toBe("session-1");
    expect(runtime.gateway.tokens).toBeDefined();
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
});
