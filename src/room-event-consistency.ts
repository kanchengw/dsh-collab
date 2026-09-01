import { isDeepStrictEqual } from "node:util";
import { CollabError } from "./errors.js";
import type { EventLedger } from "./events.js";
import type { RoomEvent, RoomEventType } from "./types.js";

export type ExpectedRoomEvent = Omit<RoomEvent, "seq">;

export function assertRoomEventConsistency(
  ledger: EventLedger,
  managedTypes: ReadonlySet<RoomEventType>,
  expectedEvents: readonly ExpectedRoomEvent[],
): void {
  const actualEvents = ledger.snapshot().rooms
    .flatMap((room) => room.events)
    .filter((event) => managedTypes.has(event.type));
  const expectedById = new Map(expectedEvents.map((event) => [event.eventId, event]));
  if (expectedById.size !== expectedEvents.length || actualEvents.length !== expectedEvents.length) {
    throw new CollabError("SNAPSHOT_INVALID", "Room Event Ledger does not match its collaboration state");
  }
  for (const actual of actualEvents) {
    const expected = expectedById.get(actual.eventId);
    if (!expected || !isDeepStrictEqual({
      eventId: actual.eventId,
      roomId: actual.roomId,
      type: actual.type,
      actor: actual.actor,
      createdAt: actual.createdAt,
      payload: actual.payload,
    }, expected)) {
      throw new CollabError("SNAPSHOT_INVALID", "Room Event Ledger does not match its collaboration state");
    }
  }
}
