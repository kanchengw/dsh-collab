import { describe, expect, it } from "vitest";
import { composerKeyAction, composerMentionMenuKeyAction, composerMentionSuggestions, composerTargetForGesture, composerTargetForText, createComposerSubmission, extractComposerMentionIds, insertMemberMention, projectCollabUnread, shouldSuggestMemberMention } from "../../src/ui.js";

describe("collab composer mentions", () => {
  it("routes every composer draft to the human General room", () => {
    expect(composerTargetForText("Could someone review this?")).toBe("room");
    expect(composerTargetForText("@agent run the tests")).toBe("room");
    expect(composerTargetForText("Please ask @agent to summarize")).toBe("room");
    expect(composerTargetForText("请@agent总结一下")).toBe("room");
    expect(composerTargetForText("owner@agent.example")).toBe("room");
  });

  it("suggests human members at a real @ token, supports keyboard selection, and ignores email-like text", () => {
    const members = [{ memberId: "member-alice", displayName: "Alice" }, { memberId: "member-bob", displayName: "Bob" }];
    expect(shouldSuggestMemberMention("Please ask @")).toBe(true);
    expect(shouldSuggestMemberMention("owner@")).toBe(false);
    expect(composerMentionSuggestions("Please ask @a", members)).toEqual([members[0]]);
    expect(composerMentionMenuKeyAction({ key: "ArrowDown", selectedIndex: 0, optionCount: 2 })).toEqual({ kind: "move", selectedIndex: 1 });
    expect(composerMentionMenuKeyAction({ key: "Enter", selectedIndex: 1, optionCount: 2 })).toEqual({ kind: "select", selectedIndex: 1 });
    expect(insertMemberMention("Please ask @a", members[0]!)).toBe("Please ask @Alice ");
    expect(extractComposerMentionIds("Please ask @Alice and owner@Alice.example", members)).toEqual(["member-alice"]);
  });

  it("uses the middle textarea selection and preserves the text after the inserted mention", () => {
    const members = [{ memberId: "member-alice", displayName: "Alice" }];
    const draft = "before @al—after";
    const cursor = "before @al".length;

    expect(composerMentionSuggestions(draft, members, cursor, cursor)).toEqual(members);
    expect(insertMemberMention(draft, members[0]!, cursor, cursor)).toBe("before @Alice —after");
  });

  it("keeps member mentions on room submissions and counts related versus room unread", () => {
    expect(createComposerSubmission({ messageId: "m-mention", roomId: "room-1", authorMemberId: "member-owner", text: "@Alice review", target: "room", mentions: ["member-alice"] })).toMatchObject({ mentions: ["member-alice"], target: "room" });
    expect(projectCollabUnread([
      { eventId: "e1", roomId: "room-1", seq: 1, type: "human.message", createdAt: 1, actor: { memberId: "member-alice", principalId: "alice" }, payload: { mentions: ["member-owner"] } },
      { eventId: "e2", roomId: "room-1", seq: 2, type: "human.message", createdAt: 2, actor: { memberId: "member-bob", principalId: "bob" }, payload: { mentions: [] } },
      { eventId: "e3", roomId: "room-1", seq: 3, type: "human.message", createdAt: 3, actor: { memberId: "member-owner", principalId: "owner" }, payload: { mentions: ["member-alice"] } },
    ], "member-owner")).toEqual({ personal: 1, total: 2 });
    expect(projectCollabUnread([
      { eventId: "e1", roomId: "room-1", seq: 1, type: "human.message", createdAt: 1, actor: { memberId: "member-alice", principalId: "alice" }, payload: { mentions: ["member-owner"] } },
      { eventId: "e2", roomId: "room-1", seq: 2, type: "human.message", createdAt: 2, actor: { memberId: "member-bob", principalId: "bob" }, payload: { mentions: ["member-owner"] } },
      { eventId: "e3", roomId: "room-1", seq: 3, type: "human.message", createdAt: 3, actor: { memberId: "member-owner", principalId: "owner" }, payload: { mentions: ["member-alice"] } },
      { eventId: "e4", roomId: "room-1", seq: 4, type: "human.message", createdAt: 4, actor: { memberId: "member-alice", principalId: "alice" }, payload: { mentions: ["member-owner"] } },
    ], "member-owner", 2)).toEqual({ personal: 1, total: 1 });
  });

  it("keeps resolved room and Agent submissions distinct on the wire", () => {

    expect(createComposerSubmission({ messageId: "m-1", roomId: "room-1", authorMemberId: "member-1", text: "ask @Alice", target: "room" })).toMatchObject({
      messageId: "m-1",
      target: "room",
      text: "ask @Alice",
    });
    expect(createComposerSubmission({ messageId: "m-2", roomId: "room-1", authorMemberId: "member-1", text: "run tests", target: "room" })).toMatchObject({ target: "room" });
    expect(createComposerSubmission({ messageId: "m-2b", roomId: "room-1", authorMemberId: "member-1", text: "hello", target: "room" })).not.toHaveProperty("contextRefs");
  });


  it("matches the native DSH Enter, newline, IME, and repeat behavior", () => {
    expect(composerKeyAction({ key: "Enter" })).toBe("submit");
    expect(composerKeyAction({ key: "Enter", shiftKey: true })).toBe("native");
    expect(composerKeyAction({ key: "Enter", isComposing: true })).toBe("native");
    expect(composerKeyAction({ key: "Enter", keyCode: 229 })).toBe("native");
    expect(composerKeyAction({ key: "Enter", repeat: true })).toBe("suppress");
    expect(composerKeyAction({ key: "a" })).toBe("native");
  });

  it("keeps Shift+Enter in the human General room", () => {
    expect(composerTargetForGesture("@agent continue", false, true)).toBe("room");
    expect(composerTargetForGesture("@agent continue", true, true)).toBe("room");
    expect(composerTargetForGesture("hello", true, true)).toBe("room");
  });
});
