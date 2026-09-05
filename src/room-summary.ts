import type { RoomContextState } from "./room-context.js";

export interface RoomSummaryLlmFailure {
  code: string;
  message: string;
}

export type RoomSummaryLlmStreamChunk =
  | { type: "block-start"; index: number; blockType: "text" | "reasoning" | "tool-call" }
  | { type: "text-delta"; index: number; text: string }
  | { type: "reasoning-delta"; index: number; text: string }
  | { type: "tool-call-delta"; index: number; id: string; name?: string; argumentsDelta: string }
  | { type: "block-end"; index: number; block: { type: "text" | "reasoning" | "tool-call"; text?: string } }
  | { type: "usage"; usage: RoomSummaryUsage }
  | { type: "finish"; reason: { kind: "stop" | "tool-calls" | "max-tokens" | "aborted" | "error"; failure?: RoomSummaryLlmFailure } };

export interface RoomSummaryUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
}

export interface RoomSummaryLlmMessage {
  id: string;
  role: "user";
  content: [{ type: "text"; text: string }];
  source: { kind: "plugin"; plugin: "dsh-collab" };
}

export interface RoomSummaryLlmOptions {
  provider: string;
  model: string;
  messages: RoomSummaryLlmMessage[];
  system: string;
  maxTokens: number;
  signal: AbortSignal;
  reasoningEffort?: string;
}

export interface RoomSummaryLlmPort {
  stream(options: RoomSummaryLlmOptions): AsyncIterable<RoomSummaryLlmStreamChunk>;
}

export interface RoomSummaryRoute {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface RoomSummaryResult {
  roomId: string;
  sourceSeq: number;
  text: string;
  route: RoomSummaryRoute;
  disclosure: {
    kind: "room-public-only";
    sourceSeq: number;
  };
  usage?: RoomSummaryUsage;
}

export interface RoomSummaryRequest {
  context: RoomContextState;
}

export interface RoomSummaryServiceOptions {
  timeoutMs?: number;
  maxAttempts?: number;
  maxTokens?: number;
}

export class RoomSummaryError extends Error {
  constructor(
    readonly code: "LLM_UNAVAILABLE" | "INVALID_OUTPUT" | "STALE_RESULT" | "CANCELLED" | "TIMEOUT" | "FAILED",
    message: string,
  ) {
    super(message);
    this.name = "RoomSummaryError";
  }
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

interface PendingRun {
  input: RoomSummaryRequest;
  deferred: Deferred<RoomSummaryResult>;
}

interface ActiveRun {
  input: RoomSummaryRequest;
  controller: AbortController;
  deferred: Deferred<RoomSummaryResult>;
  pending?: PendingRun;
  settled: boolean;
  cancelled: boolean;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new RoomSummaryError("INVALID_OUTPUT", `${field} must not be blank`);
  return value.trim();
}

function validateRequest(input: RoomSummaryRequest): void {
  const context = input.context;
  if (context.version !== 1 || typeof context.roomId !== "string" || context.roomId.trim() === "") {
    throw new RoomSummaryError("FAILED", "Room Context is invalid");
  }
  if (!Number.isSafeInteger(context.appliedThroughSeq) || context.appliedThroughSeq < 0) {
    throw new RoomSummaryError("FAILED", "Room Context revision is invalid");
  }
}

function roomSummaryPrompt(context: RoomContextState): string {
  const projection = {
    roomId: context.roomId,
    appliedThroughSeq: context.appliedThroughSeq,
    currentSummary: context.currentSummary,
    decisions: context.decisions,
    activeWorkUpdates: context.activeWorkUpdates,
    changeSets: context.changeSets,
    currentWorkspaceVersion: context.currentWorkspaceVersion,
  };
  return [
    "Summarize the shared collaboration room context.",
    "Use only the JSON Room Context below. Do not infer session history that is not present here.",
    "Return exactly one JSON object with one string field named summary.",
    JSON.stringify(projection),
  ].join("\n");
}

function parseSummary(text: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RoomSummaryError("INVALID_OUTPUT", "Room summary output is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RoomSummaryError("INVALID_OUTPUT", "Room summary output must be an object");
  }
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || !Object.prototype.hasOwnProperty.call(record, "summary")) {
    throw new RoomSummaryError("INVALID_OUTPUT", "Room summary output has an invalid schema");
  }
  const summary = requiredText(record.summary, "summary");
  if (summary.length > 2_000) throw new RoomSummaryError("INVALID_OUTPUT", "Room summary is too long");
  return summary;
}

async function collectTextOnly(
  stream: AsyncIterable<RoomSummaryLlmStreamChunk>,
  signal: AbortSignal,
): Promise<{ text: string; usage?: RoomSummaryUsage }> {
  const deltas = new Map<number, string>();
  const blocks = new Map<number, { type: "text" | "reasoning" | "tool-call"; text?: string }>();
  let usage: RoomSummaryUsage | undefined;
  let finish: Extract<RoomSummaryLlmStreamChunk, { type: "finish" }>["reason"] | undefined;
  for await (const chunk of stream) {
    if (signal.aborted) throw new RoomSummaryError("CANCELLED", "Room summary was cancelled");
    switch (chunk.type) {
      case "block-start":
        blocks.set(chunk.index, { type: chunk.blockType });
        break;
      case "text-delta":
        deltas.set(chunk.index, `${deltas.get(chunk.index) ?? ""}${chunk.text}`);
        break;
      case "reasoning-delta":
        throw new RoomSummaryError("INVALID_OUTPUT", "Room summary output contains reasoning");
      case "tool-call-delta":
        throw new RoomSummaryError("INVALID_OUTPUT", "Room summary output contains a tool call");
      case "block-end":
        blocks.set(chunk.index, chunk.block);
        if (chunk.block.type !== "text") throw new RoomSummaryError("INVALID_OUTPUT", "Room summary output is not text-only");
        break;
      case "usage":
        usage = chunk.usage;
        break;
      case "finish":
        finish = chunk.reason;
        break;
    }
  }
  if (!finish || finish.kind !== "stop") {
    if (finish?.kind === "aborted") throw new RoomSummaryError("CANCELLED", finish.failure?.message ?? "Room summary was cancelled");
    throw new RoomSummaryError("FAILED", finish?.failure?.message ?? "Room summary model call did not finish successfully");
  }
  const text = [...blocks.entries()]
    .sort(([left], [right]) => left - right)
    .map(([index, block]) => block.text ?? deltas.get(index) ?? "")
    .join("");
  return { text, ...(usage ? { usage } : {}) };
}

async function withAttemptTimeout<T>(
  parentSignal: AbortSignal,
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = (): void => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) abort();
  else parentSignal.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Room summary timed out"));
  }, timeoutMs);
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (timedOut) throw new RoomSummaryError("TIMEOUT", `Room summary exceeded ${timeoutMs}ms`);
    if (parentSignal.aborted) throw new RoomSummaryError("CANCELLED", "Room summary was cancelled");
    throw error;
  } finally {
    clearTimeout(timeout);
    parentSignal.removeEventListener("abort", abort);
  }
}

