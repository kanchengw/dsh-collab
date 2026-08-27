import { describe, expect, it } from "vitest";
import { createDshCordisSessionService, type DshUserMessage } from "../../src/dsh-cordis-agent.js";

describe("real DSH Cordis Agent bridge", () => {
  it("publishes accumulated text chunks for only the matching Collab request", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    let observe: ((session: { id: string }, event: { seq: number; type: string; data: unknown }) => void) | undefined;
    const output: unknown[] = [];
    const agent = {
      session: { get events() { return events; } },
      followup(message: DshUserMessage) {
        const appended = { seq: 0, type: "user/message", data: message };
        events.push(appended);
        observe?.({ id: "session-1" }, appended);
      },
      steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const service = createDshCordisSessionService({
      agents: { get: () => agent },
      onSessionEvent: (listener) => { observe = listener; return () => { observe = undefined; }; },
    });
    service.onAgentOutput?.((frame) => output.push(frame));

    await service.followup({ roomId: "room-1", requestId: "request-1", sessionId: "session-1", text: "reply" });
    observe?.({ id: "other-session" }, { seq: 1, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "wrong" } } });
    observe?.({ id: "session-1" }, { seq: 2, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "reasoning-delta", index: 0, text: "hidden" } } });
    observe?.({ id: "session-1" }, { seq: 3, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "Hello" } } });
    observe?.({ id: "session-1" }, { seq: 4, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: " world" } } });
    observe?.({ id: "session-1" }, { seq: 5, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    observe?.({ id: "session-1" }, { seq: 6, type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: " private Host turn" } } });

    expect(output).toEqual([
      { kind: "agent-output", roomId: "room-1", requestId: "request-1", text: "Hello", streaming: true },
      { kind: "agent-output", roomId: "room-1", requestId: "request-1", text: "Hello world", streaming: true },
    ]);
  });

  it("forgets stream association when waiting for the Host Agent fails", async () => {
    let observe: ((session: { id: string }, event: { seq: number; type: string; data: unknown }) => void) | undefined;
    const output: unknown[] = [];
    const agent = {
      session: { events: [] },
      followup(message: DshUserMessage) { observe?.({ id: "session-1" }, { seq: 0, type: "user/message", data: message }); },
      steer() {}, cancel() {}, whenIdle: () => Promise.reject(new Error("Host stopped")),
    };
    const service = createDshCordisSessionService({
      agents: { get: () => agent },
      onSessionEvent: (listener) => { observe = listener; return () => {}; },
    });
    service.onAgentOutput?.((frame) => output.push(frame));

    await service.followup({ roomId: "room-1", requestId: "request-1", sessionId: "session-1", text: "reply" });
    await expect(service.whenIdle?.({ requestId: "request-1", sessionId: "session-1" })).rejects.toThrow("Host stopped");
    observe?.({ id: "session-1" }, { seq: 1, type: "assistant/chunk", data: { turn: 2, step: 1, chunk: { type: "text-delta", index: 0, text: "unrelated" } } });
    expect(output).toEqual([]);
  });

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

  it("waits for the Host turn and returns the assistant text for the matching request", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    const agent = {
      session: { get events() { return events; } },
      followup(message: DshUserMessage) {
        events.push(
          { seq: 0, type: "turn/start", data: { turn: 1 } },
          { seq: 1, type: "user/message", data: message },
          { seq: 2, type: "assistant/message", data: { turn: 1, step: 1, message: { content: [{ type: "text", text: "COLLAB_AGENT_OUTPUT" }] } } },
          { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
        );
      },
      steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const service = createDshCordisSessionService({ agents: { get: () => agent } });

    await service.followup({ requestId: "request-output", sessionId: "session-1", text: "reply once" });
    await expect(service.whenIdle?.({ sessionId: "session-1", requestId: "request-output" })).resolves.toEqual({ text: "COLLAB_AGENT_OUTPUT" });
  });

  it("returns a safe failure when the matching Host turn ends in error", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    const agent = {
      session: { get events() { return events; } },
      followup(message: DshUserMessage) {
        events.push(
          { seq: 0, type: "turn/start", data: { turn: 1 } },
          { seq: 1, type: "user/message", data: message },
          { seq: 2, type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { message: "credential path C:/secret", code: "MISSING_CREDENTIAL" } } } },
        );
      },
      steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const service = createDshCordisSessionService({ agents: { get: () => agent } });

    await service.followup({ requestId: "request-failed", sessionId: "session-1", text: "reply once" });
    await expect(service.whenIdle?.({ sessionId: "session-1", requestId: "request-failed" })).resolves.toEqual({ error: "Host Agent failed: MISSING_CREDENTIAL" });
  });

  it("does not expose an unstructured Host error code", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    const agent = {
      session: { get events() { return events; } },
      followup(message: DshUserMessage) {
        events.push(
          { seq: 0, type: "user/message", data: message },
          { seq: 1, type: "turn/end", data: { turn: 1, reason: { kind: "error", error: { code: "C:/private/credential.txt" } } } },
        );
      },
      steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const service = createDshCordisSessionService({ agents: { get: () => agent } });

    await service.followup({ requestId: "request-failed", sessionId: "session-1", text: "reply once" });
    await expect(service.whenIdle?.({ sessionId: "session-1", requestId: "request-failed" })).resolves.toEqual({ error: "Host Agent request failed" });
  });
});
