import { describe, expect, it, vi } from "vitest";
import { createCollabDiscussionPort, createCollabTasksPort } from "../../src/collab-live-ports.js";
import type { DshCollabClientPort } from "../../src/dsh-client.js";
import type { RoomEvent } from "../../src/types.js";

function client(events: RoomEvent[]): DshCollabClientPort {
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => ({
      roomId: "room-1",
      memberId: "member-host",
      roomTitle: "Room",
      hostDisplayName: "Host",
      role: "host",
      connection: "online",
      onlineCount: 1,
      canSteer: false,
      members: [{ memberId: "member-host", displayName: "Host" }, { memberId: "member-bob", displayName: "Bob" }],
      roomEvents: events,
    }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    send: vi.fn(async () => undefined),
    createTask: vi.fn(async () => undefined),
    claimTask: vi.fn(async () => undefined),
    unassignTask: vi.fn(async () => undefined),
    setTaskStatus: vi.fn(async () => undefined),
    addTaskParticipant: vi.fn(async () => undefined),
  };
}

const events: RoomEvent[] = [
  { eventId: "task-created", roomId: "room-1", seq: 1, type: "task.created", actor: { memberId: "member-host", principalId: "host" }, createdAt: 1, payload: { taskId: "task-1", title: "Ship", participantIds: ["member-host"], createdBy: "member-host" } },
  { eventId: "decision-1", roomId: "room-1", seq: 2, type: "decision.proposed", actor: { memberId: "member-host", principalId: "host" }, createdAt: 2, payload: { decisionId: "decision-1", scope: "task:task-1", conclusion: "Ship it", sourceMessageIds: ["message-1"], proposedBy: "member-host" } },
  { eventId: "message-1:human", roomId: "room-1", seq: 3, type: "human.message", actor: { memberId: "member-host", principalId: "host" }, createdAt: 3, payload: { kind: "human", messageId: "message-1", roomId: "room-1", authorMemberId: "member-host", text: "hello", visibility: "room", scope: "general" } },
];

describe("production Collab ports", () => {
  it("projects Task and Decision events from the live room ledger and delegates mutations", async () => {
    const live = client(events);
    const port = createCollabTasksPort(live);
    expect(port.getSnapshot().tasks[0]).toMatchObject({ task: { taskId: "task-1", assigneeId: "member-host" }, decisions: [{ decisionId: "decision-1" }] });
    await port.claimTask("task-1");
    await port.unassignTask!("task-1");
    await port.setTaskStatus("task-1", "doing");
    await port.addTaskParticipant("task-1", "member-bob");
    expect(live.claimTask).toHaveBeenCalledWith("room-1", "task-1");
    expect(live.unassignTask).toHaveBeenCalledWith("room-1", "task-1");
    expect(live.setTaskStatus).toHaveBeenCalledWith("room-1", "task-1", "doing");
    expect(live.addTaskParticipant).toHaveBeenCalledWith("room-1", "task-1", "member-bob");
  });

  it("matches generated task ids inside Decision and Discussion scopes", () => {
    const generatedTaskId = "task:task-create";
    const generatedEvents = structuredClone(events);
    const taskEvent = generatedEvents.find((event) => event.eventId === "task-created")!;
    (taskEvent.payload as { taskId: string }).taskId = generatedTaskId;
    const decisionEvent = generatedEvents.find((event) => event.eventId === "decision-1")!;
    (decisionEvent.payload as { scope: string }).scope = `task:${generatedTaskId}`;
    const live = client(generatedEvents);
    const item = createCollabTasksPort(live).getSnapshot().tasks[0]!;
    expect(item.task.taskId).toBe(generatedTaskId);
    expect(item.decisions).toHaveLength(1);
  });

  it("sends General or task scoped discussion with references through the room message transport", async () => {
    const live = client(events);
    const port = createCollabDiscussionPort(live);
    expect(port.getSnapshot().messages).toEqual([expect.objectContaining({ messageId: "message-1", scope: "general" })]);
    await port.send({ text: "reply", scope: "general", sourceMessageId: "message-1" });
    expect(live.send).toHaveBeenCalledWith({ text: "reply", target: "room", sourceMessageId: "message-1", scope: "general" });
  });
});