export class RoomSummaryService {
  private readonly active = new Map<string, ActiveRun>();
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly maxTokens: number;

  constructor(
    private readonly llm: RoomSummaryLlmPort,
    private readonly route: RoomSummaryRoute,
    options: RoomSummaryServiceOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.maxAttempts = options.maxAttempts ?? 2;
    this.maxTokens = options.maxTokens ?? 256;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1) throw new Error("Room summary timeout must be positive");
    if (!Number.isSafeInteger(this.maxAttempts) || this.maxAttempts < 1 || this.maxAttempts > 3) throw new Error("Room summary attempts must be between 1 and 3");
    if (!Number.isSafeInteger(this.maxTokens) || this.maxTokens < 1) throw new Error("Room summary maxTokens must be positive");
    requiredText(this.route.provider, "provider");
    requiredText(this.route.model, "model");
  }

  summarize(input: RoomSummaryRequest): Promise<RoomSummaryResult> {
    validateRequest(input);
    const roomId = input.context.roomId;
    const current = this.active.get(roomId);
    if (!current) return this.start(input).deferred.promise;
    if (input.context.appliedThroughSeq <= current.input.context.appliedThroughSeq) return current.deferred.promise;
    if (!current.pending) current.pending = { input, deferred: deferred<RoomSummaryResult>() };
    else if (input.context.appliedThroughSeq > current.pending.input.context.appliedThroughSeq) {
      current.pending.deferred.reject(new RoomSummaryError("STALE_RESULT", "A newer Room revision superseded this summary"));
      current.pending = { input, deferred: deferred<RoomSummaryResult>() };
    }
    return current.pending.deferred.promise;
  }

  cancel(roomId: string): void {
    const current = this.active.get(roomId);
    if (!current) return;
    current.cancelled = true;
    current.controller.abort(new Error("Room summary cancelled"));
    current.deferred.reject(new RoomSummaryError("CANCELLED", "Room summary was cancelled"));
    current.pending?.deferred.reject(new RoomSummaryError("CANCELLED", "Room summary was cancelled"));
    current.pending = undefined;
  }

  private start(input: RoomSummaryRequest, existing?: ActiveRun): ActiveRun {
    const run: ActiveRun = existing ?? {
      input,
      controller: new AbortController(),
      deferred: deferred<RoomSummaryResult>(),
      settled: false,
      cancelled: false,
    };
    if (existing) run.input = input;
    this.active.set(input.context.roomId, run);
    void this.execute(run).then((result) => this.complete(run, result), (error: unknown) => this.fail(run, error));
    return run;
  }

  private async execute(run: ActiveRun): Promise<RoomSummaryResult> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      try {
        const response = await withAttemptTimeout(run.controller.signal, this.timeoutMs, async (signal) => {
          const options: RoomSummaryLlmOptions = {
            provider: this.route.provider,
            model: this.route.model,
            ...(this.route.reasoningEffort ? { reasoningEffort: this.route.reasoningEffort } : {}),
            messages: [{
              id: `dsh-collab-room-summary-${run.input.context.roomId}-${run.input.context.appliedThroughSeq}`,
              role: "user",
              content: [{ type: "text", text: roomSummaryPrompt(run.input.context) }],
              source: { kind: "plugin", plugin: "dsh-collab" },
            }],
            system: "You are a Room-owned collaboration summary service. Use only the supplied Room Context.",
            maxTokens: this.maxTokens,
            signal,
          };
          return await collectTextOnly(this.llm.stream(options), signal);
        });
        return {
          roomId: run.input.context.roomId,
          sourceSeq: run.input.context.appliedThroughSeq,
          text: parseSummary(response.text),
          route: { ...this.route },
          disclosure: { kind: "room-public-only", sourceSeq: run.input.context.appliedThroughSeq },
          ...(response.usage ? { usage: response.usage } : {}),
        };
      } catch (error) {
        if (error instanceof RoomSummaryError && (error.code === "CANCELLED" || error.code === "TIMEOUT" || error.code === "INVALID_OUTPUT")) throw error;
        lastError = error;
        if (attempt === this.maxAttempts) break;
      }
    }
    throw lastError instanceof RoomSummaryError ? lastError : new RoomSummaryError("FAILED", lastError instanceof Error ? lastError.message : "Room summary failed");
  }

  private complete(run: ActiveRun, result: RoomSummaryResult): void {
    if (run.settled) return;
    run.settled = true;
    if (run.cancelled) return;
    const pending = run.pending;
    if (pending) {
      run.deferred.reject(new RoomSummaryError("STALE_RESULT", "A newer Room revision superseded this summary"));
      this.active.delete(result.roomId);
      this.start(pending.input).deferred.promise.then(pending.deferred.resolve, pending.deferred.reject);
      return;
    }
    this.active.delete(result.roomId);
    run.deferred.resolve(result);
  }

  private fail(run: ActiveRun, error: unknown): void {
    if (run.settled) return;
    run.settled = true;
    if (run.cancelled) return;
    const pending = run.pending;
    if (pending && error instanceof RoomSummaryError && error.code === "STALE_RESULT") {
      run.deferred.reject(error);
      this.active.delete(run.input.context.roomId);
      this.start(pending.input).deferred.promise.then(pending.deferred.resolve, pending.deferred.reject);
      return;
    }
    this.active.delete(run.input.context.roomId);
    run.deferred.reject(error);
    pending?.deferred.reject(error);
  }
}

export function createDshRoomSummaryService(
  context: {
    llm?: RoomSummaryLlmPort;
    agentDefaultModel?: { currentSelection(): RoomSummaryRoute | undefined };
  },
  options?: RoomSummaryServiceOptions,
): RoomSummaryService {
  if (!context.llm) throw new RoomSummaryError("LLM_UNAVAILABLE", "DSH public LLM service is unavailable");
  const route = context.agentDefaultModel?.currentSelection();
  if (!route) throw new RoomSummaryError("LLM_UNAVAILABLE", "Host model selection is unavailable");
  return new RoomSummaryService(context.llm, route, options);
}
