import type { AgentDeliveryResult } from "./types.js";

export interface DshRequestSessionEvent {
  seq: number;
  type: string;
  data: unknown;
}

type RequestState = "missing" | "pending" | "claimed" | "started" | "terminal";

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function safeErrorCode(reason: Record<string, unknown>): string | undefined {
  const code = record(reason.error)?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : undefined;
}

/** Projects one request through DSH's durable inbox and turn events. */
export class DshRequestEventTracker {
  private readonly inbox: Record<"next-step" | "next-turn", string[]> = {
    "next-step": [],
    "next-turn": [],
  };
  private state: RequestState = "missing";
  private messageStarted = false;
  private terminalReason: Record<string, unknown> | undefined;
  private readonly output: string[] = [];

  constructor(readonly messageId: string) {}

  get started(): boolean {
    return this.messageStarted;
  }

  get isTerminal(): boolean {
    return this.state === "terminal";
  }

  get terminalKind(): string | undefined {
    return typeof this.terminalReason?.kind === "string" ? this.terminalReason.kind : undefined;
  }

  apply(event: DshRequestSessionEvent): void {
    if (event.type === "agent/inbox/spliced") {
      this.applyInboxSplice(event.data);
    } else if (event.type === "user/message" && record(event.data)?.id === this.messageId) {
      this.messageStarted = true;
      this.state = "started";
    } else if (event.type === "assistant/message" && this.state === "started") {
      this.appendAssistantText(event.data);
    } else if (event.type === "turn/end" && (this.state === "started" || this.state === "claimed")) {
      this.terminalReason = record(record(event.data)?.reason);
      this.state = "terminal";
    }
  }

  result(label: "Host Agent" | "Local Agent"): AgentDeliveryResult | undefined {
    if (!this.isTerminal) {
      if (this.state === "started") return { error: `${label} request did not reach a terminal turn` };
      if (this.state === "claimed") return { error: `${label} request was claimed but did not execute` };
      if (this.state === "pending") return { error: `${label} request remained pending after becoming idle` };
      return undefined;
    }

    const kind = this.terminalKind;
    if (kind === "canceled" || kind === "aborted") {
      return { error: `${label} request was cancelled${this.started ? "" : " before execution"}` };
    }
    if (kind === "interrupted") return { error: `${label} request was interrupted` };
    if (kind === "blocked") {
      return this.started
        ? { error: `${label} request was blocked` }
        : { error: `${label} request was blocked before execution` };
    }
    if (kind === "error") {
      const code = this.terminalReason ? safeErrorCode(this.terminalReason) : undefined;
      return { error: code ? `${label} failed: ${code}` : `${label} request failed` };
    }
    if (!this.started) return { error: `${label} request completed without execution` };
    return this.output.length === 0 ? undefined : { text: this.output.join("\n\n") };
  }

  private applyInboxSplice(value: unknown): void {
    const data = record(value);
    const target = data?.target;
    const start = data?.start;
    const removedCount = data?.removedCount ?? 0;
    const inserted = data?.inserted;
    if ((target !== "next-step" && target !== "next-turn")
      || !Number.isSafeInteger(start) || (start as number) < 0
      || !Number.isSafeInteger(removedCount) || (removedCount as number) < 0
      || !Array.isArray(inserted)) return;

    const list = this.inbox[target];
    const removed = list.splice(start as number, removedCount as number, ...inserted.map((message) => String(record(message)?.id ?? "")));
    if (inserted.some((message) => record(message)?.id === this.messageId)) this.state = "pending";
    if (!removed.includes(this.messageId)) return;
    if (data?.outcome === "canceled") {
      this.terminalReason = { kind: "canceled" };
      this.state = "terminal";
    } else if (this.state === "pending" && inserted.length === 0) {
      this.state = "claimed";
    }
  }

  private appendAssistantText(value: unknown): void {
    const content = record(record(value)?.message)?.content;
    if (!Array.isArray(content)) return;
    for (const block of content) {
      const candidate = record(block);
      if (candidate?.type === "text" && typeof candidate.text === "string" && candidate.text !== "") {
        this.output.push(candidate.text);
      }
    }
  }
}

export function replayDshRequestEvents(
  tracker: DshRequestEventTracker,
  events: readonly DshRequestSessionEvent[],
  from = 0,
  to = events.length,
): void {
  for (const event of events.slice(from, to)) tracker.apply(event);
}
