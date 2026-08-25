import { describe, expect, it } from "vitest";
import { projectTimeline, renderTimeline, type TimelineItem } from "../../src/ui.js";
import type { RoomEvent } from "../../src/types.js";

function event(partial: Partial<RoomEvent> & Pick<RoomEvent, "eventId" | "seq" | "type" | "payload">): RoomEvent {
  return {
    roomId: "room-1",
    actor: { memberId: "member-1", principalId: "alice" },
    createdAt: partial.seq,
    ...partial,
  };
}

describe("collab timeline projection", () => {
  it("projects human messages and consolidates Agent request state", () => {
    const items = projectTimeline([
      event({ eventId: "h-1", seq: 1, type: "human.message", payload: { text: "hello", authorMemberId: "member-1" } }),
      event({ eventId: "r-1", seq: 2, type: "agent.request.created", payload: { requestId: "req-1" } }),
      event({ eventId: "r-2", seq: 3, type: "agent.request.queued", payload: { requestId: "req-1" } }),
      event({ eventId: "r-3", seq: 4, type: "agent.request.claimed", payload: { requestId: "req-1" } }),
      event({ eventId: "r-4", seq: 5, type: "agent.request.completed", payload: { requestId: "req-1" } }),
    ]);

    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ kind: "human", text: "hello" });
    expect(items[1]).toMatchObject({ kind: "agent", requestId: "req-1", status: "completed" });
    expect(renderTimeline(items)).toContain('data-status="completed"');
  });

  it("does not duplicate event IDs and exposes Agent output state", () => {
    const output = projectTimeline([
      event({ eventId: "out-1", seq: 1, type: "agent.state.changed", payload: { state: "output", text: "done", requestId: "req-1" } }),
      event({ eventId: "out-1", seq: 1, type: "agent.state.changed", payload: { state: "output", text: "done", requestId: "req-1" } }),
    ]);
    expect(output).toEqual([expect.objectContaining({ kind: "agent", state: "output", text: "done", requestId: "req-1" })]);
  });

  it("projects a safe Host Agent failure into the room timeline", () => {
    const failed = projectTimeline([
      event({ eventId: "failed-1", seq: 1, type: "agent.request.failed", payload: { requestId: "req-1", error: "Host Agent failed: MISSING_CREDENTIAL" } }),
    ]);

    expect(failed).toEqual([expect.objectContaining({ status: "failed", text: "Host Agent failed: MISSING_CREDENTIAL" })]);
  });
});
