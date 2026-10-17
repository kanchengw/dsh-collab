import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CollabTasks,
  createCollabTaskActionHandlers,
  validateCollabTasksSnapshot,
  type CollabTaskChangeSet,
  type CollabTasksPort,
  type CollabTasksSnapshot,
} from "../../src/collab-tasks.js";
import type { CollaborationDecision, CollaborationTask } from "../../src/collaboration-types.js";

const taskId = "task-1";

function task(overrides: Partial<CollaborationTask> = {}): CollaborationTask {
  return {
    taskId,
    roomId: "room-1",
    title: "Fix reconnect",
    description: "Keep the room state after reconnecting.",
    status: "doing",
    blocked: false,
    assigneeId: "member-alice",
    participantIds: ["member-alice", "member-bob"],
    changeSetIds: ["change-1"],
    createdBy: "member-alice",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function decision(overrides: Partial<CollaborationDecision> = {}): CollaborationDecision {
  return {
    decisionId: "decision-1",
    roomId: "room-1",
    scope: `task:${taskId}`,
    conclusion: "Keep reconnect state in the room projection.",
    sourceMessageIds: ["message-1"],
    proposedBy: "member-bob",
    createdAt: 3,
    status: "accepted",
    acceptedBy: "member-alice",
    acceptedAt: 4,
    ...overrides,
  };
}

function changeSet(overrides: Partial<CollabTaskChangeSet> = {}): CollabTaskChangeSet {
  return {
    changeSetId: "change-1",
    roomId: "room-1",
    title: "Persist reconnect state",
    status: "in-review",
    ...overrides,
  };
}

function snapshot(overrides: Partial<CollabTasksSnapshot> = {}): CollabTasksSnapshot {
  return {
    roomId: "room-1",
    role: "participant",
    currentMemberId: "member-alice",
    connection: "online",
    members: [
      { memberId: "member-alice", displayName: "Alice" },
      { memberId: "member-bob", displayName: "Bob" },
    ],
    tasks: [{
      task: task(),
      decisions: [decision()],
      changeSets: [changeSet()],
      discussion: [{ messageId: "message-1", authorId: "member-bob", text: "I reproduced the reconnect race." }],
    }],
    selectedTaskId: taskId,
    ...overrides,
  };
}

function port(value: CollabTasksSnapshot): CollabTasksPort {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
    refresh: vi.fn(async () => undefined),
    createTask: vi.fn(async () => undefined),
    selectTask: vi.fn(async () => undefined),
    claimTask: vi.fn(async () => undefined),
    setTaskStatus: vi.fn(async () => undefined),
    addTaskParticipant: vi.fn(async () => undefined),
  };
}

describe("Collab Tasks", () => {
  it("rejects cross-room or inconsistent task projections", () => {
    expect(() => validateCollabTasksSnapshot(snapshot({ tasks: [{ task: task({ roomId: "room-2" }), decisions: [], changeSets: [] }] }))).toThrow(/room/i);
    expect(() => validateCollabTasksSnapshot(snapshot({ tasks: [{ task: task({ assigneeId: "member-unknown" }), decisions: [], changeSets: [] }] }))).toThrow(/member/i);
    expect(() => validateCollabTasksSnapshot(snapshot({ tasks: [{ task: task(), decisions: [decision({ roomId: "room-2" })], changeSets: [] }] }))).toThrow(/room/i);
  });

  it("renders the task board, expanded detail, discussion, Decision, and ChangeSet links", () => {
    const html = renderToStaticMarkup(createElement(CollabTasks, { port: port(snapshot()) }));

    expect(html).toContain('data-collab-tasks="true"');
    expect(html).toContain('data-connection="online"');
    expect(html).toContain("Task board");
    expect(html).toContain("Fix reconnect");
    expect(html).toContain("Doing");
    expect(html).toContain("I reproduced the reconnect race.");
    expect(html).toContain("Decision");
    expect(html).toContain("Keep reconnect state in the room projection.");
    expect(html).toContain("ChangeSet");
    expect(html).toContain("Persist reconnect state");
    expect(html).toContain("Create task");
    expect(html).toContain("Claim task");
    expect(html).toContain("Add participant");
    expect(html).toContain('required=""');
    expect(html).toMatch(/maxLength="120"|maxlength="120"/);
  });

  it("keeps offline and empty states visible while constraining actions", () => {
    const html = renderToStaticMarkup(createElement(CollabTasks, {
      port: port(snapshot({ connection: "offline", tasks: [], selectedTaskId: undefined })),
    }));

    expect(html).toContain('data-connection="offline"');
    expect(html).toContain("Offline");
    expect(html).toContain("No tasks yet");
    expect(html).toContain("Reconnect to create or update tasks.");
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>Create task<\/button>/);
  });

  it("maps the task panel actions to the port contract", async () => {
    const tasksPort = port(snapshot());
    const actions = createCollabTaskActionHandlers(tasksPort);

    await actions.createTask({ title: "New task", description: "A bounded task." });
    await actions.claimTask(taskId);
    await actions.setTaskStatus(taskId, "in-review");
    await actions.addTaskParticipant(taskId, "member-bob");

    expect(tasksPort.createTask).toHaveBeenCalledWith({ title: "New task", description: "A bounded task." });
    expect(tasksPort.claimTask).toHaveBeenCalledWith(taskId);
    expect(tasksPort.setTaskStatus).toHaveBeenCalledWith(taskId, "in-review");
    expect(tasksPort.addTaskParticipant).toHaveBeenCalledWith(taskId, "member-bob");
  });
});

