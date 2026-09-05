import { createHash } from "node:crypto";
import type { Agent } from "@deepseek-ai/dsh-agent";
import { CollabError, invalidInput } from "./errors.js";

export type DshNativeAgentContextMessage = Parameters<Agent["inject"]>[0];

export interface DshNativeAgentSessionEvent {
  seq: number;
  type: string;
  data: unknown;
}

export interface DshNativeAgentContextAgent {
  readonly id: string;
  readonly session: {
    /** DSH 0.1.2 exposes the durable event log through this method. */
    readonly snapshotEvents?: () => readonly DshNativeAgentSessionEvent[];
    /** Test-only legacy shape retained for narrow fakes. */
    readonly events?: readonly DshNativeAgentSessionEvent[];
    /** Fork-inherited prefix length moved from the header into Session state. */
    readonly inheritedEventCount?: number;
    /** Legacy test seam; real DSH no longer stores seedLength in the header. */
    readonly header?: unknown;
  };
  inject(message: DshNativeAgentContextMessage): void;
  readonly inbox?: {
    remove(messageId: DshNativeAgentContextMessage["id"]): boolean;
  };
}

export interface DshNativeAgentContextRegistry {
  get(sessionId: string): DshNativeAgentContextAgent | undefined;
}

export type DshNativeAgentSessionEventListener = (
  session: { id: string },
  event: DshNativeAgentSessionEvent,
) => void;

export type DshNativeAgentContextState = "missing" | "pending" | "claimed";
export type DshNativeAgentContextObservation = DshNativeAgentContextState | "answered";

export interface DshNativeAgentContextAcknowledgement {
  deliveryId: string;
  messageId: string;
  sessionEventSeq: number;
}

export interface DshNativeAgentContextBinding {
  readonly sessionId: string;
  isSafeToInject(): boolean;
  deliver(input: { deliveryId: string; text: string }): {
    deliveryId: string;
    messageId: string;
    state: "injected" | "pending" | "claimed";
  };
  cancel(deliveryId: string): boolean;
  inspect(deliveryId: string): DshNativeAgentContextState;
  onClaimed(listener: (acknowledgement: DshNativeAgentContextAcknowledgement) => void): () => void;
  dispose(): void;
}

type InboxTarget = "next-step" | "next-turn";
const CONTEXT_MESSAGE_PREFIX = "dsh-collab-context-";

interface InboxSplice {
  target: InboxTarget;
  start: number;
  removedCount: number;
  inserted: DshNativeAgentContextMessage[];
  outcome?: "canceled";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function inboxSplice(event: DshNativeAgentSessionEvent): InboxSplice | undefined {
  if (event.type !== "agent/inbox/spliced") return undefined;
  const data = record(event.data);
  const target = data?.target;
  const start = data?.start;
  const removedCount = data?.removedCount ?? 0;
  const inserted = data?.inserted;
  const outcome = data?.outcome;
  if ((target !== "next-step" && target !== "next-turn")
    || !Number.isSafeInteger(start) || (start as number) < 0
    || !Number.isSafeInteger(removedCount) || (removedCount as number) < 0
    || !Array.isArray(inserted)
    || (outcome !== undefined && outcome !== "canceled")) {
    throw new Error(`Invalid DSH inbox splice at session seq ${event.seq}`);
  }
  return {
    target,
    start: start as number,
    removedCount: removedCount as number,
    inserted: inserted as DshNativeAgentContextMessage[],
    ...(outcome === undefined ? {} : { outcome }),
  };
}

class DurableInboxProjection {
  private readonly lists: Record<InboxTarget, string[]> = { "next-step": [], "next-turn": [] };
  private readonly states = new Map<string, DshNativeAgentContextState>();

  constructor(events: readonly DshNativeAgentSessionEvent[], seedLength: number) {
    for (const event of events.slice(seedLength)) this.apply(event);
  }

  state(messageId: string): DshNativeAgentContextState {
    return this.states.get(messageId) ?? "missing";
  }

