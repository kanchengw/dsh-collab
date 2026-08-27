import { describe, expect, it } from "vitest";
import { composerTargetForText, createComposerSubmission, insertAgentMention, renderComposer, shouldSuggestAgentMention } from "../../src/ui.js";

describe("collab composer mentions", () => {
  it("routes only the canonical lowercase @agent mention to the Host Agent", () => {
    expect(composerTargetForText("Could someone review this?")).toBe("room");
    expect(composerTargetForText("@agent run the tests")).toBe("dsh");
    expect(composerTargetForText("Please ask @agent to summarize")).toBe("dsh");
    expect(composerTargetForText("请@agent总结一下")).toBe("dsh");
    expect(composerTargetForText("@Agent run the tests")).toBe("room");
    expect(composerTargetForText("owner@agent.example")).toBe("room");
  });

  it("offers and inserts the lowercase Agent mention after a typed at-sign", () => {
    expect(shouldSuggestAgentMention("@")).toBe(true);
    expect(shouldSuggestAgentMention("请问@")).toBe(true);
    expect(shouldSuggestAgentMention("owner@")).toBe(false);
    expect(insertAgentMention("Please ask @")).toBe("Please ask @agent ");
  });

  it("renders one mention-driven composer without a target selector", () => {
    const html = renderComposer({ draft: "@" });
    expect(html).not.toContain("<select");
    expect(html).not.toContain("dsh-steer");
    expect(html).toContain("@agent");
    expect(html.match(/<textarea/g)).toHaveLength(1);
  });

  it("keeps resolved room and Agent submissions distinct on the wire", () => {

    expect(createComposerSubmission({ messageId: "m-1", roomId: "room-1", authorMemberId: "member-1", text: "ask @Alice", target: "room" })).toMatchObject({
      messageId: "m-1",
      target: "room",
      text: "ask @Alice",
    });
    expect(createComposerSubmission({ messageId: "m-2", roomId: "room-1", authorMemberId: "member-1", text: "run tests", target: "dsh" })).toMatchObject({ target: "dsh" });
  });

  it("rejects a steer submission when the caller lacks the capability", () => {
    expect(() => createComposerSubmission({ messageId: "m-3", roomId: "room-1", authorMemberId: "member-1", text: "stop", target: "dsh-steer", canSteer: false })).toThrow("steer");
  });
});
