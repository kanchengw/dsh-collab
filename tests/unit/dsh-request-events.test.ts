import { describe, expect, it } from "vitest";
import { DshRequestEventTracker } from "../../src/dsh-request-events.js";

describe("DSH request event tracking", () => {
  it("marks a request claimed when an inbox splice replaces it with another message", () => {
    const tracker = new DshRequestEventTracker("request-1");

    tracker.apply({
      seq: 1,
      type: "agent/inbox/spliced",
      data: {
        target: "next-turn",
        start: 0,
        inserted: [{ id: "request-1" }],
      },
    });
    tracker.apply({
      seq: 2,
      type: "agent/inbox/spliced",
      data: {
        target: "next-turn",
        start: 0,
        removedCount: 1,
        inserted: [{ id: "request-2" }],
      },
    });
    tracker.apply({
      seq: 3,
      type: "turn/end",
      data: { reason: { kind: "blocked" } },
    });

    expect(tracker.result("Host Agent")).toEqual({
      error: "Host Agent request was blocked before execution",
    });
  });
});
