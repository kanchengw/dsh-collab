import { describe, expect, it } from "vitest";
import { EventLedger } from "../../src/events.js";
import { decodeServerStreamFrame } from "../../src/protocol.js";
import type {
  TaskEvent,
  TaskStatus,
} from "../../src/collaboration-types.js";
import { TaskStore, reduceTaskEvents } from "../../src/tasks.js";

const alice = { memberId: "member-alice", principalId: "alice" };
const bob = { memberId: "member-bob", principalId: "bob" };
const carol = { memberId: "member-carol", principalId: "carol" };

function createdInput(overrides: Record<string, unknown> = {}) {
  return {
    taskId: "task-1",
    roomId: "room-1",
    title: "Ship the task model",
    actor: alice,
    eventId: "event-created",
    now: 100,
    ...overrides,
  };
}

describe("TaskStore", () => {
  it("creates a task and adds its creator as a participant", () => {
    const store = new TaskStore();

    const task = store.create(createdInput());

    expect(task).toMatchObject({
      taskId: "task-1",
      roomId: "room-1",
      title: "Ship the task model",
      status: "open",
      blocked: false,
      assigneeId: undefined,
      participantIds: [alice.memberId],
      createdBy: alice.memberId,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(store.events("room-1").map((event) => [event.seq, event.type])).toEqual([[1, "task.created"]]);
  });


  it("emits task events to the host persistence seam and restores task events from the Room ledger", () => {
    const emitted: TaskEvent[] = [];
    const store = new TaskStore([], { eventSink: (event) => emitted.push(event) });
    store.create(createdInput());

    expect(emitted).toEqual(store.events("room-1"));
    const ledgerEvents = emitted.map((event) => ({
      eventId: `task:${event.eventId}`,
      roomId: event.roomId,
      seq: event.seq,
      type: event.type,
      actor: event.actor,
      createdAt: event.createdAt,
      payload: event.payload,
    }));
    expect(TaskStore.fromRoomEvents(ledgerEvents).get("task-1")).toMatchObject({ title: "Ship the task model" });
  });

  it("allows only the documented forward status transitions", () => {
    const store = new TaskStore();
    store.create(createdInput());

    expect(() => store.setStatus({ taskId: "task-1", status: "done", actor: alice, eventId: "event-invalid", now: 110 }))
      .toThrow(/status/i);
    expect(store.setStatus({ taskId: "task-1", status: "doing", actor: alice, eventId: "event-doing", now: 110 }).status).toBe("doing");
    expect(store.setStatus({ taskId: "task-1", status: "in-review", actor: alice, eventId: "event-review", now: 120 }).status).toBe("in-review");
    expect(store.events("room-1").map((event) => event.type)).toEqual([
      "task.created",
      "task.status-changed",
      "task.status-changed",
    ]);
  });

  it("binds one assignee and automatically adds participants for collaboration activity", () => {
    const store = new TaskStore();
    store.create(createdInput());

    store.assign({ taskId: "task-1", assigneeId: bob.memberId, actor: alice, eventId: "event-assigned", now: 110 });
    store.addParticipant({ taskId: "task-1", memberId: carol.memberId, actor: alice, eventId: "event-member", now: 120 });
    store.recordComment({ taskId: "task-1", actor: bob, eventId: "event-comment", now: 130 });
    store.claim({ taskId: "task-1", actor: carol, eventId: "event-claim", now: 140 });
    store.linkChangeSet({ taskId: "task-1", changeSetId: "change-1", actor: alice, eventId: "event-change", now: 150 });

    expect(store.get("task-1")).toMatchObject({
      assigneeId: carol.memberId,
      participantIds: [alice.memberId, bob.memberId, carol.memberId],
      changeSetIds: ["change-1"],
    });
    expect(store.events("room-1").map((event) => event.type)).toEqual([
      "task.created",
      "task.assigned",
      "task.updated",
      "task.updated",
      "task.assigned",
      "task.updated",
    ]);
  });

  it("completes and cancels tasks through terminal events", () => {
    const completed = new TaskStore();
    completed.create(createdInput());
    completed.setStatus({ taskId: "task-1", status: "doing", actor: alice, eventId: "event-doing", now: 110 });
    expect(completed.complete({ taskId: "task-1", actor: alice, eventId: "event-completed", now: 120 })).toMatchObject({
      status: "done",
      completedAt: 120,
      completedBy: alice.memberId,
    });
    expect(completed.events("room-1").at(-1)?.type).toBe("task.completed");

    const cancelled = new TaskStore();
    cancelled.create(createdInput());
    expect(cancelled.cancel({ taskId: "task-1", actor: alice, eventId: "event-cancelled", now: 110 })).toMatchObject({
      status: "cancelled",
      cancelledAt: 110,
      cancelledBy: alice.memberId,
    });
    expect(cancelled.events("room-1").at(-1)).toMatchObject({ type: "task.status-changed" });
  });

  it("reduces out-of-order events deterministically and ignores duplicate event ids", () => {
    const created: TaskEvent = {
      eventId: "event-created",
      roomId: "room-1",
      seq: 1,
      type: "task.created",
      actor: alice,
      createdAt: 100,
      payload: {
        taskId: "task-1",
        title: "Task",
        participantIds: [alice.memberId],
        createdBy: alice.memberId,
      },
    };
    const changed: TaskEvent = {
      eventId: "event-doing",
      roomId: "room-1",
      seq: 2,
      type: "task.status-changed",
      actor: alice,
      createdAt: 110,
      payload: { taskId: "task-1", from: "open", to: "doing" },
    };

    const reduced = reduceTaskEvents([changed, created, changed]);

    expect(reduced.tasks).toHaveLength(1);
    expect(reduced.tasks[0]).toMatchObject({ taskId: "task-1", status: "doing" });
    expect(reduced.events.map((event) => event.eventId)).toEqual(["event-created", "event-doing"]);
  });

  it("restores a persistent snapshot and continues the event sequence", () => {
    const store = new TaskStore();
    store.create(createdInput());
    store.update({ taskId: "task-1", title: "Updated title", actor: alice, eventId: "event-updated", now: 110 });

    const snapshot = store.snapshot();
    const restored = TaskStore.fromSnapshot(snapshot);

    expect(restored.snapshot()).toEqual(snapshot);
    expect(restored.get("task-1").title).toBe("Updated title");
    restored.setStatus({ taskId: "task-1", status: "doing", actor: alice, eventId: "event-doing", now: 120 });
    expect(restored.events("room-1").at(-1)?.seq).toBe(3);
  });

  it("persists cancellation metadata and does not allow invalid completion", () => {
    const store = new TaskStore();
    store.create(createdInput());
    expect(() => store.complete({ taskId: "task-1", actor: alice, eventId: "event-completed", now: 110 })).toThrow(/status|terminal/i);
    const cancelled = store.cancel({ taskId: "task-1", actor: alice, eventId: "event-cancelled", now: 120 });
    expect(cancelled).toMatchObject({ status: "cancelled", cancelledAt: 120, cancelledBy: alice.memberId });
    expect(() => store.complete({ taskId: "task-1", actor: alice, eventId: "event-completed-after-cancel", now: 130 })).toThrow(/terminal/i);
    expect(TaskStore.fromSnapshot(store.snapshot()).get("task-1")).toMatchObject({ status: "cancelled", cancelledAt: 120, cancelledBy: alice.memberId });
  });

  it("adds the ChangeSet submitter as a participant", () => {
    const store = new TaskStore();
    store.create(createdInput());
    store.linkChangeSet({ taskId: "task-1", changeSetId: "change-1", actor: bob, eventId: "event-change", now: 110 });
    expect(store.get("task-1")).toMatchObject({ participantIds: [alice.memberId, bob.memberId], changeSetIds: ["change-1"] });
  });
  it("rejects illegal terminal transitions while reducing remote events", () => {
    const created: TaskEvent = {
      eventId: "event-created",
      roomId: "room-1",
      seq: 1,
      type: "task.created",
      actor: alice,
      createdAt: 100,
      payload: { taskId: "task-1", title: "Task", participantIds: [alice.memberId], createdBy: alice.memberId },
    };
    const cancelled: TaskEvent = {
      eventId: "event-cancelled",
      roomId: "room-1",
      seq: 2,
      type: "task.status-changed",
      actor: alice,
      createdAt: 110,
      payload: { taskId: "task-1", from: "open", to: "cancelled", cancelledBy: alice.memberId },
    };
    const completedAfterCancel: TaskEvent = {
      eventId: "event-completed-after-cancel",
      roomId: "room-1",
      seq: 3,
      type: "task.completed",
      actor: alice,
      createdAt: 120,
      payload: { taskId: "task-1", completedBy: alice.memberId },
    };
    expect(reduceTaskEvents([created, cancelled, completedAfterCancel]).tasks[0]).toMatchObject({ status: "cancelled" });

    const doing: TaskEvent = { ...cancelled, eventId: "event-doing", seq: 2, type: "task.status-changed", payload: { taskId: "task-1", from: "open", to: "doing" } };
    const done: TaskEvent = { ...completedAfterCancel, eventId: "event-done", seq: 3, createdAt: 120 };
    const cancelAfterDone: TaskEvent = { ...cancelled, eventId: "event-cancel-after-done", seq: 4, createdAt: 130, payload: { taskId: "task-1", from: "done", to: "cancelled", cancelledBy: alice.memberId } };
    expect(reduceTaskEvents([created, doing, done, cancelAfterDone]).tasks[0]).toMatchObject({ status: "done" });
  });
  it("keeps old room events readable while accepting Task events", () => {
    const ledger = new EventLedger();
    ledger.append({
      eventId: "old-message",
      roomId: "room-1",
      type: "human.message",
      actor: alice,
      payload: { kind: "human", text: "legacy" },
    });
    ledger.append({
      eventId: "task-created",
      roomId: "room-1",
      type: "task.created",
      actor: alice,
      payload: { taskId: "task-1", title: "Task" },
    });

    expect(ledger.readAfter("room-1", 0).map((event) => event.type)).toEqual(["human.message", "task.created"]);
    expect(decodeServerStreamFrame({
      protocol: "dsh-collab.v1",
      type: "event",
      event: {
        eventId: "task-created",
        roomId: "room-1",
        seq: 2,
        type: "task.created",
        actor: alice,
        createdAt: 100,
        payload: { taskId: "task-1", title: "Task" },
      },
    })).toMatchObject({ kind: "event", event: { type: "task.created" } });
  });

  it.each(["open", "doing", "in-review", "done", "cancelled"] satisfies TaskStatus[])("exposes %s as a stable task status", (status) => {
    expect(status).toBeTypeOf("string");
  });
});
