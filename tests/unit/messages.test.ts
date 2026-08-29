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

  it("creates a followup only for an explicit DSH target", () => {
    const message = classifyMessage({
      ...base,
      messageId: "message-2",
      text: "Run the release tests",
      target: "dsh",
      sourceMessageId: "message-1",
      contextRefs: ["message-1"],
    });

    expect(message).toEqual({
      kind: "agent-request",
      messageId: "message-2",
      roomId: "room-1",
      authorMemberId: "member-alice",
      text: "Run the release tests",
      target: "dsh",
      deliveryMode: "followup",
      sourceMessageId: "message-1",
      contextRefs: ["message-1"],
    });
  });

  it("marks explicit current-execution requests as steer", () => {
    const message = classifyMessage({
      ...base,
      text: "Use the staging config instead",
      target: "dsh-steer",
    });

    expect(message).toMatchObject({
      kind: "agent-request",
      target: "dsh",
      deliveryMode: "steer",
    });
  });

  it("trims text and rejects blank or oversized input", () => {
    expect(classifyMessage({ ...base, text: "  hello  " })).toMatchObject({ text: "hello" });
    expect(() => classifyMessage({ ...base, text: "  " })).toThrow(/text/i);
    expect(() => classifyMessage({ ...base, text: "x".repeat(10_001) })).toThrow(/text/i);
  });

  it("limits Agent context references to three messages", () => {
    expect(() => classifyMessage({
      ...base,
      text: "@agent compare these",
      target: "dsh",
      contextRefs: ["message-1", "message-2", "message-3", "message-4"],
    })).toThrow(/context references/i);
  });
});
