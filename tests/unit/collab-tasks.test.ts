import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { zh, type CollabTranslate } from "../../src/locales.js";

const taskId = "task-1";

const t: CollabTranslate = (key, params) => {
  const template = zh[key];
  return params ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match) : template;
};

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
    status: "proposed",
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
    roomDecisions: [decision({ scope: "room", decisionId: "decision-room", status: "accepted", acceptedBy: "member-alice", acceptedAt: 4 })],
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
    unassignTask: vi.fn(async () => undefined),
    setTaskStatus: vi.fn(async () => undefined),
    addTaskParticipant: vi.fn(async () => undefined),
    sendDiscussion: vi.fn(async () => undefined),
    proposeDecision: vi.fn(async () => undefined),
    acceptDecision: vi.fn(async () => undefined),
  };
}

describe("Collab Tasks", () => {
  it("renders task UI copy in Chinese when translated", () => {
    const html = renderToStaticMarkup(createElement(CollabTasks, { port: port(snapshot()), t }));

    expect(html).toContain("任务看板");
    expect(html).toContain("任务列表");
    expect(html).toContain("房间决定");
    expect(html).toContain("进行中");
    expect(html).toContain("负责人");
    expect(html).toContain("创建任务");
    expect(html).toContain("任务讨论");
    expect(html).toContain("已提出");
    expect(html).not.toContain("Task board");
    expect(html).not.toContain("Create task");
  });

  it("keeps visible task labels out of CSS-generated English", () => {
    const css = readFileSync(resolve(process.cwd(), "src/collab-tasks.module.css"), "utf8");
    expect(css).not.toMatch(/\.board::before\s*\{[^}]*content:/s);
  });

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
    expect(html).toContain("Send discussion");
    expect(html).toContain("Decision");
    expect(html).toContain("Room decisions");
    expect(html).toContain("Propose decision");
    expect(html).toContain("Accept decision");
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
    await actions.unassignTask(taskId);
    await actions.setTaskStatus(taskId, "in-review");
    await actions.addTaskParticipant(taskId, "member-bob");
    await actions.sendDiscussion(taskId, "A task-scoped update.");

    expect(tasksPort.createTask).toHaveBeenCalledWith({ title: "New task", description: "A bounded task." });
    expect(tasksPort.claimTask).toHaveBeenCalledWith(taskId);
    expect(tasksPort.unassignTask).toHaveBeenCalledWith(taskId);
    expect(tasksPort.setTaskStatus).toHaveBeenCalledWith(taskId, "in-review");
    expect(tasksPort.addTaskParticipant).toHaveBeenCalledWith(taskId, "member-bob");
    expect(tasksPort.sendDiscussion).toHaveBeenCalledWith(taskId, "A task-scoped update.");
  });
});

