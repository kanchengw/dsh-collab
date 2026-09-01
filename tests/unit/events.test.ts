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

  it("rejects reusing an event id with a different timestamp", () => {
    const ledger = new EventLedger();
    ledger.append({
      eventId: "event-1",
      roomId: "room-1",
      type: "human.message",
      actor,
      createdAt: 1,
      payload: { text: "same payload" },
    });

    try {
      ledger.append({
        eventId: "event-1",
        roomId: "room-1",
        type: "human.message",
        actor,
        createdAt: 2,
        payload: { text: "same payload" },
      });
      throw new Error("expected timestamp reuse to fail");
    } catch (error) {
      expect(error).toMatchObject({ code: "EVENT_CONFLICT" });
    }
  });

  it("publishes only events covered by a successful persistence watermark", async () => {
    const ledger = new EventLedger();
    const committed: string[] = [];
    ledger.subscribeCommitted((event) => committed.push(event.eventId));
    ledger.append({
      eventId: "event-1",
      roomId: "room-1",
      type: "human.message",
      actor,
      payload: { text: "first" },
    });
    let release!: () => void;
    const persistence = new Promise<void>((resolve) => { release = resolve; });
    const committing = ledger.commit(async () => await persistence);
    ledger.append({
      eventId: "event-2",
      roomId: "room-1",
      type: "human.message",
      actor,
      payload: { text: "second" },
    });

    release();
    await committing;

    expect(committed).toEqual(["event-1"]);
    expect(ledger.readCommittedAfter("room-1", 0).map((event) => event.eventId)).toEqual(["event-1"]);
    await ledger.commit();
    expect(committed).toEqual(["event-1", "event-2"]);
  });

  it("keeps failed persistence events hidden until a later barrier succeeds", async () => {
    const ledger = new EventLedger();
    const committed: string[] = [];
    ledger.subscribeCommitted((event) => committed.push(event.eventId));
    ledger.append({
      eventId: "event-1",
      roomId: "room-1",
      type: "human.message",
      actor,
      payload: { text: "retry" },
    });

    await expect(ledger.commit(async () => { throw new Error("disk failed"); })).rejects.toThrow("disk failed");
    expect(committed).toEqual([]);
    expect(ledger.readCommittedAfter("room-1", 0)).toEqual([]);

    await ledger.commit();
    expect(committed).toEqual(["event-1"]);
  });

  it("serializes concurrent persistence writes and publishes their watermarks in order", async () => {
    const ledger = new EventLedger();
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    ledger.append({
      eventId: "event-1",
      roomId: "room-1",
      type: "human.message",
      actor,
      payload: { text: "first" },
    });
    const first = ledger.commit(async () => {
      writes.push("first");
      await firstWrite;
    });
    ledger.append({
      eventId: "event-2",
      roomId: "room-1",
      type: "human.message",
      actor,
      payload: { text: "second" },
    });
    let secondSettled = false;
    const second = ledger.commit(async () => { writes.push("second"); }).then(() => { secondSettled = true; });

    await Promise.resolve();
    expect(writes).toEqual(["first"]);
    expect(secondSettled).toBe(false);
    expect(ledger.latestCommittedSeq("room-1")).toBe(0);
    releaseFirst();
    await Promise.all([first, second]);

    expect(ledger.latestCommittedSeq("room-1")).toBe(2);
    expect(writes).toEqual(["first", "second"]);
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
