import { describe, expect, it } from "vitest";
import type { DecisionEvent } from "../../src/collaboration-types.js";
import { DecisionStore, reduceDecisionEvents } from "../../src/decisions.js";

const alice = { memberId: "member-alice", principalId: "alice" };

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    decisionId: "decision-1",
    roomId: "room-1",
    scope: "room",
    conclusion: "Use the event ledger.",
    sourceMessageIds: ["message-1"],
    actor: alice,
    eventId: "event-proposed",
    now: 100,
    ...overrides,
  };
}

describe("DecisionStore", () => {
  it("emits decision events through the host persistence seam", () => {
    const emitted: DecisionEvent[] = [];
    const store = new DecisionStore([], { eventSink: (event) => emitted.push(event) });

    store.propose(proposal());
    store.accept({ decisionId: "decision-1", actor: alice, eventId: "event-accepted", now: 110 });

    expect(emitted).toEqual(store.events("room-1"));
  });

  it("marks one message as a proposed room decision", () => {
    const store = new DecisionStore();
    const decision = store.propose(proposal());

    expect(decision).toMatchObject({
      decisionId: "decision-1",
      roomId: "room-1",
      scope: "room",
      sourceMessageIds: ["message-1"],
      status: "proposed",
      proposedBy: alice.memberId,
      createdAt: 100,
    });
    expect(store.events("room-1").map((event) => event.type)).toEqual(["decision.proposed"]);
  });

  it("supports a multi-message task scope without changing Task state", () => {
    const store = new DecisionStore();
    const decision = store.propose(proposal({
      decisionId: "decision-2",
      scope: "task:task-a,task-b",
      sourceMessageIds: ["message-1", "message-2"],
      conclusion: "Split the work.",
    }));

    expect(decision.scope).toBe("task:task-a,task-b");
    expect(decision.sourceMessageIds).toEqual(["message-1", "message-2"]);
  });

  it("accepts a proposal and preserves superseded history", () => {
    const store = new DecisionStore();
    store.propose(proposal());
    expect(store.accept({ decisionId: "decision-1", actor: alice, eventId: "event-accepted", now: 110 }).status).toBe("accepted");
    const replacement = store.propose(proposal({ decisionId: "decision-2", eventId: "event-proposed-2", now: 120 }));
    const superseded = store.supersede({ decisionId: "decision-1", supersededBy: replacement.decisionId, actor: alice, eventId: "event-superseded", now: 130 });

    expect(superseded).toMatchObject({ status: "superseded", supersededBy: "decision-2", supersededAt: 130 });
    expect(store.list("room-1").map((decision) => [decision.decisionId, decision.status])).toEqual([
      ["decision-1", "superseded"],
      ["decision-2", "proposed"],
    ]);
  });

  it("rejects malformed scopes, empty references, and invalid lifecycle transitions", () => {
    const store = new DecisionStore();
    expect(() => store.propose(proposal({ scope: "task:" }))).toThrow(/scope/i);
    expect(() => store.propose(proposal({ sourceMessageIds: [] }))).toThrow(/message/i);
    store.propose(proposal());
    expect(() => store.supersede({ decisionId: "decision-1", actor: alice, eventId: "event-superseded", now: 110 })).toThrow(/superseded/i);
    store.accept({ decisionId: "decision-1", actor: alice, eventId: "event-accepted", now: 120 });
    expect(store.accept({ decisionId: "decision-1", actor: alice, eventId: "event-accepted-again", now: 130 })).toMatchObject({ status: "accepted", decisionId: "decision-1" });
  });

  it("reduces out-of-order duplicate events deterministically and restores snapshots", () => {
    const store = new DecisionStore();
    store.propose(proposal());
    store.accept({ decisionId: "decision-1", actor: alice, eventId: "event-accepted", now: 110 });
    const snapshot = store.snapshot();
    const restored = DecisionStore.fromSnapshot(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);

    const events = store.events("room-1");
    const reduced = reduceDecisionEvents([events[1]!, events[0]!, events[1]!]);
    expect(reduced.decisions[0]).toMatchObject({ decisionId: "decision-1", status: "accepted" });
    expect(reduced.events.map((event) => event.eventId)).toEqual(["event-proposed", "event-accepted"]);
  });

  it("rejects malformed reducer proposals and invalid superseded references", () => {
    const store = new DecisionStore();
    const first = store.propose(proposal());
    const second = store.propose(proposal({ decisionId: "decision-2", eventId: "event-proposed-2", now: 110 }));
    const events = store.events("room-1");
    expect(() => reduceDecisionEvents([{ ...events[0]!, payload: { ...events[0]!.payload, scope: "task:" } }])).toThrow(/scope/i);
    expect(() => reduceDecisionEvents([{ ...events[0]!, payload: { ...events[0]!.payload, sourceMessageIds: [] } }])).toThrow(/message/i);
    expect(() => reduceDecisionEvents([
      events[0]!,
      { ...events[1]!, eventId: "event-superseded-missing", seq: 3, type: "decision.superseded", payload: { decisionId: first.decisionId, supersededBy: "missing" } },
    ])).toThrow(/replacement/i);
    expect(() => reduceDecisionEvents([
      events[0]!,
      events[1]!,
      { ...events[1]!, eventId: "event-superseded-self", seq: 3, type: "decision.superseded", payload: { decisionId: second.decisionId, supersededBy: second.decisionId } },
    ])).toThrow(/replacement/i);
  });

  it("rejects decision events from another room", () => {
    const store = new DecisionStore();
    const first = store.propose(proposal());
    const second = store.propose(proposal({ decisionId: "decision-2", eventId: "event-proposed-2", now: 110 }));
    const events = store.events("room-1");
    expect(() => reduceDecisionEvents([events[0]!, { ...events[0]!, eventId: "event-cross-room-proposed", roomId: "room-2", seq: 2, createdAt: 102 }])).toThrow(/room/i);
    expect(() => reduceDecisionEvents([events[0]!, { ...events[0]!, eventId: "event-cross-room-accepted", roomId: "room-2", seq: 2, createdAt: 102, type: "decision.accepted", payload: { decisionId: first.decisionId, acceptedBy: alice.memberId } }])).toThrow(/room/i);
    expect(() => reduceDecisionEvents([
      events[0]!,
      events[1]!,
      { ...events[1]!, eventId: "event-cross-room-superseded", roomId: "room-2", seq: 3, type: "decision.superseded", payload: { decisionId: first.decisionId, supersededBy: second.decisionId } },
    ])).toThrow(/room/i);
  });

  it("accepts protocol-shaped decision events while keeping event types distinct", () => {
    const event: DecisionEvent = {
      eventId: "event-proposed",
      roomId: "room-1",
      seq: 1,
      type: "decision.proposed",
      actor: alice,
      createdAt: 100,
      payload: {
        decisionId: "decision-1",
        scope: "room",
        conclusion: "Use the event ledger.",
        sourceMessageIds: ["message-1"],
        proposedBy: alice.memberId,
      },
    };
    expect(reduceDecisionEvents([event]).decisions[0]?.status).toBe("proposed");
  });
});
