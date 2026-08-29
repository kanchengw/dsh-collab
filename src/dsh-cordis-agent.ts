import { randomUUID } from "node:crypto";
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
  followup(message: DshUserMessage): Promise<void> | void;
  steer(message: DshUserMessage): Promise<void> | void;
  cancel(cause: { kind: "user" }, options: { keepInbox: boolean }): Promise<void> | void;
  whenIdle?(): Promise<void>;
  inject?(message: DshContextMessage): void;
  session?: { readonly events: readonly DshCordisSessionEvent[]; readonly header?: { readonly cwd?: string } };
}

export interface DshContextMessage {
  id: string;
  role: "user";
  content: [{ type: "text"; text: string }];
  source: { kind: "plugin"; plugin: "dsh-collab" };
}

export interface DshCordisSessionEvent {
  seq: number;
  type: string;
  data: unknown;
}

export interface DshCordisAgentRegistry {
  get(sessionId: string): DshCordisAgent | undefined;
}

export type DshCordisSessionEventListener = (session: { id: string }, event: DshCordisSessionEvent) => void;

interface PendingDelivery {
  agent: DshCordisAgent;
  baseline: number;
  messageId: string;
  roomId?: string;
  sessionId: string;
  started: boolean;
  finished: boolean;
  text: string;
  textStep?: string;
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
    source: { kind: "plugin", plugin: "dsh-collab" },
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

function assistantOutput(events: readonly DshCordisSessionEvent[], baseline: number, messageId: string): AgentDeliveryResult | undefined {
  const userIndex = events.findIndex((event, index) => index >= baseline && event.type === "user/message" && record(event.data)?.id === messageId);
  if (userIndex < 0) return undefined;
  const relativeEnd = events.slice(userIndex + 1).findIndex((event) => event.type === "turn/end");
  const endIndex = relativeEnd < 0 ? events.length : userIndex + 1 + relativeEnd;
  const reason = relativeEnd < 0 ? undefined : record(record(events[endIndex]?.data)?.reason);
  if (reason?.kind === "error") {
    const code = record(reason.error)?.code;
    return { error: typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? `Host Agent failed: ${code}` : "Host Agent request failed" };
  }
  const parts: string[] = [];
  for (const event of events.slice(userIndex + 1, endIndex)) {
    if (event.type !== "assistant/message") continue;
    const content = record(record(event.data)?.message)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const candidate = record(block);
      if (candidate?.type === "text" && typeof candidate.text === "string" && candidate.text !== "") parts.push(candidate.text);
    }
  }
  return parts.length === 0 ? undefined : { text: parts.join("\n\n") };
}

/** Adapt the public DSH `ctx.agents` service to the collab HostAgentPort seam. */
export function createDshCordisSessionService(input: {
  agents: DshCordisAgentRegistry;
  onSessionEvent?: (listener: DshCordisSessionEventListener) => () => void;
}): DshSessionService {
  const pending = new Map<string, PendingDelivery>();
  const outputListeners = new Set<(frame: AgentOutputFrame) => void>();
  const unsubscribeSessionEvents = input.onSessionEvent?.((session, event) => {
    for (const [requestId, delivery] of pending) {
      if (delivery.sessionId !== session.id) continue;
      if (event.type === "user/message" && record(event.data)?.id === delivery.messageId) {
        delivery.started = true;
        continue;
      }
      if (delivery.started && event.type === "turn/end") {
        delivery.finished = true;
        continue;
      }
      if (!delivery.started || delivery.finished || event.type !== "assistant/chunk") continue;
      const data = record(event.data);
      const chunk = record(data?.chunk);
      if (chunk?.type !== "text-delta" || typeof chunk.text !== "string" || delivery.roomId === undefined) continue;
      const step = String(data?.turn) + ":" + String(data?.step);
      if (delivery.text !== "" && delivery.textStep !== undefined && delivery.textStep !== step) delivery.text += "\n\n";
      delivery.textStep = step;
      delivery.text += chunk.text;
      const frame: AgentOutputFrame = { kind: "agent-output", roomId: delivery.roomId, requestId, text: delivery.text, streaming: true };
      for (const listener of outputListeners) listener(frame);
    }
  });
  const deliver = async (mode: "followup" | "steer", delivery: { sessionId: string; roomId?: string; requestId: string; text: string; contextContent?: string[] }): Promise<void> => {
    const agent = liveAgent(input.agents, delivery.sessionId);
    for (const content of delivery.contextContent ?? []) agent.inject?.(contextMessage(content));
    const message = userMessage(delivery.text);
    pending.set(delivery.requestId, {
      agent,
      baseline: agent.session?.events.length ?? 0,
      messageId: message.id,
      roomId: delivery.roomId,
      sessionId: delivery.sessionId,
      started: false,
      finished: false,
      text: "",
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
        const agent = liveAgent(input.agents, request.sessionId);
        await agent.whenIdle?.();
        if (!delivery || delivery.agent !== agent || !agent.session) return undefined;
        return assistantOutput(agent.session.events, delivery.baseline, delivery.messageId);
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
      outputListeners.clear();
      pending.clear();
    },
  };
}
