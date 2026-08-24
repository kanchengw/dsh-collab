import { describe, expect, it } from "vitest";
import { CollabError } from "../../src/errors.js";
import { ResourceLimiter } from "../../src/limits.js";

describe("resource limits", () => {
  it("enforces room and member caps", () => {
    const limits = new ResourceLimiter({ maxRooms: 1, maxMembersPerRoom: 2 });
    limits.checkRooms(1);
    expect(() => limits.checkRooms(2)).toThrowError(CollabError);
    limits.checkMembers("room-1", 2);
    expect(() => limits.checkMembers("room-1", 3)).toThrow("member resource limit");
  });

  it("enforces connection, queue, output, and per-member message caps", () => {
    const limits = new ResourceLimiter({ maxConnectionsPerRoom: 1, maxQueuedRequestsPerRoom: 1, maxOutputBytes: 5, maxMessagesPerMemberPerWindow: 1, messageWindowMs: 100 });
    limits.acquireConnection("room-1");
    expect(() => limits.acquireConnection("room-1")).toThrow("connection resource limit");
    limits.releaseConnection("room-1");
    limits.checkQueue("room-1", 1);
    expect(() => limits.checkQueue("room-1", 2)).toThrow("queue resource limit");
    limits.consumeMessage("room-1", "member-1", 10);
    expect(() => limits.consumeMessage("room-1", "member-1", 11)).toThrow("message rate limit");
    limits.consumeMessage("room-1", "member-1", 111);
    limits.acceptOutput(5);
    expect(() => limits.acceptOutput(6)).toThrow("output resource limit");
  });
});
