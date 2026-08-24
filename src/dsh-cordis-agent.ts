import { randomUUID } from "node:crypto";
import { CollabError } from "./errors.js";
import type { DshSessionService } from "./dsh-host.js";

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

/** Adapt the public DSH `ctx.agents` service to the collab HostAgentPort seam. */
export function createDshCordisSessionService(input: { agents: DshCordisAgentRegistry }): DshSessionService {
  return {
    owns: (sessionId) => input.agents.get(sessionId) !== undefined,
    async followup(delivery): Promise<void> {
      await liveAgent(input.agents, delivery.sessionId).followup(userMessage(delivery.text));
    },
    async steer(delivery): Promise<void> {
      await liveAgent(input.agents, delivery.sessionId).steer(userMessage(delivery.text));
    },
    async cancel(request): Promise<void> {
      await liveAgent(input.agents, request.sessionId).cancel({ kind: "user" }, { keepInbox: request.keepInbox });
    },
    async whenIdle(request): Promise<void> {
      await liveAgent(input.agents, request.sessionId).whenIdle?.();
    },
  };
}
