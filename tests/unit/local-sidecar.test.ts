import { describe, expect, it, vi } from "vitest";
import type { LocalAgentFrame, LocalAgentSessionPort } from "../../src/dsh-local-agent.js";
import { LocalSidecarService } from "../../src/local-sidecar.js";

function harness() {
  const listeners = new Map<string, (frame: LocalAgentFrame) => void>();
  const prompts: string[] = [];
  const cancelled: string[] = [];
  const disposed: string[] = [];
  let sequence = 0;
  const port: LocalAgentSessionPort = {
    async start(input) {
      prompts.push(input.prompt);
      sequence += 1;
      return { sessionId: `session-${String(sequence)}` };
    },
    subscribe(sessionId, listener) {
      listeners.set(sessionId, listener);
      return () => { listeners.delete(sessionId); };
    },
    async cancel(sessionId) {
      cancelled.push(sessionId);
      listeners.get(sessionId)?.({ kind: "cancelled" });
    },
    async dispose(sessionId) { disposed.push(sessionId); },
  };
  return {
    cancelled,
    disposed,
    emit: (sessionId: string, frame: LocalAgentFrame) => { listeners.get(sessionId)?.(frame); },
    port,
    prompts,
  };
}

const request = {
  roomId: "room-1",
  requestedBy: "member-bob",
  localPrompt: "Explain why the retry is safe.",
  roomEventSeq: 7,
  contextMessages: [
    { eventId: "event-1", author: "Alice", text: "The request can be retried." },
    { eventId: "event-2", author: "@agent", text: "The idempotency key is room-scoped." },
  ],
};

