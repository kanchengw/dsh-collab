import { describe, expect, it } from "vitest";
import type { RoomContextState } from "../../src/room-context.js";
import {
  RoomSummaryError,
  RoomSummaryService,
  createDshRoomSummaryService,
  type RoomSummaryLlmPort,
  type RoomSummaryLlmStreamChunk,
} from "../../src/room-summary.js";

function context(overrides: Partial<RoomContextState> = {}): RoomContextState {
  return {
    version: 1,
    roomId: "room-1",
    appliedThroughSeq: 7,
    decisions: [],
    activeWorkUpdates: [],
    changeSets: [],
    ...overrides,
  };
}

function textResponse(summary: string): RoomSummaryLlmStreamChunk[] {
  return [
    { type: "block-start", index: 0, blockType: "text" },
    { type: "text-delta", index: 0, text: JSON.stringify({ summary }) },
    { type: "block-end", index: 0, block: { type: "text", text: JSON.stringify({ summary }) } },
    { type: "finish", reason: { kind: "stop" } },
  ];
}

function streamOf(chunks: RoomSummaryLlmStreamChunk[], wait?: Promise<void>): AsyncIterable<RoomSummaryLlmStreamChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      if (wait) await wait;
      for (const chunk of chunks) yield chunk;
    },
  };
}

function llm(streams: Array<AsyncIterable<RoomSummaryLlmStreamChunk>>): RoomSummaryLlmPort & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    stream(options) {
      calls.push(options);
      const next = streams.shift();
      if (!next) throw new Error("unexpected LLM call");
      return next;
    },
  };
}

describe("RoomSummaryService", () => {
  it("calls the public LLM port with only a revision-bound Room Context projection", async () => {
    const provider = llm([streamOf(textResponse("Room is coordinating a reconnect fix."))]);
    const service = new RoomSummaryService(provider, { provider: "deepseek", model: "deepseek-v4-flash" });

    const result = await service.summarize({
      context: context({ currentSummary: { kind: "deterministic", text: "Reconnect guard", sourceSeq: 7 } }),
    });

    expect(result).toMatchObject({
      roomId: "room-1",
      sourceSeq: 7,
      text: "Room is coordinating a reconnect fix.",
      route: { provider: "deepseek", model: "deepseek-v4-flash" },
      disclosure: { kind: "room-public-only", sourceSeq: 7 },
    });
    const options = provider.calls[0] as { messages: Array<{ content: Array<{ type: string; text: string }> }>; sessionId?: unknown; tools?: unknown };
    expect(options.sessionId).toBeUndefined();
    expect(options.tools).toBeUndefined();
    expect(options.messages[0]?.content[0]?.text).toContain('"roomId":"room-1"');
    expect(options.messages[0]?.content[0]?.text).toContain('"appliedThroughSeq":7');
    expect(options.messages[0]?.content[0]?.text).not.toContain("private");
  });

  it("rejects malformed or non-text model output", async () => {
    const provider = llm([streamOf([
      { type: "block-start", index: 0, blockType: "text" },
      { type: "text-delta", index: 0, text: "not json" },
      { type: "block-end", index: 0, block: { type: "text", text: "not json" } },
      { type: "finish", reason: { kind: "stop" } },
    ])]);
    const service = new RoomSummaryService(provider, { provider: "deepseek", model: "model" });

    await expect(service.summarize({ context: context() })).rejects.toThrow(RoomSummaryError);
  });

  it("rejects a result whose revision is older than a newer queued request", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const provider = llm([
      streamOf(textResponse("old"), wait),
      streamOf(textResponse("new")),
    ]);
    const service = new RoomSummaryService(provider, { provider: "deepseek", model: "model" });
    const old = service.summarize({ context: context({ appliedThroughSeq: 7 }) });
    const newer = service.summarize({ context: context({ appliedThroughSeq: 8 }) });
    release();

    await expect(old).rejects.toMatchObject({ code: "STALE_RESULT" });
    await expect(newer).resolves.toMatchObject({ sourceSeq: 8, text: "new" });
    expect(provider.calls).toHaveLength(2);
  });

  it("coalesces multiple pending revisions to the newest one", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const provider = llm([streamOf(textResponse("first"), wait), streamOf(textResponse("latest"))]);
    const service = new RoomSummaryService(provider, { provider: "deepseek", model: "model" });
    const first = service.summarize({ context: context({ appliedThroughSeq: 1 }) });
    const pendingA = service.summarize({ context: context({ appliedThroughSeq: 2 }) });
    const pendingB = service.summarize({ context: context({ appliedThroughSeq: 3 }) });
    release();

    await expect(first).rejects.toMatchObject({ code: "STALE_RESULT" });
    await expect(pendingA).rejects.toMatchObject({ code: "STALE_RESULT" });
    await expect(pendingB).resolves.toMatchObject({ sourceSeq: 3, text: "latest" });
    expect(provider.calls).toHaveLength(2);
  });

  it("retries a failed public call at most once and exposes the successful usage", async () => {
    const provider = llm([
      streamOf([{ type: "finish", reason: { kind: "error", failure: { code: "TEMPORARY", message: "retry" } } }]),
      streamOf([
        { type: "block-start", index: 0, blockType: "text" },
        { type: "text-delta", index: 0, text: JSON.stringify({ summary: "recovered" }) },
        { type: "block-end", index: 0, block: { type: "text", text: JSON.stringify({ summary: "recovered" }) } },
        { type: "usage", usage: { inputTokens: 10, outputTokens: 2 } },
        { type: "finish", reason: { kind: "stop" } },
      ]),
    ]);
    const service = new RoomSummaryService(provider, { provider: "deepseek", model: "model" }, { maxAttempts: 2 });

    await expect(service.summarize({ context: context() })).resolves.toMatchObject({
      text: "recovered",
      usage: { inputTokens: 10, outputTokens: 2 },
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("cancels an in-flight Room call without touching a Host Agent", async () => {
    const aborts: AbortSignal[] = [];
    const provider: RoomSummaryLlmPort = {
      stream(options) {
        aborts.push(options.signal!);
        return {
          async *[Symbol.asyncIterator]() {
            await new Promise<void>((resolve) => options.signal!.addEventListener("abort", () => resolve(), { once: true }));
            yield { type: "finish", reason: { kind: "aborted", failure: { code: "ABORTED", message: "cancelled" } } };
          },
        };
      },
    };
    const service = new RoomSummaryService(provider, { provider: "deepseek", model: "model" });
    const pending = service.summarize({ context: context() });
    service.cancel("room-1");

    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    expect(aborts[0]?.aborted).toBe(true);
  });

  it("requires an injected public LLM service and the current Host route", () => {
    expect(() => createDshRoomSummaryService({
      agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: "model" }) },
    })).toThrow("LLM service is unavailable");

    const provider = llm([]);
    const service = createDshRoomSummaryService({
      llm: provider,
      agentDefaultModel: { currentSelection: () => ({ provider: "deepseek", model: "model" }) },
    });
    expect(service).toBeInstanceOf(RoomSummaryService);
  });
});
