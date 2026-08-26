import { describe, expect, it } from "vitest";
import { CollabError } from "../../src/errors.js";
import { EventLedger } from "../../src/events.js";

const actor = { memberId: "member-alice", principalId: "alice" };

describe("EventLedger", () => {
  it("assigns exclusive room sequence numbers", () => {
    const ledger = new EventLedger();

    const first = ledger.append({
      eventId: "event-1",
      roomId: "room-1",
      type: "human.message",
      actor,
      payload: { text: "hello" },
    });
    const second = ledger.append({
      eventId: "event-2",
      roomId: "room-1",
      type: "human.message",
      actor,
      payload: { text: "world" },
    });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(ledger.readAfter("room-1", 0)).toHaveLength(2);
    expect(ledger.readAfter("room-1", 1)).toEqual([second]);
  });

  it("returns the original event for an idempotent retry", () => {
    const ledger = new EventLedger();
    const input = {
      eventId: "event-1",
      roomId: "room-1",
      type: "human.message" as const,
      actor,
      payload: { text: "retry me" },
    };

    const first = ledger.append(input);
    const retry = ledger.append(input);

    expect(retry).toEqual(first);
    expect(ledger.readAfter("room-1", 0)).toHaveLength(1);
  });

  it("rejects reusing an event id for different data", () => {
    const ledger = new EventLedger();
    ledger.append({
      eventId: "event-1",
      roomId: "room-1",
      type: "human.message",
      actor,
      payload: { text: "original" },
    });

    expect(() => ledger.append({
      eventId: "event-1",
      roomId: "room-1",
      type: "human.message",
      actor,
      payload: { text: "tampered" },
    })).toThrowError(CollabError);
    try {
      ledger.append({
        eventId: "event-1",
        roomId: "room-1",
        type: "human.message",
        actor,
        payload: { text: "tampered" },
      });
    } catch (error) {
      expect(error).toMatchObject({ code: "EVENT_CONFLICT" });
    }
  });

  it("caps reads and survives snapshot restore", () => {
    const ledger = new EventLedger();
    for (let index = 0; index < 510; index += 1) {
      ledger.append({
        eventId: "event-" + index,
        roomId: "room-1",
        type: "human.message",
        actor,
        payload: { index },
      });
    }

    expect(ledger.readAfter("room-1", 0, 999)).toHaveLength(500);
    expect(ledger.latestSeq("room-1")).toBe(510);
    expect(ledger.latestSeq("room-empty")).toBe(0);
    const restored = EventLedger.fromSnapshot(ledger.snapshot());
    expect(restored.readAfter("room-1", 500)).toHaveLength(10);
    expect(restored.readAfter("room-1", 509)[0]?.seq).toBe(510);
  });
});
