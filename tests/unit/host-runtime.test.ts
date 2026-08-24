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
});
