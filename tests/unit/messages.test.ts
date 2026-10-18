import { describe, expect, it } from "vitest";
import { classifyMessage } from "../../src/messages.js";

const base = {
  messageId: "message-1",
  roomId: "room-1",
  authorMemberId: "member-alice",
};

describe("classifyMessage", () => {
  it("keeps ordinary text as a human-only room message", () => {
    const message = classifyMessage({ ...base, text: "The literal @DSH is not a request." });

    expect(message).toEqual(expect.objectContaining({
      kind: "human",
      messageId: "message-1",
      roomId: "room-1",
      authorMemberId: "member-alice",
      text: "The literal @DSH is not a request.",
      visibility: "room",
    }));
  });

  it("preserves human member mentions for relatedness notifications", () => {
    expect(classifyMessage({ ...base, text: "@Alice please review", mentions: ["member-alice", "member-alice"] })).toEqual(expect.objectContaining({
      kind: "human",
      mentions: ["member-alice"],
    }));
  });

  it("preserves discussion scope and source message references in HumanMessage", () => {
    expect(classifyMessage({
      ...base,
      text: "Follow up on the task.",
      scope: "task:task-1",
      sourceMessageId: "message-source",
    })).toEqual(expect.objectContaining({
      kind: "human",
      scope: "task:task-1",
      sourceMessageId: "message-source",
    }));
  });

  it("accepts task discussion scopes when the durable task id contains a namespace separator", () => {
    expect(classifyMessage({
      ...base,
      messageId: "message-namespace",
      text: "Follow up on the generated task.",
      scope: "task:task:task-create",
    })).toMatchObject({ scope: "task:task:task-create" });
  });

  it("rejects retired Agent targets at the message boundary", () => {
    expect(() => classifyMessage({ ...base, messageId: "message-2", text: "Run the release tests", target: "dsh" })).toThrow(/retired|human|room/i);
    expect(() => classifyMessage({ ...base, messageId: "message-3", text: "Stop", target: "dsh-steer" })).toThrow(/retired|human|room/i);
  });

  it("trims text and rejects blank or oversized input", () => {
    expect(classifyMessage({ ...base, text: "  hello  " })).toMatchObject({ text: "hello" });
    expect(() => classifyMessage({ ...base, text: "  " })).toThrow(/text/i);
    expect(() => classifyMessage({ ...base, text: "x".repeat(10_001) })).toThrow(/text/i);
  });

});
