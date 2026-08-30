import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CollabActivity, projectCollabActivity } from "../../src/collab-activity.js";
import type { RoomEvent, WorkUpdate } from "../../src/types.js";

function event(seq: number, type: RoomEvent["type"], payload: unknown, overrides: Partial<RoomEvent> = {}): RoomEvent {
  return {
    eventId: `event-${String(seq)}`,
    roomId: "room-1",
    seq,
    type,
    actor: { memberId: "member-1", principalId: "alice" },
    createdAt: seq * 100,
    payload,
    ...overrides,
  };
}

function workUpdate(): WorkUpdate {
  return {
    updateId: "a".repeat(64),
    roomId: "room-1",
    authorId: "member-1",
    sourceSessionId: "session-1",
    summary: "Implemented **recovery** <script>alert(1)</script>",
    filePaths: ["src/recovery.ts", "tests/recovery.test.ts"],
    changeSetId: "changeset-1",
    createdAt: 200,
  };
}

describe("Collab Activity", () => {
  it("projects human messages and Work Updates once in stable room sequence order", () => {
    const updateEvent = event(2, "work-update.published", workUpdate());
    const items = projectCollabActivity([
      updateEvent,
      event(1, "human.message", { kind: "human", messageId: "message-1", roomId: "room-1", authorMemberId: "member-1", text: "Starting recovery", visibility: "room" }),
      updateEvent,
      event(3, "member.joined", { memberId: "member-2" }),
    ]);

    expect(items).toEqual([
      expect.objectContaining({ eventId: "event-1", kind: "message", seq: 1, authorId: "member-1", text: "Starting recovery" }),
      expect.objectContaining({ eventId: "event-2", kind: "work-update", seq: 2, authorId: "member-1", summary: workUpdate().summary, filePaths: workUpdate().filePaths, changeSetId: "changeset-1" }),
    ]);
  });

  it("fails closed for malformed or cross-room durable Activity payloads", () => {
    expect(() => projectCollabActivity([event(1, "work-update.published", { ...workUpdate(), roomId: "room-2" })])).toThrow("room");
    expect(() => projectCollabActivity([event(1, "work-update.published", { ...workUpdate(), transcript: "private" })])).toThrow("unsupported");
    expect(() => projectCollabActivity([event(1, "human.message", { text: 42 })])).toThrow("message");
    expect(() => projectCollabActivity([
      event(1, "member.joined", {}),
      event(2, "member.joined", {}, { roomId: "room-2" }),
    ])).toThrow("one room");
  });

  it("renders a safe DSH-styled Activity list without adding another composer", () => {
    const html = renderToStaticMarkup(createElement(CollabActivity, {
      items: projectCollabActivity([event(2, "work-update.published", workUpdate())]),
      memberNames: new Map([["member-1", "Alice"]]),
    }));

    expect(html).toContain("Activity");
    expect(html).toContain("Alice");
    expect(html).toContain("src/recovery.ts");
    expect(html).toContain("changeset-1");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<form");
  });
});
