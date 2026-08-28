import { describe, expect, it, vi } from "vitest";
import {
  createDshLocalAgentSessionPort,
  type DshLocalAgent,
  type DshLocalAgentContext,
  type DshLocalAgentSessionEvent,
  type LocalAgentFrame,
} from "../../src/dsh-local-agent.js";

function harness(options: { emitDuringFollowup?: boolean } = {}) {
  const listeners = new Set<(session: { id: string }, event: DshLocalAgentSessionEvent) => void>();
  const agents = new Map<string, DshLocalAgent>();
  const handles = new Map<string, { dispose: ReturnType<typeof vi.fn> }>();
  const createCalls: Array<Record<string, unknown>> = [];
  const mountedContexts: object[] = [];
  const messages: Array<{ id: string }> = [];
  const prompts: string[] = [];
  const cancellations: Array<{ cause: { kind: "user" }; keepInbox: boolean | undefined }> = [];
  const restrictions: Array<{ allow?: string[]; deny?: string[] }> = [];
  const guards: Array<(exec: { name: string; arguments: unknown }) => string | undefined> = [];
  const installedSelections: unknown[] = [];

  const emit = (sessionId: string, event: DshLocalAgentSessionEvent): void => {
    for (const listener of listeners) listener({ id: sessionId }, event);
  };
  const context: DshLocalAgentContext = {
    agentDefaultModel: {
      currentSelection: () => ({ provider: "local-provider", model: "local-model" }),
    },
    installModelSelection(_agentContext, selection) {
      installedSelections.push(selection);
    },
    agents: {
      async create(input) {
        createCalls.push(input as unknown as Record<string, unknown>);
        const agentContext = {
          tools: {
            restrict: (filter: { allow?: string[]; deny?: string[] }) => { restrictions.push(filter); return () => {}; },
            guard: (guard: (exec: { name: string; arguments: unknown }) => string | undefined) => { guards.push(guard); return () => {}; },
          },
        };
        await input.setup?.(agentContext);
        const agent: DshLocalAgent = {
          followup(message) {
            messages.push(message);
            prompts.push(message.content[0].text);
            if (!options.emitDuringFollowup) return;
            emit(input.sessionId, { seq: 1, type: "user/message", data: message });
            emit(input.sessionId, { seq: 2, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "Hello" } } });
            emit(input.sessionId, { seq: 3, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: " world" } } });
            emit(input.sessionId, { seq: 4, type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
          },
          cancel(cause, cancelOptions) {
            cancellations.push({ cause, keepInbox: cancelOptions?.keepInbox });
          },
          whenIdle: vi.fn(async () => {}),
        };
        const dispose = vi.fn(async () => { agents.delete(input.sessionId); });
        agents.set(input.sessionId, agent);
        handles.set(input.sessionId, { dispose });
        return { agent, dispose };
      },
    },
    agentPresets: {
      async mount(agentContext) { mountedContexts.push(agentContext); },
    },
    on(_event, listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };

  return { agents, cancellations, context, createCalls, emit, guards, handles, installedSelections, messages, mountedContexts, prompts, restrictions };
}

describe("DSH local Agent session adapter", () => {
  it("creates a temporary Agent with the requested cwd and the local default preset", async () => {
    const runtime = harness();
    const port = createDshLocalAgentSessionPort(runtime.context, { sessionId: () => "sidecar-1" });

    await expect(port.start({ cwd: "C:\\workspace", prompt: "Review this change" })).resolves.toEqual({ sessionId: "sidecar-1" });

    expect(runtime.createCalls).toEqual([
      expect.objectContaining({
        sessionId: "sidecar-1",
        agentOptions: { provider: "local-provider", model: "local-model" },
        meta: { cwd: "C:\\workspace" },
        setup: expect.any(Function),
      }),
    ]);
    expect(runtime.installedSelections).toEqual([{
      current: { provider: "local-provider", model: "local-model" },
      assembled: undefined,
    }]);
    expect(runtime.mountedContexts).toHaveLength(1);
    expect(runtime.prompts).toEqual(["Review this change"]);
  });

  it("replays output that arrives before subscription and then reports completion", async () => {
    const runtime = harness({ emitDuringFollowup: true });
    const port = createDshLocalAgentSessionPort(runtime.context, { sessionId: () => "sidecar-stream" });
    const { sessionId } = await port.start({ prompt: "Explain the plan" });
    const frames: LocalAgentFrame[] = [];

    port.subscribe(sessionId, (frame) => { frames.push(frame); });

    expect(frames).toEqual([
      { kind: "output", text: "Hello world" },
      { kind: "completed", text: "Hello world" },
    ]);
  });

  it("reports only a safe provider error code when a local turn fails", async () => {
    const runtime = harness();
    const port = createDshLocalAgentSessionPort(runtime.context, { sessionId: () => "sidecar-error" });
    const { sessionId } = await port.start({ prompt: "Review" });
    const frames: LocalAgentFrame[] = [];
    port.subscribe(sessionId, (frame) => { frames.push(frame); });

    runtime.emit(sessionId, { seq: 1, type: "user/message", data: runtime.messages[0] });
    runtime.emit(sessionId, {
      seq: 2,
      type: "turn/end",
      data: { reason: { kind: "error", error: { code: "MODEL_UNAVAILABLE", message: "secret provider detail" } } },
    });

    expect(frames).toEqual([{ kind: "failed", error: "Local Agent failed: MODEL_UNAVAILABLE" }]);
  });

  it("limits a review Agent to reads contained by its materialized snapshot workspace", async () => {
    const runtime = harness();
    const port = createDshLocalAgentSessionPort(runtime.context, { sessionId: () => "sidecar-review" });

    await port.start({ cwd: "C:\\snapshot\\workspace", readOnlyRoot: "C:\\snapshot\\workspace", prompt: "Review" });

    expect(runtime.restrictions).toEqual([{ allow: ["read"] }]);
    expect(runtime.guards).toHaveLength(1);
    expect(runtime.guards[0]?.({ name: "read", arguments: { file_path: "src/app.ts" } })).toBeUndefined();
    expect(runtime.guards[0]?.({ name: "read", arguments: { file_path: "..\\secret.txt" } })).toMatch(/outside/i);
    expect(runtime.guards[0]?.({ name: "write", arguments: { file_path: "src/app.ts" } })).toMatch(/read-only/i);
  });

  it("stops accepting output after cancellation and disposes the exact owned handle", async () => {
    const runtime = harness();
    const port = createDshLocalAgentSessionPort(runtime.context, { sessionId: () => "sidecar-cancel" });
    const { sessionId } = await port.start({ prompt: "Review" });
    const frames: LocalAgentFrame[] = [];
    port.subscribe(sessionId, (frame) => { frames.push(frame); });
    const agent = runtime.agents.get(sessionId);
    if (!agent) throw new Error("fixture did not create the Agent");

    runtime.emit(sessionId, { seq: 1, type: "user/message", data: runtime.messages[0] });
    await port.cancel(sessionId);
    runtime.emit(sessionId, { seq: 2, type: "assistant/chunk", data: { turn: 1, step: 1, chunk: { type: "text-delta", text: "late" } } });

    expect(runtime.cancellations).toEqual([{ cause: { kind: "user" }, keepInbox: false }]);
    expect(agent.whenIdle).toHaveBeenCalledOnce();
    expect(frames).toEqual([{ kind: "cancelled" }]);

    await port.dispose(sessionId);
    expect(runtime.handles.get(sessionId)?.dispose).toHaveBeenCalledOnce();
    expect(runtime.agents.has(sessionId)).toBe(false);
  });
});
