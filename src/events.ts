import { CollabError, invalidInput } from "./errors.js";
import type {
  AppendEventInput,
  LedgerSnapshot,
  RoomEvent,
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

  append(input: AppendEventInput): RoomEvent {
    const eventId = requiredText(input.eventId, "eventId");
    const roomId = requiredText(input.roomId, "roomId");
    const actorMemberId = requiredText(input.actor.memberId, "actor.memberId");
    const actorPrincipalId = requiredText(input.actor.principalId, "actor.principalId");
    if (!input.type) throw invalidInput("event type must not be blank", { field: "type" });

    const existing = this.eventsById.get(eventId);
    if (existing) {
      if (comparableEvent(input) === JSON.stringify({
        roomId: existing.roomId,
        type: existing.type,
        actor: existing.actor,
        createdAt: input.createdAt,
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
    return copy(event);
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
    }
    return ledger;
  }
}
