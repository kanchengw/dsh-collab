import { describe, expect, it } from "vitest";
import { createDshCordisSessionService, type DshUserMessage } from "../../src/dsh-cordis-agent.js";

describe("real DSH Cordis Agent bridge", () => {
  it("resolves ctx.agents.get and forwards followup, steer, and cancel", async () => {
    const calls: string[] = [];
    const messages: DshUserMessage[] = [];
    const service = createDshCordisSessionService({
      agents: {
        get: (sessionId) => sessionId === "session-1" ? {
          followup: (message) => { calls.push("followup"); messages.push(message); },
          steer: (message) => { calls.push("steer"); messages.push(message); },
          cancel: (cause, options) => { calls.push(`cancel:${cause.kind}:${String(options?.keepInbox)}`); },
          whenIdle: () => { calls.push("idle"); return Promise.resolve(); },
        } : undefined,
      },
    });
    expect(await service.owns("session-1")).toBe(true);
    expect(await service.owns("missing")).toBe(false);
    await service.followup({ requestId: "request-1", sessionId: "session-1", text: "hello" });
    await service.steer({ requestId: "request-2", sessionId: "session-1", text: "stop" });
    await service.cancel({ requestId: "request-3", sessionId: "session-1", keepInbox: true });
    await service.whenIdle?.({ sessionId: "session-1", requestId: "request-1" });
    expect(calls).toEqual(["followup", "steer", "cancel:user:true", "idle"]);
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: "user", source: { kind: "user" }, content: [{ type: "text", text: "hello" }] });
  });

  it("fails closed when the requested Host session is not a live Agent", async () => {
    const service = createDshCordisSessionService({ agents: { get: () => undefined } });
    await expect(service.followup({ requestId: "request-1", sessionId: "missing", text: "no" })).rejects.toThrow("not live");
  });
});
