import { CollabError, invalidInput } from "./errors.js";
import type {
  AppendEventInput,
  LedgerSnapshot,
  RoomEvent,
  RoomEventType,
} from "./types.js";

const MAX_READ_LIMIT = 500;

function copy<T>(value: T): T {
  return structuredClone(value);
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput(field + " must not be blank", { field });
  }
  return value.trim();
}

function comparableEvent(input: AppendEventInput): string {
  return JSON.stringify({
    roomId: input.roomId,
    type: input.type,
    actor: input.actor,
    createdAt: input.createdAt,
    payload: input.payload,
  });
}

export class EventLedger {
  private readonly rooms = new Map<string, RoomEvent[]>();
  private readonly eventsById = new Map<string, RoomEvent>();
  private readonly listeners = new Set<(event: RoomEvent) => void>();
  private readonly committedListeners = new Set<(event: RoomEvent) => void>();
  private readonly committedSeq = new Map<string, number>();
  private commitQueue: Promise<void> = Promise.resolve();
  private durabilityPending = false;
  private retryPersistence: (() => Promise<void>) | undefined;

  subscribe(listener: (event: RoomEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeCommitted(listener: (event: RoomEvent) => void): () => void {
    this.committedListeners.add(listener);
    return () => this.committedListeners.delete(listener);
  }

  append(input: AppendEventInput): RoomEvent {
    const eventId = requiredText(input.eventId, "eventId");
    const roomId = requiredText(input.roomId, "roomId");
    const actorMemberId = requiredText(input.actor.memberId, "actor.memberId");
    const actorPrincipalId = requiredText(input.actor.principalId, "actor.principalId");
    if (!isRoomEventType(input.type)) throw invalidInput("event type is not supported", { field: "type", type: input.type });

    const existing = this.eventsById.get(eventId);
    if (existing) {
      if (comparableEvent({ ...input, createdAt: input.createdAt ?? existing.createdAt }) === JSON.stringify({
        roomId: existing.roomId,
        type: existing.type,
        actor: existing.actor,
        createdAt: existing.createdAt,
        payload: existing.payload,
      })) {
        return copy(existing);
      }
      throw new CollabError("EVENT_CONFLICT", "event " + eventId + " conflicts with an existing event", { eventId });
    }

    const events = this.rooms.get(roomId) ?? [];
    const event: RoomEvent = {
      eventId,
      roomId,
      seq: events.length + 1,
      type: input.type,
      actor: { memberId: actorMemberId, principalId: actorPrincipalId },
      createdAt: input.createdAt ?? Date.now(),
      payload: copy(input.payload),
    };
    events.push(event);
    this.rooms.set(roomId, events);
    this.eventsById.set(eventId, event);
    for (const listener of this.listeners) {
      try {
        listener(copy(event));
      } catch {
        // A stream subscriber must not make a committed ledger append fail.
      }
    }
    return copy(event);
  }

  commit(persist?: () => Promise<void>): Promise<void> {
    if (persist) this.retryPersistence = persist;
    this.durabilityPending = true;
    const watermark = new Map([...this.rooms].map(([roomId, events]) => [roomId, events.length]));
    const result = this.commitQueue.then(async () => {
      try {
        await persist?.();
        for (const [roomId, throughSeq] of watermark) this.publishCommittedThrough(roomId, throughSeq);
        this.durabilityPending = false;
      } catch (error) {
        this.durabilityPending = true;
        throw error;
      }
    });
    this.commitQueue = result.catch(() => undefined);
    return result;
  }

  async awaitDurable(): Promise<void> {
    while (true) {
      const pending = this.commitQueue;
      await pending;
      if (pending !== this.commitQueue) continue;
      if (!this.durabilityPending) return;
      await this.commit(this.retryPersistence);
    }
  }

  readAfter(roomId: string, afterSeq: number, limit = 100): RoomEvent[] {
    const normalizedRoomId = requiredText(roomId, "roomId");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw invalidInput("afterSeq must be a non-negative integer", { afterSeq });
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw invalidInput("limit must be a positive integer", { limit });
    }
    const boundedLimit = Math.min(limit, MAX_READ_LIMIT);
    return copy((this.rooms.get(normalizedRoomId) ?? []).slice(afterSeq, afterSeq + boundedLimit));
  }

  readCommittedAfter(roomId: string, afterSeq: number, limit = 100): RoomEvent[] {
    const normalizedRoomId = requiredText(roomId, "roomId");
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw invalidInput("afterSeq must be a non-negative integer", { afterSeq });
    }
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw invalidInput("limit must be a positive integer", { limit });
    }
    const boundedLimit = Math.min(limit, MAX_READ_LIMIT);
    const committed = this.committedSeq.get(normalizedRoomId) ?? 0;
    return copy((this.rooms.get(normalizedRoomId) ?? []).slice(afterSeq, Math.min(afterSeq + boundedLimit, committed)));
  }

  latestSeq(roomId: string): number {
    const normalizedRoomId = requiredText(roomId, "roomId");
    return this.rooms.get(normalizedRoomId)?.length ?? 0;
  }

  latestCommittedSeq(roomId: string): number {
    const normalizedRoomId = requiredText(roomId, "roomId");
    return this.committedSeq.get(normalizedRoomId) ?? 0;
  }

  discardRoom(roomId: string): void {
    const normalizedRoomId = requiredText(roomId, "roomId");
    if ((this.committedSeq.get(normalizedRoomId) ?? 0) !== 0) {
      throw new CollabError("REQUEST_CONFLICT", "Committed Room events cannot be discarded", { roomId: normalizedRoomId });
    }
    for (const event of this.rooms.get(normalizedRoomId) ?? []) this.eventsById.delete(event.eventId);
    this.rooms.delete(normalizedRoomId);
    this.committedSeq.delete(normalizedRoomId);
  }

  snapshot(): LedgerSnapshot {
    return {
      version: 1,
      rooms: [...this.rooms.entries()].map(([roomId, events]) => ({ roomId, events: copy(events) })),
    };
  }

  static fromSnapshot(snapshot: LedgerSnapshot): EventLedger {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.rooms)) {
      throw invalidInput("unsupported event ledger snapshot");
    }
    const ledger = new EventLedger();
    for (const room of snapshot.rooms) {
      if (!room || typeof room.roomId !== "string" || !Array.isArray(room.events)) {
        throw invalidInput("invalid event ledger room snapshot");
      }
      let expectedSeq = 1;
      for (const event of room.events) {
        if (event.roomId !== room.roomId || event.seq !== expectedSeq) {
          throw invalidInput("event ledger sequence is not contiguous", { roomId: room.roomId });
        }
        const restored = ledger.append({
          eventId: event.eventId,
          roomId: event.roomId,
          type: event.type,
          actor: event.actor,
          createdAt: event.createdAt,
          payload: event.payload,
        });
        if (restored.seq !== event.seq) {
          throw invalidInput("event ledger restore sequence mismatch", { roomId: room.roomId });
        }
        expectedSeq += 1;
      }
      ledger.committedSeq.set(room.roomId, room.events.length);
    }
    return ledger;
  }

  private publishCommittedThrough(roomId: string, throughSeq: number): void {
    const previous = this.committedSeq.get(roomId) ?? 0;
    if (throughSeq <= previous) return;
    const events = this.rooms.get(roomId) ?? [];
    if (throughSeq > events.length) throw new Error("Event Ledger commit watermark exceeds the room sequence");
    this.committedSeq.set(roomId, throughSeq);
    for (const event of events.slice(previous, throughSeq)) {
      for (const listener of this.committedListeners) {
        try {
          listener(copy(event));
        } catch {
          // A committed-event subscriber cannot roll back durable room state.
        }
      }
    }
  }
}

export function isRoomEventType(value: string): value is RoomEventType {
  return value === "room.created"
    || value === "member.joined"
    || value === "member.roleChanged"
    || value === "member.suspended"
    || value === "member.removed"
    || value === "human.message"
    || value === "work-update.published"
    || value === "workspace-version.published"
    || value === "workspace-sharing.changed"
    || value === "changeset.submitted"
    || value === "changeset.review-assigned"
    || value === "changeset.finding-created"
    || value === "changeset.review-decided"
    || value === "changeset.revision-linked"
    || value === "changeset.applied"
    || value === "changeset.apply-conflicted"
    || value === "agent.request.created"
    || value === "agent.request.queued"
    || value === "agent.request.claimed"
    || value === "agent.request.rejected"
    || value === "agent.request.edited"
    || value === "agent.request.withdrawn"
    || value === "agent.request.failed"
    || value === "agent.request.cancelled"
    || value === "agent.request.completed"
    || value === "agent.state.changed"
    || value === "approval.requested"
    || value === "approval.decided";
}
