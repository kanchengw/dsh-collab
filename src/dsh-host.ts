import { CollabError } from "./errors.js";
import type { AgentDelivery, AgentDeliveryResult, AgentOutputFrame, HostAgentPort } from "./types.js";

export interface DshSessionService {
  owns(sessionId: string): boolean | Promise<boolean>;
  workspacePath?(sessionId: string): string | undefined;
  followup(input: { sessionId: string; roomId?: string; requestId: string; text: string; contextRefs?: string[]; contextContent?: string[] }): Promise<void> | void;
  steer(input: { sessionId: string; roomId?: string; requestId: string; text: string; contextRefs?: string[]; contextContent?: string[] }): Promise<void> | void;
  cancel(input: { sessionId: string; requestId: string; keepInbox: boolean }): Promise<void> | void;
  whenIdle?(input: { sessionId: string; requestId: string }): Promise<AgentDeliveryResult | void>;
  onAgentOutput?(listener: (frame: AgentOutputFrame) => void): () => void;
  dispose?(): void;
}

async function assertOwned(service: DshSessionService, sessionId: string): Promise<void> {
  if (!(await service.owns(sessionId))) throw new CollabError("ACTION_FORBIDDEN", "host session is not owned by this DSH runtime", { sessionId });
}

export function createDshHostAgentPort(input: { sessions: DshSessionService }): HostAgentPort {
  const dispatch = async (mode: "followup" | "steer", delivery: AgentDelivery): Promise<void> => {
    await assertOwned(input.sessions, delivery.hostSessionId);
    await input.sessions[mode]({
      sessionId: delivery.hostSessionId,
      roomId: delivery.roomId,
      requestId: delivery.requestId,
      text: delivery.text,
      ...(delivery.contextRefs ? { contextRefs: [...delivery.contextRefs] } : {}),
      ...(delivery.contextContent ? { contextContent: [...delivery.contextContent] } : {}),
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
