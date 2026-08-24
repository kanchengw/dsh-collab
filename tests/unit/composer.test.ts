import { describe, expect, it } from "vitest";
import { createComposerSubmission, getComposerTargets, renderComposer, type ComposerTarget } from "../../src/ui.js";

describe("collab composer target selector", () => {
  it("keeps human room messages separate from Agent requests", () => {
    expect(getComposerTargets(false)).toEqual(["room", "dsh"]);
    expect(getComposerTargets(true)).toEqual(["room", "dsh", "dsh-steer"]);

    expect(createComposerSubmission({ messageId: "m-1", roomId: "room-1", authorMemberId: "member-1", text: "ask @Alice", target: "room" })).toMatchObject({
      messageId: "m-1",
      target: "room",
      text: "ask @Alice",
    });
    expect(createComposerSubmission({ messageId: "m-2", roomId: "room-1", authorMemberId: "member-1", text: "run tests", target: "dsh" })).toMatchObject({ target: "dsh" });
  });

  it("does not render steer as available without permission", () => {
    const html = renderComposer({ target: "room", canSteer: false, draft: "hello" });
    expect(html).toContain('value="room"');
    expect(html).toContain('value="dsh"');
    expect(html).not.toContain('value="dsh-steer"');
    expect(html).toContain("hello");
  });

  it("rejects a steer submission when the caller lacks the capability", () => {
    expect(() => createComposerSubmission({ messageId: "m-3", roomId: "room-1", authorMemberId: "member-1", text: "stop", target: "dsh-steer", canSteer: false })).toThrow("steer");
  });
});
