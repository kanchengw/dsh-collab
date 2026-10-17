import { CollabError, invalidInput } from "./errors.js";
import type {
  CollaborationDecision,
  DecisionEvent,
  DecisionEventPayload,
  DecisionEventType,
  DecisionScope,
  TaskMember,
} from "./collaboration-types.js";

export interface ProposeDecisionInput {
  decisionId: string;
  roomId: string;
  scope: string;
  conclusion: string;
  sourceMessageIds: string[];
  actor: TaskMember;
  eventId: string;
  now?: number;
}

export interface DecisionMutationInput {
  decisionId: string;
  actor: TaskMember;
  eventId: string;
  now?: number;
}

export interface DecisionStoreSnapshot {
  version: 1;
  events: DecisionEvent[];
}

interface ReducedDecisions {
  decisions: CollaborationDecision[];
  events: DecisionEvent[];
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(field + " must not be blank", { field });
  return value.trim();
}

function actor(value: TaskMember): TaskMember {
  return { memberId: requiredText(value.memberId, "actor.memberId"), principalId: requiredText(value.principalId, "actor.principalId") };
}

function normalizeMessages(values: string[]): string[] {
  if (!Array.isArray(values) || values.length === 0) throw invalidInput("sourceMessageIds must contain at least one message", { field: "sourceMessageIds" });
  const result = [...new Set(values.map((value) => requiredText(value, "sourceMessageIds")))];
  if (result.length === 0) throw invalidInput("sourceMessageIds must contain at least one message", { field: "sourceMessageIds" });
  return result;
}

function normalizeScope(value: string): DecisionScope {
  const scope = requiredText(value, "scope");
  if (scope === "room") return scope;
  if (!scope.startsWith("task:")) throw invalidInput("scope must be room or task:A,B", { field: "scope" });
  const taskIds = [...new Set(scope.slice("task:".length).split(",").map((taskId) => requiredText(taskId, "scope")))];
  if (taskIds.length === 0) throw invalidInput("scope must include at least one task", { field: "scope" });
  return "task:" + taskIds.join(",") as DecisionScope;
}

function sortEvents(a: DecisionEvent, b: DecisionEvent): number {
  return a.seq - b.seq || a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId);
}

export function reduceDecisionEvents(input: readonly DecisionEvent[]): ReducedDecisions {
  const events = [...input].sort(sortEvents);
  const accepted: DecisionEvent[] = [];
  const seen = new Map<string, DecisionEvent>();
  const decisions = new Map<string, CollaborationDecision>();

  for (const event of events) {
    const previous = seen.get(event.eventId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(event)) throw new CollabError("EVENT_CONFLICT", "decision event conflict");
      continue;
    }
    seen.set(event.eventId, copy(event));
    const payload = event.payload;
    if (event.type === "decision.proposed") {
      const proposed = payload as { decisionId?: string; scope?: string; conclusion?: string; sourceMessageIds?: string[]; proposedBy?: string };
      const decisionId = requiredText(proposed.decisionId ?? "", "payload.decisionId");
      if (decisions.has(decisionId)) continue;
      const decisionScope = normalizeScope(proposed.scope ?? "");
      const conclusion = requiredText(proposed.conclusion ?? "", "payload.conclusion");
      const sourceMessageIds = normalizeMessages(proposed.sourceMessageIds ?? []);
      const proposedBy = requiredText(proposed.proposedBy ?? "", "payload.proposedBy");
      if (proposedBy !== event.actor.memberId) throw invalidInput("decision.proposed authority does not match its durable event", { eventId: event.eventId });
      const decision: CollaborationDecision = {
        decisionId,
        roomId: event.roomId,
        scope: decisionScope,
        conclusion,
        sourceMessageIds,
        proposedBy,
        createdAt: event.createdAt,
        status: "proposed",
      };
      decisions.set(decision.decisionId, decision);
      accepted.push(copy(event));
      continue;
    }
    const eventDecisionId = requiredText((payload as { decisionId?: string }).decisionId ?? "", "payload.decisionId");
    const current = decisions.get(eventDecisionId);
    if (!current) continue;
    if (event.type === "decision.accepted") {
      if (current.status !== "proposed") continue;
      const acceptedPayload = payload as { acceptedBy?: string };
      const acceptedBy = requiredText(acceptedPayload.acceptedBy ?? "", "payload.acceptedBy");
      if (acceptedBy !== event.actor.memberId) throw invalidInput("decision.accepted authority does not match its durable event", { eventId: event.eventId });
      current.status = "accepted";
      current.acceptedBy = acceptedBy;
      current.acceptedAt = event.createdAt;
    } else if (event.type === "decision.superseded") {
      if (current.status === "superseded") continue;
      const superseded = payload as { supersededBy?: string };
      const replacementId = requiredText(superseded.supersededBy ?? "", "payload.supersededBy");
      const replacement = decisions.get(replacementId);
      if (!replacement || replacement.roomId !== current.roomId || replacement.decisionId === current.decisionId) {
        throw invalidInput("decision.superseded replacement is invalid", { eventId: event.eventId });
      }
      current.status = "superseded";
      current.supersededBy = replacementId;
      current.supersededAt = event.createdAt;
    }
    accepted.push(copy(event));
  }
  return { decisions: [...decisions.values()].map(copy), events: accepted.sort(sortEvents).map(copy) };
}

