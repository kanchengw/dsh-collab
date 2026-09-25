import { describe, expect, it } from "vitest";
import { createDshCordisSessionService, type DshUserMessage } from "../../src/dsh-cordis-agent.js";

type TestAssistantStreamFrame =
  | { type: "start"; attemptId: string; revision: number; turn: number; step: number }
  | { type: "chunk"; attemptId: string; revision: number; index: number; time: number; chunk: { type: string; text?: string } }
  | { type: "end"; attemptId: string; revision: number; index: number; outcome: { kind: "committed"; eventType: "assistant/message" | "assistant/attempt"; seq: number } | { kind: "abandoned" } };

describe("real DSH Cordis Agent bridge", () => {
  it("reads the immutable workspace path from the live DSH Session header", () => {
    const service = createDshCordisSessionService({
      agents: { get: (sessionId) => sessionId === "session-1" ? {
        session: { events: [], header: { cwd: "C:/trusted/workspace" } },
        followup() {}, steer() {}, cancel() {},
      } : undefined },
    });

    expect(service.workspacePath?.("session-1")).toBe("C:/trusted/workspace");
    expect(service.workspacePath?.("missing")).toBeUndefined();
  });

  it("publishes committed-step text from only the matching Agent stream", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    let observe: ((session: { id: string }, event: { seq: number; type: string; data: unknown }) => void) | undefined;
    let observeStream: ((payload: { agent: object; frame: TestAssistantStreamFrame }) => void) | undefined;
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
      onAssistantStream: (listener: typeof observeStream) => { observeStream = listener; return () => { observeStream = undefined; }; },
    });
    service.onAgentOutput?.((frame) => output.push(frame));

    await service.followup({ roomId: "room-1", requestId: "request-1", sessionId: "session-1", text: "reply" });
    observeStream?.({ agent: {}, frame: { type: "chunk", attemptId: "other:1", revision: 1, index: 0, time: 1, chunk: { type: "text-delta", text: "wrong" } } });
    observeStream?.({ agent, frame: { type: "start", attemptId: "session-1:1", revision: 2, turn: 1, step: 1 } });
    observeStream?.({ agent, frame: { type: "chunk", attemptId: "session-1:1", revision: 3, index: 0, time: 2, chunk: { type: "reasoning-delta", text: "hidden" } } });
    observeStream?.({ agent, frame: { type: "chunk", attemptId: "session-1:1", revision: 4, index: 1, time: 3, chunk: { type: "text-delta", text: "Hello" } } });
    observeStream?.({ agent, frame: { type: "chunk", attemptId: "session-1:1", revision: 5, index: 2, time: 4, chunk: { type: "text-delta", text: " world" } } });
    observeStream?.({ agent, frame: { type: "end", attemptId: "session-1:1", revision: 6, index: 3, outcome: { kind: "committed", eventType: "assistant/message", seq: 2 } } });
    observeStream?.({ agent, frame: { type: "start", attemptId: "session-1:2", revision: 7, turn: 1, step: 2 } });
    observeStream?.({ agent, frame: { type: "chunk", attemptId: "session-1:2", revision: 8, index: 0, time: 5, chunk: { type: "text-delta", text: "Next" } } });
    observe?.({ id: "session-1" }, { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    observeStream?.({ agent, frame: { type: "chunk", attemptId: "session-1:2", revision: 9, index: 1, time: 6, chunk: { type: "text-delta", text: " private Host turn" } } });

    expect(output).toEqual([
      { kind: "agent-output", roomId: "room-1", requestId: "request-1", text: "Hello", streaming: true },
      { kind: "agent-output", roomId: "room-1", requestId: "request-1", text: "Hello world", streaming: true },
      { kind: "agent-output", roomId: "room-1", requestId: "request-1", text: "Hello world\n\nNext", streaming: true },
    ]);
  });

  it("rolls back failed attempt text before publishing retry output", async () => {
    let observe: ((session: { id: string }, event: { seq: number; type: string; data: unknown }) => void) | undefined;
    let observeStream: ((payload: { agent: object; frame: TestAssistantStreamFrame }) => void) | undefined;
    const output: unknown[] = [];
    const agent = {
      session: { events: [] },
      followup(message: DshUserMessage) { observe?.({ id: "session-1" }, { seq: 0, type: "user/message", data: message }); },
      steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const service = createDshCordisSessionService({
      agents: { get: () => agent },
      onSessionEvent: (listener) => { observe = listener; return () => {}; },
      onAssistantStream: (listener: typeof observeStream) => { observeStream = listener; return () => {}; },
    });
    service.onAgentOutput?.((frame) => output.push(frame));

    await service.followup({ roomId: "room-1", requestId: "request-1", sessionId: "session-1", text: "reply" });
    observeStream?.({ agent, frame: { type: "start", attemptId: "session-1:1", revision: 1, turn: 1, step: 1 } });
    observeStream?.({ agent, frame: { type: "chunk", attemptId: "session-1:1", revision: 2, index: 0, time: 1, chunk: { type: "text-delta", text: "discarded" } } });
    observeStream?.({ agent, frame: { type: "end", attemptId: "session-1:1", revision: 3, index: 1, outcome: { kind: "committed", eventType: "assistant/attempt", seq: 1 } } });
    observeStream?.({ agent, frame: { type: "start", attemptId: "session-1:2", revision: 4, turn: 1, step: 1 } });
    observeStream?.({ agent, frame: { type: "chunk", attemptId: "session-1:2", revision: 5, index: 0, time: 2, chunk: { type: "text-delta", text: "kept" } } });

    expect(output).toEqual([
      { kind: "agent-output", roomId: "room-1", requestId: "request-1", text: "discarded", streaming: true },
      { kind: "agent-output", roomId: "room-1", requestId: "request-1", text: "", streaming: true },
      { kind: "agent-output", roomId: "room-1", requestId: "request-1", text: "kept", streaming: true },
    ]);
  });

  it("forgets stream association when waiting for the Host Agent fails", async () => {
    let observe: ((session: { id: string }, event: { seq: number; type: string; data: unknown }) => void) | undefined;
    let observeStream: ((payload: { agent: object; frame: TestAssistantStreamFrame }) => void) | undefined;
    const output: unknown[] = [];
    const agent = {
      session: { events: [] },
      followup(message: DshUserMessage) { observe?.({ id: "session-1" }, { seq: 0, type: "user/message", data: message }); },
      steer() {}, cancel() {}, whenIdle: () => Promise.reject(new Error("Host stopped")),
    };
    const service = createDshCordisSessionService({
      agents: { get: () => agent },
      onSessionEvent: (listener) => { observe = listener; return () => {}; },
      onAssistantStream: (listener: typeof observeStream) => { observeStream = listener; return () => {}; },
    });
    service.onAgentOutput?.((frame) => output.push(frame));

    await service.followup({ roomId: "room-1", requestId: "request-1", sessionId: "session-1", text: "reply" });
    await expect(service.whenIdle?.({ requestId: "request-1", sessionId: "session-1" })).rejects.toThrow("Host stopped");
    observeStream?.({ agent, frame: { type: "chunk", attemptId: "session-1:1", revision: 1, index: 0, time: 1, chunk: { type: "text-delta", text: "unrelated" } } });
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

  it("injects selected context content through the native Agent injection API", async () => {
    const injected: unknown[] = [];
    const agent = {
      inject: (message: unknown) => { injected.push(message); },
      followup: () => {},
      steer: () => {},
      cancel: () => {},
    };
    const service = createDshCordisSessionService({ agents: { get: () => agent } });

    await service.followup({ sessionId: "session-1", requestId: "request-1", text: "@agent use this", contextContent: ["Original quoted message"] });

    expect(injected).toEqual([expect.objectContaining({
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: "Original quoted message" }],
    })]);
  });

  it("fails closed when the requested Host session is not a live Agent", async () => {
    const service = createDshCordisSessionService({ agents: { get: () => undefined } });
    await expect(service.followup({ requestId: "request-1", sessionId: "missing", text: "no" })).rejects.toThrow("not live");
  });

  it("waits for the Host turn and returns the assistant text for the matching request", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    const agent = {
      // DSH 0.1.2 exposes Session history through snapshotEvents(); the
      // legacy events property must not be required by the production adapter.
      session: { snapshotEvents: () => events },
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

  it("does not attribute a later Host turn to the matching request", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    const agent = {
      session: { snapshotEvents: () => events },
      followup(message: DshUserMessage) {
        events.push(
          { seq: 0, type: "user/message", data: message },
          { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "FIRST" }] } } },
          { seq: 2, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } },
          { seq: 3, type: "user/message", data: { ...message, id: "later-message" } },
          { seq: 4, type: "assistant/message", data: { message: { content: [{ type: "text", text: "LATER" }] } } },
          { seq: 5, type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } },
        );
      },
      steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const service = createDshCordisSessionService({ agents: { get: () => agent } });

    await service.followup({ requestId: "request-output", sessionId: "session-1", text: "reply once" });

    await expect(service.whenIdle?.({ sessionId: "session-1", requestId: "request-output" })).resolves.toEqual({ text: "FIRST" });
  });

  it("fails closed when the matching request never reaches a terminal turn", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    const agent = {
      session: { snapshotEvents: () => events },
      followup(message: DshUserMessage) {
        events.push(
          { seq: 0, type: "user/message", data: message },
          { seq: 1, type: "assistant/message", data: { message: { content: [{ type: "text", text: "PARTIAL" }] } } },
        );
      },
      steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const service = createDshCordisSessionService({ agents: { get: () => agent } });

    await service.followup({ requestId: "request-open", sessionId: "session-1", text: "reply once" });

    await expect(service.whenIdle?.({ sessionId: "session-1", requestId: "request-open" })).resolves.toEqual({
      error: "Host Agent request did not reach a terminal turn",
    });
  });

  it("reports a request cancelled in the Host inbox before execution", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    const agent = {
      session: { snapshotEvents: () => events },
      followup(message: DshUserMessage) {
        events.push(
          { seq: 0, type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [message] } },
          { seq: 1, type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, removedCount: 1, inserted: [], outcome: "canceled" } },
        );
      },
      steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const service = createDshCordisSessionService({ agents: { get: () => agent } });

    await service.followup({ requestId: "request-cancelled", sessionId: "session-1", text: "reply once" });

    await expect(service.whenIdle?.({ sessionId: "session-1", requestId: "request-cancelled" })).resolves.toEqual({
      error: "Host Agent request was cancelled before execution",
    });
  });

  it("reports a claimed request blocked before DSH records its user message", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    const agent = {
      session: { snapshotEvents: () => events },
      followup(message: DshUserMessage) {
        events.push(
          { seq: 0, type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, inserted: [message] } },
          { seq: 1, type: "turn/start", data: { turn: 1 } },
          { seq: 2, type: "agent/inbox/spliced", data: { target: "next-turn", start: 0, removedCount: 1, inserted: [] } },
          { seq: 3, type: "turn/end", data: { turn: 1, reason: { kind: "blocked" } } },
        );
      },
      steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const service = createDshCordisSessionService({ agents: { get: () => agent } });

    await service.followup({ requestId: "request-blocked", sessionId: "session-1", text: "reply once" });

    await expect(service.whenIdle?.({ sessionId: "session-1", requestId: "request-blocked" })).resolves.toEqual({
      error: "Host Agent request was blocked before execution",
    });
  });

  it("reports an externally aborted matching Host turn instead of completing it", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    const agent = {
      session: { snapshotEvents: () => events },
      followup(message: DshUserMessage) {
        events.push(
          { seq: 0, type: "user/message", data: message },
          { seq: 1, type: "turn/end", data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } },
        );
      },
      steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const service = createDshCordisSessionService({ agents: { get: () => agent } });

    await service.followup({ requestId: "request-aborted", sessionId: "session-1", text: "reply once" });

    await expect(service.whenIdle?.({ sessionId: "session-1", requestId: "request-aborted" })).resolves.toEqual({
      error: "Host Agent request was cancelled",
    });
  });

  it("reports an interrupted matching Host turn instead of completing it", async () => {
    const events: Array<{ seq: number; type: string; data: unknown }> = [];
    const agent = {
      session: { snapshotEvents: () => events },
      followup(message: DshUserMessage) {
        events.push(
          { seq: 0, type: "user/message", data: message },
          { seq: 1, type: "turn/end", data: { turn: 1, reason: { kind: "interrupted" } } },
        );
      },
      steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const service = createDshCordisSessionService({ agents: { get: () => agent } });

    await service.followup({ requestId: "request-interrupted", sessionId: "session-1", text: "reply once" });

    await expect(service.whenIdle?.({ sessionId: "session-1", requestId: "request-interrupted" })).resolves.toEqual({
      error: "Host Agent request was interrupted",
    });
  });

  it("fails closed if the live Host Agent is replaced before completion", async () => {
    const original = {
      session: { events: [] },
      followup() {}, steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    const replacement = {
      session: { events: [] },
      followup() {}, steer() {}, cancel() {}, whenIdle: () => Promise.resolve(),
    };
    let live = original;
    const service = createDshCordisSessionService({ agents: { get: () => live } });

    await service.followup({ requestId: "request-replaced", sessionId: "session-1", text: "reply once" });
    live = replacement;

    await expect(service.whenIdle?.({ sessionId: "session-1", requestId: "request-replaced" })).resolves.toEqual({
      error: "Host Agent changed before request completion",
    });
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