describe("Requester-local Sidecar", () => {
  it("streams a private Explain task from collab-visible context without a Main Agent dependency", async () => {
    const runtime = harness();
    const sidecar = new LocalSidecarService(runtime.port, {
      now: () => 100,
      taskId: () => "task-1",
    });

    const started = await sidecar.startExplain(request);
    expect(started).toMatchObject({
      task: {
        taskId: "task-1",
        roomId: "room-1",
        type: "explain",
        localPrompt: request.localPrompt,
        executor: "requester-local",
        context: { roomEventSeq: 7, selectedRoomEventIds: ["event-1", "event-2"] },
        state: { status: "running" },
        publication: { status: "private" },
        requestedBy: "member-bob",
        createdAt: 100,
      },
      output: "",
    });
    expect(runtime.prompts[0]).toContain("[Alice]\nThe request can be retried.");
    expect(runtime.prompts[0]).toContain("[@agent]\nThe idempotency key is room-scoped.");
    expect(runtime.prompts[0]).toContain(request.localPrompt);

    runtime.emit("session-1", { kind: "output", text: "It is safe" });
    expect(sidecar.get("room-1")).toMatchObject({ output: "It is safe", task: { state: { status: "running" } } });
    runtime.emit("session-1", { kind: "completed", text: "It is safe because the key is stable." });
    await vi.waitFor(() => { expect(runtime.disposed).toEqual(["session-1"]); });
    expect(sidecar.get("room-1")).toMatchObject({
      output: "It is safe because the key is stable.",
      task: { state: { status: "completed" }, publication: { status: "private" } },
    });
  });

  it("allows only one running task per local user and room but keeps rooms independent", async () => {
    const runtime = harness();
    const sidecar = new LocalSidecarService(runtime.port, { taskId: () => `task-${String(runtime.prompts.length + 1)}` });

    await sidecar.startExplain(request);
    await expect(sidecar.startExplain({ ...request, localPrompt: "A second request" })).rejects.toThrow(/already running/i);
    await expect(sidecar.startExplain({ ...request, roomId: "room-2" })).resolves.toMatchObject({ task: { roomId: "room-2" } });
    expect(runtime.prompts).toHaveLength(2);
  });

  it("requires an explicit bounded collaboration context instead of acting as a generic local chat", async () => {
    const runtime = harness();
    const sidecar = new LocalSidecarService(runtime.port);

    await expect(sidecar.startExplain({ ...request, contextMessages: [] })).rejects.toThrow(/contextMessages/);
    expect(runtime.prompts).toEqual([]);
  });

  it("cancels and disposes the exact temporary Agent session while retaining a private terminal result", async () => {
    const runtime = harness();
    const sidecar = new LocalSidecarService(runtime.port, { taskId: () => "task-cancel" });
    await sidecar.startExplain(request);
    runtime.emit("session-1", { kind: "output", text: "partial" });

    await sidecar.cancel("room-1", "task-cancel");

    expect(runtime.cancelled).toEqual(["session-1"]);
    expect(runtime.disposed).toEqual(["session-1"]);
    expect(sidecar.get("room-1")).toMatchObject({
      output: "partial",
      task: { state: { status: "cancelled" }, publication: { status: "private" } },
    });
    runtime.emit("session-1", { kind: "output", text: "late" });
    expect(sidecar.get("room-1")?.output).toBe("partial");
  });

  it("still disposes the exact temporary Agent session when cancellation fails", async () => {
    const runtime = harness();
    runtime.port.cancel = async () => { throw new Error("cancel failed"); };
    const sidecar = new LocalSidecarService(runtime.port, { taskId: () => "task-cancel-failure" });
    await sidecar.startExplain(request);

    await expect(sidecar.cancel("room-1", "task-cancel-failure")).rejects.toThrow("cancel failed");

    expect(runtime.disposed).toEqual(["session-1"]);
    expect(sidecar.get("room-1")).toMatchObject({
      task: { state: { status: "failed", error: "Local Agent cancel failed: cancel failed" } },
    });
  });

  it("reports a terminal task as failed when its temporary Agent session cannot be cleaned up", async () => {
    const runtime = harness();
    runtime.port.dispose = async () => { throw new Error("dispose failed"); };
    const sidecar = new LocalSidecarService(runtime.port, { taskId: () => "task-cleanup" });
    await sidecar.startExplain(request);

    runtime.emit("session-1", { kind: "completed", text: "finished" });

    await vi.waitFor(() => {
      expect(sidecar.get("room-1")).toMatchObject({
        output: "finished",
        task: { state: { status: "failed", error: "Local Agent cleanup failed: dispose failed" } },
      });
    });
  });

  it("disposes the exact temporary Agent session when subscription setup fails", async () => {
    const runtime = harness();
    runtime.port.subscribe = () => { throw new Error("subscribe failed"); };
    const sidecar = new LocalSidecarService(runtime.port, { taskId: () => "task-subscribe-failure" });

    await expect(sidecar.startExplain(request)).rejects.toThrow("subscribe failed");

    expect(runtime.disposed).toEqual(["session-1"]);
    expect(sidecar.get("room-1")).toMatchObject({
      task: { state: { status: "failed", error: "subscribe failed" } },
    });
  });

  it("cancels and disposes a temporary Agent that finishes starting during service teardown", async () => {
    let resolveStart!: (value: { sessionId: string }) => void;
    const started = new Promise<{ sessionId: string }>((resolve) => { resolveStart = resolve; });
    const cancelled: string[] = [];
    const disposed: string[] = [];
    const sidecar = new LocalSidecarService({
      start: async () => await started,
      subscribe: () => () => {},
      cancel: async (sessionId) => { cancelled.push(sessionId); },
      dispose: async (sessionId) => { disposed.push(sessionId); },
    });

    const pending = sidecar.startExplain(request);
    const teardown = sidecar.dispose();
    resolveStart({ sessionId: "session-late" });

    await expect(pending).rejects.toThrow(/disposed/i);
    await teardown;
    expect(cancelled).toEqual(["session-late"]);
    expect(disposed).toEqual(["session-late"]);
    expect(sidecar.get("room-1")).toBeUndefined();
    await expect(sidecar.startExplain(request)).rejects.toThrow(/disposed/i);
  });

  it("cancels a queued task after its exact temporary Agent session finishes starting", async () => {
    let resolveStart!: (value: { sessionId: string }) => void;
    const started = new Promise<{ sessionId: string }>((resolve) => { resolveStart = resolve; });
    const cancelled: string[] = [];
    const disposed: string[] = [];
    const sidecar = new LocalSidecarService({
      start: async () => await started,
      subscribe: () => () => {},
      cancel: async (sessionId) => { cancelled.push(sessionId); },
      dispose: async (sessionId) => { disposed.push(sessionId); },
    }, { taskId: () => "task-queued" });

    const starting = sidecar.startExplain(request);
    expect(sidecar.get("room-1")).toMatchObject({ task: { state: { status: "queued" } } });
    const cancelling = sidecar.cancel("room-1", "task-queued");
    resolveStart({ sessionId: "session-queued" });

    await starting;
    await expect(cancelling).resolves.toMatchObject({ task: { state: { status: "cancelled" } } });
    expect(cancelled).toEqual(["session-queued"]);
    expect(disposed).toEqual(["session-queued"]);
  });

  it("waits for terminal cleanup before replacing a room task", async () => {
    const runtime = harness();
    let releaseDispose!: () => void;
    const disposing = new Promise<void>((resolve) => { releaseDispose = resolve; });
    runtime.port.dispose = async () => { await disposing; };
    const sidecar = new LocalSidecarService(runtime.port, { taskId: () => `task-${String(runtime.prompts.length + 1)}` });
    await sidecar.startExplain(request);
    runtime.emit("session-1", { kind: "completed", text: "done" });

    const replacement = sidecar.startExplain({ ...request, localPrompt: "Explain again" });
    await Promise.resolve();
    expect(runtime.prompts).toHaveLength(1);
    releaseDispose();

    await expect(replacement).resolves.toMatchObject({ task: { state: { status: "running" } } });
    expect(runtime.prompts).toHaveLength(2);
  });
});
