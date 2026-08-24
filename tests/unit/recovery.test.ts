import { describe, expect, it } from "vitest";
import { AgentDispatcher } from "../../src/dispatcher.js";
import { EventLedger } from "../../src/events.js";
import { RoomStore } from "../../src/room.js";
import { classifyMessage } from "../../src/messages.js";
import type { AgentRequest, HostAgentPort } from "../../src/types.js";

function roomStore() {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1",
    hostId: "host",
    hostSessionId: "session-host",
    title: "Release",
    hostDisplayName: "Host",
    now: 1,
  });
  rooms.addMember("room-1", {
    memberId: "member-alice",
    principalId: "alice",
    displayName: "Alice",
    now: 2,
  });
  return rooms;
}

function request(messageId: string): AgentRequest {
  const message = classifyMessage({
    messageId,
    roomId: "room-1",
    authorMemberId: "member-alice",
    text: messageId,
    target: "dsh",
  });
  if (message.kind !== "agent-request") throw new Error("test fixture did not create an AgentRequest");
  return message;
}

const noOpAgent: HostAgentPort = {
  followup() {},
  steer() {},
  cancel() {},
};

describe("P0 recovery", () => {
  it("restores room state without exposing mutable internal collections", () => {
    const rooms = roomStore();
    rooms.setMemberStatus("room-1", "member-alice", "suspended", 3);

    const restored = RoomStore.fromSnapshot(rooms.snapshot());
    expect(restored.getRoom("room-1")).toMatchObject({ revision: 3, state: "open" });
    expect(restored.listMembers("room-1")).toEqual([
      expect.objectContaining({ memberId: "member-host", status: "active" }),
      expect.objectContaining({ memberId: "member-alice", status: "suspended", revokedAt: undefined }),
    ]);

    const members = restored.listMembers("room-1");
    members[0]!.displayName = "forged";
    expect(restored.listMembers("room-1")[0]?.displayName).toBe("Host");
  });

  it("rejects an unsupported room snapshot version", () => {
    const rooms = roomStore();
    expect(() => RoomStore.fromSnapshot({ version: 99, rooms: [] } as never)).toThrow(/snapshot/i);
  });

  it("fails closed when an event snapshot contains an unknown type", () => {
    expect(() => EventLedger.fromSnapshot({
      version: 1,
      rooms: [{
        roomId: "room-1",
        events: [{
          eventId: "event-1",
          roomId: "room-1",
          seq: 1,
          type: "unknown.event",
          actor: { memberId: "member-host", principalId: "host" },
          createdAt: 1,
          payload: {},
        }],
      }],
    } as never)).toThrow(/event type/i);
  });

  it("does not redeliver a running request after dispatcher recovery", async () => {
    const rooms = roomStore();
    const ledger = new EventLedger();
    const calls: string[] = [];
    const agent: HostAgentPort = {
      followup(input) {
        calls.push(input.requestId);
      },
      steer() {},
      cancel() {},
    };
    const dispatcher = new AgentDispatcher({ rooms, ledger, agent });
    await dispatcher.submit({ principalId: "alice", message: request("message-1") });
    await dispatcher.submit({ principalId: "alice", message: request("message-2") });
    await dispatcher.drainOne();

    const restoredDispatcher = AgentDispatcher.fromSnapshot({
      rooms: RoomStore.fromSnapshot(rooms.snapshot()),
      ledger: EventLedger.fromSnapshot(ledger.snapshot()),
      agent,
      snapshot: dispatcher.snapshot(),
    });

    expect(restoredDispatcher.get("message-1")).toMatchObject({ status: "running" });
    expect(restoredDispatcher.get("message-2")).toMatchObject({ status: "queued" });
    expect(await restoredDispatcher.drainOne()).toBeUndefined();
    expect(calls).toEqual(["message-1"]);
  });

  it("restores a queued request and can drain it once the active request is reconciled", async () => {
    const rooms = roomStore();
    const ledger = new EventLedger();
    const dispatcher = new AgentDispatcher({ rooms, ledger, agent: noOpAgent });
    await dispatcher.submit({ principalId: "alice", message: request("message-1") });
    await dispatcher.submit({ principalId: "alice", message: request("message-2") });

    const restored = AgentDispatcher.fromSnapshot({
      rooms: RoomStore.fromSnapshot(rooms.snapshot()),
      ledger: EventLedger.fromSnapshot(ledger.snapshot()),
      agent: noOpAgent,
      snapshot: dispatcher.snapshot(),
    });

    const running = await restored.drainOne();
    expect(running).toMatchObject({ requestId: "message-1", status: "running" });
    await restored.complete("message-1");
    expect(await restored.drainOne()).toMatchObject({ requestId: "message-2", status: "running" });
  });
});
