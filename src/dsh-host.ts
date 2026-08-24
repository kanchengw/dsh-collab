import { CollabError } from "./errors.js";
import { registerCollabRoutes, type CollabWebServer } from "./webserver.js";
import type { CollabHttpOptions } from "./http.js";
import type { AgentDelivery, AgentDeliveryResult, HostAgentPort } from "./types.js";
import type { CollabStreamUpgrade } from "./upgrade.js";

export interface DshSessionService {
  owns(sessionId: string): boolean | Promise<boolean>;
  followup(input: { sessionId: string; requestId: string; text: string; contextRefs?: string[] }): Promise<void> | void;
  steer(input: { sessionId: string; requestId: string; text: string; contextRefs?: string[] }): Promise<void> | void;
  cancel(input: { sessionId: string; requestId: string; keepInbox: boolean }): Promise<void> | void;
  whenIdle?(input: { sessionId: string; requestId: string }): Promise<AgentDeliveryResult | void>;
}

async function assertOwned(service: DshSessionService, sessionId: string): Promise<void> {
  if (!(await service.owns(sessionId))) throw new CollabError("ACTION_FORBIDDEN", "host session is not owned by this DSH runtime", { sessionId });
}

export function createDshHostAgentPort(input: { sessions: DshSessionService }): HostAgentPort {
  const dispatch = async (mode: "followup" | "steer", delivery: AgentDelivery): Promise<void> => {
    await assertOwned(input.sessions, delivery.hostSessionId);
    await input.sessions[mode]({
      sessionId: delivery.hostSessionId,
      requestId: delivery.requestId,
      text: delivery.text,
      ...(delivery.contextRefs ? { contextRefs: [...delivery.contextRefs] } : {}),
    });
  };
  return {
    followup: (delivery) => dispatch("followup", delivery),
    steer: (delivery) => dispatch("steer", delivery),
    async cancel(request) {
      await assertOwned(input.sessions, request.hostSessionId);
      await input.sessions.cancel({ sessionId: request.hostSessionId, requestId: request.requestId, keepInbox: request.keepInbox });
    },
    async whenIdle(request) {
      await assertOwned(input.sessions, request.hostSessionId);
      return await input.sessions.whenIdle?.({ sessionId: request.hostSessionId, requestId: request.requestId });
    },
  };
}

export function registerDshCollabHost(options: {
  webServer: CollabWebServer;
  http: Omit<CollabHttpOptions, "host" | "port"> & Partial<Pick<CollabHttpOptions, "host" | "port">>;
  upgrade: CollabStreamUpgrade;
}): () => void {
  return registerCollabRoutes(options);
}
