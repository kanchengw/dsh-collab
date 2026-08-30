import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CollabBarView,
  nextCollabBarTab,
  type CollabBarTab,
} from "../../src/collab-bar.js";
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

describe("Collab Bar", () => {
  it("composes room discussion and three panels without recreating a root room surface or native conversation", () => {
    const html = renderToStaticMarkup(createElement(CollabBarView, {
      scope: { sessionId: "session-owner", cwd: "C:/work/release", visible: true },
      selection: { kind: "owned", roomId: "room-1", hostSessionId: "session-owner", roomTitle: "Release planning" },
      roomSnapshot: snapshot(),
      discussion: createElement(DshCollabDock, { port: roomPort(snapshot()), showHeader: false, showQueue: false }),
    }));

    expect(html).toContain('data-collab-bar="true"');
    expect(html).toContain('role="tablist"');
    expect(html).toContain(">Activity<");
    expect(html).toContain(">Changes<");
    expect(html).toContain(">Reviews<");
    expect(html).toContain("Ready for review");
    expect(html.match(/name="collab-text"/g)).toHaveLength(1);
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).not.toContain('data-collab-surface="room"');
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
      discussion: createElement(DshCollabDock, { port: roomPort(snapshot({ role: "participant" })), showHeader: false, showQueue: false }),
    }));
    const other = renderToStaticMarkup(createElement(CollabBarView, {
      scope: { sessionId: "session-b", visible: true }, selection, roomSnapshot: snapshot({ role: "participant" }),
      discussion: createElement(DshCollabDock, { port: roomPort(snapshot({ role: "participant" })), showHeader: false, showQueue: false }),
    }));

    expect(matching).toContain('name="collab-text"');
    expect(other).toContain("Open a Collab room for this Session");
    expect(other).not.toContain('name="collab-text"');
  });

  it("provides complete Chinese navigation and honest unavailable states", () => {
    const html = renderToStaticMarkup(createElement(CollabBarView, {
      scope: { sessionId: "session-owner", visible: true },
      selection: { kind: "owned", roomId: "room-1", hostSessionId: "session-owner", roomTitle: "发布计划" },
      roomSnapshot: snapshot({ roomTitle: "发布计划" }),
      discussion: createElement(DshCollabDock, { port: roomPort(snapshot({ roomTitle: "发布计划" })), showHeader: false, showQueue: false, t }),
      initialTab: "changes",
      t,
    }));

    expect(html).toContain("协作");
    expect(html).toContain("动态");
    expect(html).toContain("变更");
    expect(html).toContain("审阅");
    expect(html).toContain("变更功能尚未连接到此房间");
  });

  it("adds published Work Updates to Activity without duplicating human discussion", () => {
    const html = renderToStaticMarkup(createElement(CollabBarView, {
      scope: { sessionId: "session-owner", visible: true },
      selection: { kind: "owned", roomId: "room-1", hostSessionId: "session-owner", roomTitle: "Release" },
      roomSnapshot: snapshot(),
      discussion: createElement("div", { "data-room-discussion": true }, "Human discussion"),
      activityItems: [
        { eventId: "human-1", seq: 1, createdAt: 1, kind: "message", authorId: "member-alice", text: "Human discussion" },
        { eventId: "update-1", seq: 2, createdAt: 2, kind: "work-update", authorId: "member-alice", summary: "Reconnect is covered", filePaths: ["src/reconnect.ts"] },
      ],
    }));

    expect(html.match(/Human discussion/g)).toHaveLength(1);
    expect(html).toContain("Reconnect is covered");
    expect(html).toContain("src/reconnect.ts");
  });

  it("uses predictable keyboard tab navigation", () => {
    const cases: Array<[CollabBarTab, string, CollabBarTab]> = [
      ["activity", "ArrowRight", "changes"],
      ["changes", "ArrowRight", "reviews"],
      ["reviews", "ArrowRight", "activity"],
      ["activity", "ArrowLeft", "reviews"],
      ["reviews", "Home", "activity"],
      ["activity", "End", "reviews"],
      ["changes", "Enter", "changes"],
    ];
    for (const [current, key, expected] of cases) expect(nextCollabBarTab(current, key)).toBe(expected);
  });

  it("uses an in-flow narrow layout that cannot cover the native composer", () => {
    const css = readFileSync(resolve(process.cwd(), "src/collab-bar.module.css"), "utf8");
    expect(css).toMatch(/@media\s*\(max-width:\s*48rem\)/);
    expect(css).not.toMatch(/position:\s*(?:fixed|absolute)/);
    expect(css).toContain("min-width: 0");
  });
});
