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
  it("keeps the human-authored Agent request separate from Host Agent output", () => {
    const items = projectTimeline([
      event({ eventId: "h-1", seq: 1, type: "human.message", payload: { text: "hello", authorMemberId: "member-1" } }),
      event({ eventId: "r-1", seq: 2, type: "agent.request.created", payload: { requestId: "req-1", text: "@agent summarize" } }),
      event({ eventId: "r-2", seq: 3, type: "agent.request.queued", payload: { requestId: "req-1" } }),
      event({ eventId: "r-3", seq: 4, type: "agent.request.claimed", payload: { requestId: "req-1" } }),
      event({ eventId: "out-1", seq: 5, type: "agent.state.changed", actor: { memberId: "member-host", principalId: "host" }, payload: { requestId: "req-1", state: "output", text: "Summary" } }),
      event({ eventId: "r-4", seq: 6, type: "agent.request.completed", payload: { requestId: "req-1" } }),
    ]);

    expect(items).toHaveLength(3);
    expect(items[0]).toMatchObject({ kind: "human", text: "hello" });
    expect(items[0]).toMatchObject({ contextEventId: "h-1" });
    expect(items[1]).toMatchObject({ kind: "agent-request", authorMemberId: "member-1", requestId: "req-1", status: "completed", text: "@agent summarize", contextEventId: "r-1" });
    expect(items[2]).toMatchObject({ kind: "agent", authorMemberId: "member-host", requestId: "req-1", state: "output", text: "Summary", contextEventId: "out-1" });
    expect(renderTimeline(items)).toContain('data-status="completed"');
  });

  it("does not duplicate event IDs and exposes Agent output state", () => {
    const output = projectTimeline([
      event({ eventId: "out-1", seq: 1, type: "agent.state.changed", payload: { state: "output", text: "done", requestId: "req-1" } }),
      event({ eventId: "out-1", seq: 1, type: "agent.state.changed", payload: { state: "output", text: "done", requestId: "req-1" } }),
    ]);
    expect(output).toEqual([expect.objectContaining({ kind: "agent", state: "output", text: "done", requestId: "req-1" })]);
  });

  it("projects one replaceable streaming Agent item until durable output arrives", () => {
    const request = event({ eventId: "request-1", seq: 1, type: "agent.request.created", payload: { requestId: "req-1", text: "@agent reply" } });
    const active = { kind: "agent-output" as const, roomId: "room-1", requestId: "req-1", text: "partial **answer", streaming: true };

    expect(projectTimeline([request], [active])).toEqual([
      expect.objectContaining({ kind: "agent-request", requestId: "req-1" }),
      expect.objectContaining({ eventId: "stream:req-1", kind: "agent", requestId: "req-1", text: "partial **answer", streaming: true }),
    ]);

    const durable = event({ eventId: "output-1", seq: 2, type: "agent.state.changed", payload: { requestId: "req-1", state: "output", text: "final **answer**" } });
    const settled = projectTimeline([request, durable], [active]);
    expect(settled.filter((item) => item.kind === "agent")).toEqual([
      expect.objectContaining({ eventId: "output-1", text: "final **answer**", streaming: false }),
    ]);
  });

  it("projects a safe Host Agent failure into the room timeline", () => {
    const failed = projectTimeline([
      event({ eventId: "failed-1", seq: 1, type: "agent.request.failed", payload: { requestId: "req-1", error: "Host Agent failed: MISSING_CREDENTIAL" } }),
    ]);

    expect(failed).toEqual([
      expect.objectContaining({ kind: "agent-request", status: "failed" }),
      expect.objectContaining({ kind: "agent", state: "failed", text: "Host Agent failed: MISSING_CREDENTIAL", contextEventId: "failed-1" }),
    ]);
  });

  it("exposes stable event IDs for quoting timeline messages", () => {
    const items = projectTimeline([
      event({ eventId: "human-1", seq: 1, type: "human.message", payload: { text: "Bring the logs" } }),
      event({ eventId: "output-1", seq: 2, type: "agent.state.changed", actor: { memberId: "member-host", principalId: "host" }, payload: { requestId: "req-1", state: "output", text: "Here are the logs" } }),
    ]);

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "human", contextEventId: "human-1" }),
      expect.objectContaining({ kind: "agent", contextEventId: "output-1" }),
    ]));
  });
});
