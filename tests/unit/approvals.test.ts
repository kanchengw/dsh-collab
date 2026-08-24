import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../../src/approvals.js";
import { EventLedger } from "../../src/events.js";
import { RoomStore } from "../../src/room.js";

function setup(answerer = true) {
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Release", hostDisplayName: "Host", now: 1 });
  rooms.addMember("room-1", { memberId: "member-alice", principalId: "alice", displayName: "Alice", now: 2 });
  return new ApprovalStore({ rooms, ledger: new EventLedger(), answerer: answerer ? {} : undefined });
}

function request(store: ApprovalStore, approvalId = "approval-1", now = 10) {
  return store.request({
    approvalId,
    roomId: "room-1",
    requesterPrincipalId: "host",
    toolName: "bash",
    reason: "Run release script",
    expiresAt: 100,
    now,
  });
}

describe("ApprovalStore", () => {
  it("projects a host-owned request and allows one idempotent decision", () => {
    const store = setup();
    const created = request(store);
    expect(created).toMatchObject({ state: "pending", hostSessionId: "session-host", requesterMemberId: "member-host" });

    const decided = store.decide({ approvalId: "approval-1", principalId: "host", outcome: "allowed-once", now: 20 });
    expect(decided).toMatchObject({ state: "decided", outcome: "allowed-once", decidedByMemberId: "member-host" });
    expect(store.decide({ approvalId: "approval-1", principalId: "host", outcome: "allowed-once", now: 21 })).toEqual(decided);
    expect(() => store.decide({ approvalId: "approval-1", principalId: "host", outcome: "rejected", now: 22 })).toThrow("already decided");
  });

  it("rejects participant decisions and expires pending requests", () => {
    const store = setup();
    request(store, "approval-expiring", 10);
    expect(() => store.decide({ approvalId: "approval-expiring", principalId: "alice", outcome: "allowed-once", now: 20 }))
      .toThrow("not allowed");
    expect(store.get("approval-expiring", 100)).toMatchObject({ state: "expired", outcome: "unavailable" });
    expect(() => store.decide({ approvalId: "approval-expiring", principalId: "host", outcome: "allowed-once", now: 100 }))
      .toThrow("expired");
  });

  it("fails closed when no answerer is available", () => {
    const store = setup(false);
    expect(request(store, "approval-unavailable")).toMatchObject({ state: "decided", outcome: "unavailable" });
  });

  it("is idempotent for duplicate request payloads and rejects conflicts", () => {
    const store = setup();
    const first = request(store, "approval-replay");
    expect(request(store, "approval-replay")).toEqual(first);
    expect(() => store.request({ approvalId: "approval-replay", roomId: "room-1", requesterPrincipalId: "host", toolName: "rm", reason: "Different", expiresAt: 100, now: 10 }))
      .toThrow("already used");
  });
});
