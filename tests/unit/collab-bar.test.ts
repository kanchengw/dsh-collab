import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CollabBarView,
  collabRoomMatchesScope,
  nextCollabBarTab,
  type CollabBarTab,
} from "../../src/collab-bar.js";
import type { CollabChangesPort } from "../../src/collab-changes.js";
import { DshCollabDock, type DshCollabClientPort, type DshCollabClientSnapshot } from "../../src/dsh-client.js";
import { zh, type CollabTranslate } from "../../src/locales.js";

const t: CollabTranslate = (key, params) => {
  const template = zh[key];
  return params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
    : template;
};

function snapshot(overrides: Partial<DshCollabClientSnapshot> = {}): DshCollabClientSnapshot {
  return {
    roomId: "room-1",
    memberId: "member-owner",
    roomTitle: "Release planning",
    hostDisplayName: "Owner",
    role: "host",
    connection: "online",
    onlineCount: 2,
    canSteer: true,
    members: [
      { memberId: "member-owner", displayName: "Owner" },
      { memberId: "member-alice", displayName: "Alice" },
    ],
    timeline: [{ eventId: "event-1", contextEventId: "event-1", seq: 1, kind: "human", authorMemberId: "member-alice", text: "Ready for review" }],
    agentQueue: [],
    ...overrides,
  };
}

function roomPort(value: DshCollabClientSnapshot): DshCollabClientPort {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
    send: vi.fn(),
  };
}

function changesPort(workspace: CollabChangesPort["getSnapshot"] extends () => infer T ? T : never): CollabChangesPort {
  return {
    getSnapshot: () => workspace,
    subscribe: () => () => {},
    refresh: vi.fn(async () => {}),
    sync: vi.fn(async () => {}),
    discardAndSync: vi.fn(async () => {}),
    createDraft: vi.fn(async () => {}),
    submitDraft: vi.fn(async () => {}),
    selectChangeSet: vi.fn(async () => {}),
  };
}

