import { describe, expect, it } from "vitest";
import { EventLedger } from "../../src/events.js";
import { CollabObservability } from "../../src/observability.js";

describe("CollabObservability", () => {
  it("correlates request IDs with event IDs and counts failures", () => {
    const ledger = new EventLedger();
    const metrics = new CollabObservability({ ledger, slowThresholdMs: 10 });
    ledger.append({ eventId: "event-1", roomId: "room-1", type: "human.message", actor: { memberId: "member-host", principalId: "host" }, createdAt: 1, payload: {} });
    metrics.recordRequest({ requestId: "req-1", status: 201, durationMs: 12, eventIds: ["event-1"] });
    metrics.recordRequest({ requestId: "req-2", status: 403, durationMs: 1 });
    expect(metrics.snapshot()).toEqual(expect.objectContaining({ requests: 2, errors: 1, events: 1, slowMessages: 1, correlations: [{ requestId: "req-1", eventIds: ["event-1"] }] }));
    metrics.dispose();
  });

  it("counts slow connection frames", () => {
    const metrics = new CollabObservability({ slowThresholdMs: 5 });
    metrics.recordConnectionFrame("conn-1", 6);
    metrics.recordConnectionFrame("conn-1", 1);
    expect(metrics.snapshot()).toMatchObject({ connectionFrames: 2, slowConnections: 1 });
  });
});
