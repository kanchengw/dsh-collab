import { randomUUID } from "node:crypto";
import { CollabError } from "./errors.js";
import type { DshSessionService } from "./dsh-host.js";
import type { AgentDeliveryResult } from "./types.js";

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
  session?: { readonly events: readonly DshCordisSessionEvent[] };
}

export interface DshCordisSessionEvent {
  seq: number;
  type: string;
  data: unknown;
}

export interface DshCordisAgentRegistry {
  get(sessionId: string): DshCordisAgent | undefined;
}

function userMessage(text: string): DshUserMessage {
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

function assistantOutput(events: readonly DshCordisSessionEvent[], baseline: number, messageId: string): AgentDeliveryResult | undefined {
  const userIndex = events.findIndex((event, index) => index >= baseline && event.type === "user/message" && record(event.data)?.id === messageId);
  if (userIndex < 0) return undefined;
  const relativeEnd = events.slice(userIndex + 1).findIndex((event) => event.type === "turn/end");
  const endIndex = relativeEnd < 0 ? events.length : userIndex + 1 + relativeEnd;
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
export function createDshCordisSessionService(input: { agents: DshCordisAgentRegistry }): DshSessionService {
  const pending = new Map<string, { agent: DshCordisAgent; baseline: number; messageId: string }>();
  const deliver = async (mode: "followup" | "steer", delivery: { sessionId: string; requestId: string; text: string }): Promise<void> => {
    const agent = liveAgent(input.agents, delivery.sessionId);
    const message = userMessage(delivery.text);
    pending.set(delivery.requestId, { agent, baseline: agent.session?.events.length ?? 0, messageId: message.id });
    try {
      await agent[mode](message);
    } catch (error) {
      pending.delete(delivery.requestId);
      throw error;
    }
  };
  return {
    owns: (sessionId) => input.agents.get(sessionId) !== undefined,
    followup: (delivery) => deliver("followup", delivery),
    steer: (delivery) => deliver("steer", delivery),
    async cancel(request): Promise<void> {
      await liveAgent(input.agents, request.sessionId).cancel({ kind: "user" }, { keepInbox: request.keepInbox });
    },
    async whenIdle(request): Promise<AgentDeliveryResult | undefined> {
      const agent = liveAgent(input.agents, request.sessionId);
      await agent.whenIdle?.();
      const delivery = pending.get(request.requestId);
      pending.delete(request.requestId);
      if (!delivery || delivery.agent !== agent || !agent.session) return undefined;
      return assistantOutput(agent.session.events, delivery.baseline, delivery.messageId);
    },
  };
}
