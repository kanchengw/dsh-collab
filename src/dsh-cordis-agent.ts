import { randomUUID } from "node:crypto";
import type { DshAssistantStreamPayload } from "./dsh-assistant-stream.js";
import { DshRequestEventTracker, replayDshRequestEvents } from "./dsh-request-events.js";
import { CollabError } from "./errors.js";
import type { DshSessionService } from "./dsh-host.js";
import type { AgentDeliveryResult, AgentOutputFrame } from "./types.js";

export interface DshUserMessage {
  id: string;
  role: "user";
  content: [{ type: "text"; text: string }];
  source: { kind: "user" };
}

export interface DshCordisAgent {
  readonly id?: string;
  readonly status?: "idle" | "running";
  followup(message: DshUserMessage): Promise<void> | void;
  steer(message: DshUserMessage): Promise<void> | void;
  cancel(cause: { kind: "user" }, options: { keepInbox: boolean }): Promise<void> | void;
  whenIdle?(): Promise<void>;
  runMaintenance?<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>;
  inject?(message: DshContextMessage): void;
  inbox?: { remove(messageId: string): boolean };
  session?: {
    readonly header?: { readonly cwd?: string };
    /** DSH 0.1.2 exposes the durable event log through this method. */
    readonly snapshotEvents?: () => readonly DshCordisSessionEvent[];
    /** Test-only legacy shape; real DSH sessions use snapshotEvents(). */
    readonly events?: readonly DshCordisSessionEvent[];
  };
}

export interface DshContextMessage {
  id: string;
  role: "user";
  content: [{ type: "text"; text: string }];
  source: { kind: "user" };
}

export interface DshCordisSessionEvent {
  seq: number;
  type: string;
  data: unknown;
}

export interface DshCordisAgentRegistry {
  get(sessionId: string): DshCordisAgent | undefined;
  list?(): readonly DshCordisAgent[];
}

export type DshCordisSessionEventListener = (session: { id: string }, event: DshCordisSessionEvent) => void;

interface PendingDelivery {
  agent: DshCordisAgent;
  baseline: number;
  messageId: string;
  roomId?: string;
  sessionId: string;
  tracker: DshRequestEventTracker;
  committedText: string;
  attempt?: { id: string; text: string };
}

function userMessage(text: string): DshUserMessage {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function contextMessage(text: string): DshContextMessage {
  return {
    id: randomUUID(),
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "user" },
  };
}

function liveAgent(registry: DshCordisAgentRegistry, sessionId: string): DshCordisAgent {
  const agent = registry.get(sessionId);
  if (!agent) throw new CollabError("ACTION_FORBIDDEN", "Host session is not live in ctx.agents", { sessionId });
  return agent;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sessionEvents(agent: DshCordisAgent): readonly DshCordisSessionEvent[] {
  return agent.session?.snapshotEvents?.() ?? agent.session?.events ?? [];
}

/** Adapt the public DSH `ctx.agents` service to the collab HostAgentPort seam. */
export function createDshCordisSessionService(input: {
  agents: DshCordisAgentRegistry;
  onSessionEvent?: (listener: DshCordisSessionEventListener) => () => void;
  onAssistantStream?: (listener: (payload: DshAssistantStreamPayload<object>) => void) => () => void;
}): DshSessionService {
  const pending = new Map<string, PendingDelivery>();
  const outputListeners = new Set<(frame: AgentOutputFrame) => void>();
  const publish = (requestId: string, delivery: PendingDelivery, text: string): void => {
    if (delivery.roomId === undefined) return;
    const frame: AgentOutputFrame = { kind: "agent-output", roomId: delivery.roomId, requestId, text, streaming: true };
    for (const listener of outputListeners) listener(frame);
  };
  const unsubscribeSessionEvents = input.onSessionEvent?.((session, event) => {
    for (const [requestId, delivery] of pending) {
      if (delivery.sessionId !== session.id) continue;
      delivery.tracker.apply(event);
    }
  });
  const unsubscribeAssistantStream = input.onAssistantStream?.(({ agent, frame }) => {
    for (const [requestId, delivery] of pending) {
      if (delivery.agent !== agent || !delivery.tracker.started || delivery.tracker.isTerminal) continue;
      if (frame.type === "start") {
        delivery.attempt = { id: frame.attemptId, text: "" };
        continue;
      }
      if (delivery.attempt?.id !== frame.attemptId) continue;
      if (frame.type === "chunk") {
        if (frame.chunk.type !== "text-delta" || typeof frame.chunk.text !== "string") continue;
        delivery.attempt.text += frame.chunk.text;
        const separator = delivery.committedText !== "" && delivery.attempt.text !== "" ? "\n\n" : "";
        publish(requestId, delivery, delivery.committedText + separator + delivery.attempt.text);
        continue;
      }
      if (frame.outcome.kind === "committed" && frame.outcome.eventType === "assistant/message") {
        if (delivery.attempt.text !== "") {
          delivery.committedText += (delivery.committedText === "" ? "" : "\n\n") + delivery.attempt.text;
        }
      } else if (delivery.attempt.text !== "") {
        publish(requestId, delivery, delivery.committedText);
      }
      delivery.attempt = undefined;
    }
  });
  const deliver = async (mode: "followup" | "steer", delivery: { sessionId: string; roomId?: string; requestId: string; text: string; contextContent?: string[] }): Promise<void> => {
    const agent = liveAgent(input.agents, delivery.sessionId);
    for (const content of delivery.contextContent ?? []) agent.inject?.(contextMessage(content));
    const message = userMessage(delivery.text);
    pending.set(delivery.requestId, {
      agent,
      baseline: sessionEvents(agent).length,
      messageId: message.id,
      roomId: delivery.roomId,
      sessionId: delivery.sessionId,
      tracker: new DshRequestEventTracker(message.id),
      committedText: "",
    });
    try {
      await agent[mode](message);
    } catch (error) {
      pending.delete(delivery.requestId);
      throw error;
    }
  };
  return {
    owns: (sessionId) => input.agents.get(sessionId) !== undefined,
    workspacePath: (sessionId) => input.agents.get(sessionId)?.session?.header?.cwd,
    followup: (delivery) => deliver("followup", delivery),
    steer: (delivery) => deliver("steer", delivery),
    async cancel(request): Promise<void> {
      await liveAgent(input.agents, request.sessionId).cancel({ kind: "user" }, { keepInbox: request.keepInbox });
    },
    async whenIdle(request): Promise<AgentDeliveryResult | undefined> {
      const delivery = pending.get(request.requestId);
      try {
        const agent = input.agents.get(request.sessionId);
        if (!agent) return { error: "Host Agent changed before request completion" };
        await agent.whenIdle?.();
        if (!delivery) return undefined;
        if (delivery.agent !== agent) return { error: "Host Agent changed before request completion" };
        if (!agent.session) return { error: "Host Agent session is unavailable" };
        replayDshRequestEvents(delivery.tracker, sessionEvents(agent), delivery.baseline);
        return delivery.tracker.result("Host Agent");
      } finally {
        pending.delete(request.requestId);
      }
    },
    onAgentOutput(listener): () => void {
      outputListeners.add(listener);
      return () => { outputListeners.delete(listener); };
    },
    dispose(): void {
      unsubscribeSessionEvents?.();
      unsubscribeAssistantStream?.();
      outputListeners.clear();
      pending.clear();
    },
  };
}