  apply(event: DshNativeAgentSessionEvent): string[] {
    const splice = inboxSplice(event);
    if (!splice) return [];
    const list = this.lists[splice.target];
    if (splice.start + splice.removedCount > list.length) {
      throw new Error(`Invalid DSH inbox splice at session seq ${event.seq}`);
    }
    const insertedIds = splice.inserted.map((message) => message.id);
    const removedIds = list.splice(splice.start, splice.removedCount, ...insertedIds);
    const isClaim = splice.target === "next-step" && splice.outcome === undefined && splice.inserted.length === 0;
    const claimed = isClaim ? removedIds.filter((messageId) => messageId.startsWith(CONTEXT_MESSAGE_PREFIX)) : [];
    for (const messageId of removedIds) {
      if (messageId.startsWith(CONTEXT_MESSAGE_PREFIX)) this.states.set(messageId, isClaim ? "claimed" : "missing");
    }
    for (const messageId of insertedIds) {
      if (messageId.startsWith(CONTEXT_MESSAGE_PREFIX)) this.states.set(messageId, "pending");
    }
    return claimed;
  }
}

function deliveryMessageId(sessionId: string, deliveryId: string): string {
  const digest = createHash("sha256").update(`${sessionId}\0${deliveryId}`, "utf8").digest("hex");
  return `${CONTEXT_MESSAGE_PREFIX}${digest}`;
}

function contextMessage(messageId: string, text: string): DshNativeAgentContextMessage {
  return {
    id: messageId as DshNativeAgentContextMessage["id"],
    role: "user",
    content: [{ type: "text", text }],
    source: { kind: "plugin", plugin: "dsh-collab" },
  };
}

function sessionEvents(agent: DshNativeAgentContextAgent): readonly DshNativeAgentSessionEvent[] {
  return agent.session.snapshotEvents?.() ?? agent.session.events ?? [];
}

function legacySeedLength(header: unknown): number {
  if (header === null || typeof header !== "object") return 0;
  const value = (header as { readonly seedLength?: unknown }).seedLength;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Bind room-context delivery to one exact live DSH Agent without waking it. */
export function bindDshNativeAgentContext(input: {
  agents: DshNativeAgentContextRegistry;
  isSafeToInject: () => boolean;
  onSessionEvent(listener: DshNativeAgentSessionEventListener): () => void;
  sessionId: string;
}): DshNativeAgentContextBinding {
  const agent = input.agents.get(input.sessionId);
  if (!agent) {
    throw new CollabError("ACTION_FORBIDDEN", "Linked DSH Agent is not live", { sessionId: input.sessionId });
  }
  const projection = new DurableInboxProjection(
    sessionEvents(agent),
    agent.session.inheritedEventCount ?? legacySeedLength(agent.session.header),
  );
  const deliveryByMessageId = new Map<string, string>();
  const claimedListeners = new Set<(acknowledgement: DshNativeAgentContextAcknowledgement) => void>();
  let disposed = false;

  const assertLive = (): void => {
    if (disposed) throw new Error("DSH native Agent context binding is disposed");
    if (input.agents.get(input.sessionId) !== agent) {
      throw new CollabError("ACTION_FORBIDDEN", "Linked DSH Agent is no longer live", { sessionId: input.sessionId });
    }
  };
  const identify = (deliveryId: string): string => {
    if (deliveryId.trim() === "") throw invalidInput("deliveryId is required");
    const messageId = deliveryMessageId(input.sessionId, deliveryId);
    deliveryByMessageId.set(messageId, deliveryId);
    return messageId;
  };
  const removeSessionEvents = input.onSessionEvent((session, event) => {
    if (disposed || session.id !== input.sessionId || input.agents.get(input.sessionId) !== agent) return;
    for (const messageId of projection.apply(event)) {
      const deliveryId = deliveryByMessageId.get(messageId);
      if (!deliveryId) continue;
      const acknowledgement = { deliveryId, messageId, sessionEventSeq: event.seq };
      for (const listener of claimedListeners) listener(acknowledgement);
    }
  });

  return {
    sessionId: input.sessionId,
    isSafeToInject() {
      assertLive();
      return input.isSafeToInject();
    },
    deliver({ deliveryId, text }) {
      assertLive();
      if (text === "") throw invalidInput("context text is required");
      const messageId = identify(deliveryId);
      const state = projection.state(messageId);
      if (state !== "missing") return { deliveryId, messageId, state };
      if (!input.isSafeToInject()) {
        throw new CollabError("REQUEST_CONFLICT", "DSH Agent is not at a safe context delivery boundary", {
          sessionId: input.sessionId,
        });
      }
      agent.inject(contextMessage(messageId, text));
      return { deliveryId, messageId, state: "injected" };
    },
    cancel(deliveryId) {
      assertLive();
      const messageId = identify(deliveryId);
      if (projection.state(messageId) !== "pending") return false;
      return agent.inbox?.remove(messageId as DshNativeAgentContextMessage["id"]) ?? false;
    },
    inspect(deliveryId) {
      assertLive();
      return projection.state(identify(deliveryId));
    },
    onClaimed(listener) {
      assertLive();
      claimedListeners.add(listener);
      return () => { claimedListeners.delete(listener); };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      removeSessionEvents();
      claimedListeners.clear();
      deliveryByMessageId.clear();
    },
  };
}
