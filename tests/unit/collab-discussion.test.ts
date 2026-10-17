import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CollabDiscussion,
  createCollabDiscussionSendInput,
  sendCollabDiscussionMessage,
  subscribeCollabDiscussionSnapshot,
  type CollabDiscussionMessage,
  type CollabDiscussionPort,
  type CollabDiscussionViewPort,
} from "../../src/collab-discussion.js";

const messages: readonly CollabDiscussionMessage[] = [
  { messageId: "message-1", authorId: "alice", text: "General context", scope: "general" },
  { messageId: "message-2", authorId: "bob", text: "Task detail", scope: "task:task-1", sourceMessageId: "message-1" },
];

function port(): CollabDiscussionPort {
  return { send: vi.fn(async () => undefined) };
}

describe("Collab Discussion", () => {
  it("renders one flat stream across General and object scopes with a visible source quote", () => {
    const html = renderToStaticMarkup(createElement(CollabDiscussion, {
      connection: "online",
      messages,
      port: port(),
      scopes: [
        { value: "general", label: "General" },
        { value: "task:task-1", label: "Task: Fix reconnect" },
      ],
    }));

    expect(html).toContain('data-collab-discussion="true"');
    expect(html).toContain('data-scope="general"');
    expect(html).toContain('data-scope="task:task-1"');
    expect(html).toContain("Task detail");
    expect(html).toContain("引用源");
    expect(html).toContain("General context");
    expect(html).not.toContain("<ol");
    expect(html).toMatch(/<ul[^>]*>.*General context.*Task detail.*<\/ul>/s);
  });

  it("shows explicit empty and offline states and disables sending offline", () => {
    const html = renderToStaticMarkup(createElement(CollabDiscussion, {
      connection: "offline",
      messages: [],
      port: port(),
      scopes: [{ value: "general", label: "General" }],
    }));

    expect(html).toContain("暂无讨论消息");
    expect(html).toContain("当前离线，恢复连接后才能发送消息");
    expect(html).toMatch(/<button[^>]+disabled=""[^>]*>发送<\/button>/);
  });

  it("marks a missing source explicitly without rendering a nested thread", () => {
    const html = renderToStaticMarkup(createElement(CollabDiscussion, {
      connection: "online",
      messages: [{ ...messages[1]!, sourceMessageId: "message-missing" }],
      port: port(),
      scopes: [{ value: "general", label: "General" }, { value: "task:task-1", label: "Task: Fix reconnect" }],
    }));

    expect(html).toContain("引用源不可用");
    expect(html).not.toContain("message-missing");
    expect(html).not.toContain("<ol");
  });

  it("notifies listeners with the latest snapshot when the port changes", () => {
    let current = { roomId: "room-1", connection: "online" as const, messages, scopes: [{ value: "general" as const, label: "General" }] };
    let notify: (() => void) | undefined;
    const discussionPort = {
      getSnapshot: () => current,
      subscribe: (listener: () => void) => { notify = listener; return () => { notify = undefined; }; },
      send: vi.fn(async () => undefined),
    } satisfies CollabDiscussionViewPort;
    const snapshots: string[] = [];
    const unsubscribe = subscribeCollabDiscussionSnapshot(discussionPort, (snapshot) => { snapshots.push(snapshot.messages[0]?.text ?? ""); });
    current = { ...current, messages: [{ ...messages[0]!, text: "Updated general context" }] };
    notify?.();
    unsubscribe();
    expect(snapshots).toEqual(["General context", "Updated general context"]);
  });

  it("trims text, keeps only a valid source id, and maps the exact port contract", async () => {
    const discussionPort = port();
    const input = createCollabDiscussionSendInput({
      text: "  Reply  ",
      scope: "task:task-1",
      sourceMessageId: "message-1",
    }, messages);

    expect(input).toEqual({ text: "Reply", scope: "task:task-1", sourceMessageId: "message-1" });
    await sendCollabDiscussionMessage(discussionPort, { text: "  Reply  ", scope: "task:task-1", sourceMessageId: "message-missing" }, messages);
    expect(discussionPort.send).toHaveBeenCalledWith({ text: "Reply", scope: "task:task-1" });
  });
});

