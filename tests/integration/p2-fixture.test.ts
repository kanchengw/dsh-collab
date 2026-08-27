import { describe, expect, it } from "vitest";
import { renderP2Fixture, validateP2Fixture } from "../../src/ui-fixture.js";

describe("P2 runtime fixture", () => {
  it("combines participant shell, composer, and timeline into a safe HTML document", () => {
    const html = renderP2Fixture({
      roomId: "room-1",
      roomTitle: "Release",
      hostDisplayName: "Host",
      connection: "online",
      memberCount: 2,
      composer: { draft: "hello" },
      timeline: [{ eventId: "e-1", seq: 1, kind: "human", authorMemberId: "member-1", text: "hello" }],
    });

    expect(validateP2Fixture(html)).toEqual({ shell: true, composer: true, timeline: true, unsafeScript: false });
    expect(html).toContain("<!doctype html>");
    expect(html).not.toContain("<script>");
  });
});