export class DecisionStore {
  private readonly allEvents: DecisionEvent[];

  constructor(events: readonly DecisionEvent[] = []) {
    this.allEvents = events.map(copy);
    reduceDecisionEvents(this.allEvents);
  }

  propose(input: ProposeDecisionInput): CollaborationDecision {
    const decisionId = requiredText(input.decisionId, "decisionId");
    const roomId = requiredText(input.roomId, "roomId");
    const conclusion = requiredText(input.conclusion, "conclusion");
    if (this.get(decisionId, false)) throw new CollabError("EVENT_CONFLICT", "decision already exists");
    const decisionScope = normalizeScope(input.scope);
    const sourceMessageIds = normalizeMessages(input.sourceMessageIds);
    const decisionActor = actor(input.actor);
    this.append({
      eventId: input.eventId,
      roomId,
      type: "decision.proposed",
      actor: decisionActor,
      createdAt: input.now,
      payload: { decisionId, scope: decisionScope, conclusion, sourceMessageIds, proposedBy: decisionActor.memberId },
    });
    return this.get(decisionId);
  }

  markMessage(input: Omit<ProposeDecisionInput, "sourceMessageIds"> & { messageId: string }): CollaborationDecision {
    return this.propose({ ...input, sourceMessageIds: [input.messageId] });
  }

  synthesize(input: Omit<ProposeDecisionInput, "sourceMessageIds"> & { messageIds: string[] }): CollaborationDecision {
    return this.propose({ ...input, sourceMessageIds: input.messageIds });
  }

  accept(input: DecisionMutationInput): CollaborationDecision {
    const decision = this.get(input.decisionId);
    if (decision.status !== "proposed") throw invalidInput("Only proposed decisions can be accepted", { field: "decisionId" });
    const decisionActor = actor(input.actor);
    this.append({ eventId: input.eventId, roomId: decision.roomId, type: "decision.accepted", actor: decisionActor, createdAt: input.now, payload: { decisionId: decision.decisionId, acceptedBy: decisionActor.memberId } });
    return this.get(input.decisionId);
  }

  supersede(input: DecisionMutationInput & { supersededBy?: string }): CollaborationDecision {
    const decision = this.get(input.decisionId);
    if (decision.status === "superseded") throw invalidInput("Decision is already superseded", { field: "decisionId" });
    const replacementId = requiredText(input.supersededBy ?? "", "supersededBy");
    if (replacementId === decision.decisionId) throw invalidInput("A decision cannot supersede itself", { field: "supersededBy" });
    const replacement = this.get(replacementId);
    if (replacement.roomId !== decision.roomId) throw invalidInput("Replacement decision must belong to the same room", { field: "supersededBy" });
    const decisionActor = actor(input.actor);
    this.append({ eventId: input.eventId, roomId: decision.roomId, type: "decision.superseded", actor: decisionActor, createdAt: input.now, payload: { decisionId: decision.decisionId, supersededBy: replacementId } });
    return this.get(input.decisionId);
  }

  get(decisionId: string, required = true): CollaborationDecision {
    const decision = reduceDecisionEvents(this.allEvents).decisions.find((entry) => entry.decisionId === decisionId);
    if (!decision && required) throw new CollabError("INVALID_INPUT", "decision was not found");
    return copy(decision as CollaborationDecision);
  }

  list(roomId?: string): CollaborationDecision[] {
    return reduceDecisionEvents(this.allEvents).decisions.filter((decision) => roomId === undefined || decision.roomId === roomId).map(copy);
  }

  events(roomId?: string): DecisionEvent[] {
    return this.allEvents.filter((event) => roomId === undefined || event.roomId === roomId).sort(sortEvents).map(copy);
  }

  snapshot(): DecisionStoreSnapshot {
    return { version: 1, events: this.events() };
  }

  static fromSnapshot(snapshot: DecisionStoreSnapshot): DecisionStore {
    if (snapshot.version !== 1 || !Array.isArray(snapshot.events)) throw invalidInput("Decision snapshot is invalid", { field: "snapshot" });
    return new DecisionStore(snapshot.events);
  }

  private append(input: { eventId: string; roomId: string; type: DecisionEventType; actor: TaskMember; createdAt?: number; payload: DecisionEventPayload }): void {
    const existing = this.allEvents.find((event) => event.eventId === input.eventId);
    if (existing) {
      if (JSON.stringify(existing.payload) === JSON.stringify(input.payload) && existing.type === input.type && existing.roomId === input.roomId) return;
      throw new CollabError("EVENT_CONFLICT", "decision event conflict");
    }
    const roomEvents = this.allEvents.filter((event) => event.roomId === input.roomId);
    this.allEvents.push({ eventId: requiredText(input.eventId, "eventId"), roomId: input.roomId, seq: roomEvents.length + 1, type: input.type, actor: actor(input.actor), createdAt: input.createdAt ?? Date.now(), payload: copy(input.payload) });
  }
}