describe("Collab Bar", () => {
  it("matches an Owned room by Room Workspace instead of Host Session", () => {
    const selection = {
      kind: "owned" as const,
      roomId: "room-1",
      hostSessionId: "session-primary",
      roomTitle: "Release planning",
      workspacePath: "C:\\rooms\\release\\workspace",
    };

    expect(collabRoomMatchesScope(selection as never, { sessionId: "session-secondary", cwd: "c:/rooms/release/workspace", visible: true })).toBe(true);
    expect(collabRoomMatchesScope(selection as never, { sessionId: "session-secondary", cwd: "C:\\rooms\\other\\workspace", visible: true })).toBe(false);
    expect(collabRoomMatchesScope(selection as never, { sessionId: "session-primary", cwd: undefined, visible: true })).toBe(false);
  });

  it("keeps a Joined room matched only to its local Session", () => {
    const selection = {
      kind: "joined" as const,
      roomId: "room-1",
      gatewayEndpoint: "wss://owner.example/collab",
      roomTitle: "Release planning",
      localSessionId: "session-a",
    };

    expect(collabRoomMatchesScope(selection, { sessionId: "session-a", cwd: "C:\\rooms\\release\\workspace", visible: true })).toBe(true);
    expect(collabRoomMatchesScope(selection, { sessionId: "session-b", cwd: "C:\\rooms\\release\\workspace", visible: true })).toBe(false);
  });

  it("shows the Room Project version without duplicating the connection summary", () => {
    const html = renderToStaticMarkup(createElement(CollabBarView, {
      scope: { sessionId: "session-owner", cwd: "C:/work/release", visible: true },
      selection: { kind: "owned", roomId: "room-1", hostSessionId: "session-owner", roomTitle: "Release planning" },
      roomSnapshot: snapshot(),
      changesPort: changesPort({
        roomId: "room-1",
        role: "owner",
        connection: "online",
        workspace: { kind: "owner", latestVersionId: "version-1" },
        staged: [],
      }),
      discussion: createElement(DshCollabDock, { port: roomPort(snapshot()), showHeader: false }),
    }));

    expect(html).toContain('data-collab-project="true"');
    expect(html).toContain("Room Project");
    expect(html).toContain("version-1");
    expect(html).toContain("Owner workspace");
    expect(html.match(/2 members/g)).toHaveLength(1);
    expect(html).toContain("Owner");
    expect(html).toContain("Alice");
  });

  it("composes room discussion, a local composer, and three panels without recreating a root room surface", () => {
    const html = renderToStaticMarkup(createElement(CollabBarView, {
      scope: { sessionId: "session-owner", cwd: "C:/work/release", visible: true },
      selection: { kind: "owned", roomId: "room-1", hostSessionId: "session-owner", roomTitle: "Release planning" },
      roomSnapshot: { ...snapshot(), personalUnreadCount: 1, totalUnreadCount: 2 },
      discussion: createElement(DshCollabDock, { port: roomPort(snapshot()), showHeader: false }),
    }));

    expect(html).toContain('data-collab-bar="true"');
    expect(html).toContain('data-connection="online"');
    expect(html).toContain("Online · 2 members");
    expect(html).toContain('data-collab-unread="true"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain(">Tasks<");
    expect(html).toContain(">Activity<");
    expect(html).toContain(">Changes<");
    expect(html).toContain(">Reviews<");
    expect(html).toContain("Ready for review");
    expect(html).toContain('name="collab-text"');
    expect(html).not.toContain('data-collab-agent-queue="true"');
    expect(html).toContain("<textarea");
    expect(html).toContain('data-collab-surface="room"');
    expect(html).not.toContain('data-collab-room-overlay="true"');
    expect(html).not.toContain("Agent message queue");
  });

  it("keeps a Joined room bound to the local Session that opened it", () => {
    const selection = {
      kind: "joined" as const,
      roomId: "room-1",
      gatewayEndpoint: "wss://owner.example/collab",
      roomTitle: "Release planning",
      localSessionId: "session-a",
    };
    const matching = renderToStaticMarkup(createElement(CollabBarView, {
      scope: { sessionId: "session-a", visible: true }, selection, roomSnapshot: snapshot({ role: "participant" }),
      discussion: createElement(DshCollabDock, { port: roomPort(snapshot({ role: "participant" })), showHeader: false }),
    }));
    const other = renderToStaticMarkup(createElement(CollabBarView, {
      scope: { sessionId: "session-b", visible: true }, selection, roomSnapshot: snapshot({ role: "participant" }),
      discussion: createElement(DshCollabDock, { port: roomPort(snapshot({ role: "participant" })), showHeader: false }),
    }));

    expect(matching).toContain("Ready for review");
    expect(other).toContain("Open a Collab room for this Session");
    expect(other).not.toContain('data-collab-timeline="true"');
  });

  it("provides complete Chinese navigation and honest unavailable states", () => {
    const html = renderToStaticMarkup(createElement(CollabBarView, {
      scope: { sessionId: "session-owner", visible: true },
      selection: { kind: "owned", roomId: "room-1", hostSessionId: "session-owner", roomTitle: "发布计划" },
      roomSnapshot: snapshot({ roomTitle: "发布计划" }),
      discussion: createElement(DshCollabDock, { port: roomPort(snapshot({ roomTitle: "发布计划" })), showHeader: false, t }),
      initialTab: "changes",
      t,
    }));

    expect(html).toContain("协作");
    expect(html).toContain("任务");
    expect(html).toContain("动态");
    expect(html).toContain("变更");
    expect(html).toContain("审阅");
    expect(html).toContain("变更功能尚未连接到此房间");
  });

  it("places published Work Updates inside the single chronological discussion feed", () => {
    const discussionSnapshot = snapshot({
      timeline: [
        { eventId: "human-1", contextEventId: "human-1", seq: 1, kind: "human", authorMemberId: "member-alice", text: "Human discussion" },
        { eventId: "human-2", contextEventId: "human-2", seq: 3, kind: "human", authorMemberId: "member-owner", text: "Owner follow-up" },
      ],
    });
    const html = renderToStaticMarkup(createElement(CollabBarView, {
      scope: { sessionId: "session-owner", visible: true },
      selection: { kind: "owned", roomId: "room-1", hostSessionId: "session-owner", roomTitle: "Release" },
      roomSnapshot: discussionSnapshot,
      discussion: createElement(DshCollabDock, {
        port: roomPort(discussionSnapshot),
        showHeader: false,
        workUpdates: [
        { eventId: "update-1", seq: 2, createdAt: 2, kind: "work-update", authorId: "member-alice", summary: "Reconnect is covered", filePaths: ["src/reconnect.ts"] },
        ],
      }),
    }));

    expect(html.match(/Human discussion/g)).toHaveLength(1);
    expect(html).toContain("Reconnect is covered");
    expect(html).toContain("src/reconnect.ts");
    expect(html.indexOf("Human discussion")).toBeLessThan(html.indexOf("Reconnect is covered"));
    expect(html.indexOf("Reconnect is covered")).toBeLessThan(html.indexOf("Owner follow-up"));
    expect(html).toContain('data-kind="work-update"');
    expect(html).toContain('data-own="true"');
    expect(html.match(/data-collab-feed="true"/g)).toHaveLength(1);
  });

  it("uses predictable keyboard tab navigation", () => {
    const cases: Array<[CollabBarTab, string, CollabBarTab]> = [
      ["tasks", "ArrowRight", "activity"],
      ["activity", "ArrowRight", "changes"],
      ["changes", "ArrowRight", "reviews"],
      ["reviews", "ArrowRight", "tasks"],
      ["activity", "ArrowLeft", "tasks"],
      ["reviews", "Home", "tasks"],
      ["tasks", "End", "reviews"],
      ["changes", "Enter", "changes"],
    ];
    for (const [current, key, expected] of cases) expect(nextCollabBarTab(current, key)).toBe(expected);
  });

  it("uses an in-flow narrow room timeline without a duplicate composer", () => {
    const barCss = readFileSync(resolve(process.cwd(), "src/collab-bar.module.css"), "utf8");
    const roomCss = readFileSync(resolve(process.cwd(), "src/collab-room.module.css"), "utf8");
    expect(barCss).toMatch(/@media\s*\(max-width:\s*48rem\)/);
    expect(barCss).toMatch(/\.bar\s*\{[^}]*display:\s*flex/s);
    expect(barCss).not.toMatch(/\.bar\s*\{[^}]*(?:position:\s*(?:fixed|absolute)|inset:)/s);
    expect(barCss).toContain("min-width: 0");
    expect(roomCss).toMatch(/\.dock\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/s);
    expect(roomCss).toMatch(/\.timeline\s*\{[^}]*flex:\s*1/s);
    expect(roomCss).toMatch(/\.composer\s*\{/);
    expect(roomCss).not.toMatch(/\.queue\s*\{/);
    expect(roomCss).not.toContain("width: min(900px");
  });
});
