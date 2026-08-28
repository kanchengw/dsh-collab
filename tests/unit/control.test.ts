import { describe, expect, it } from "vitest";
import { EventLedger } from "../../src/events.js";
import { AgentDispatcher } from "../../src/dispatcher.js";
import { classifyMessage } from "../../src/messages.js";
import { RoomStore } from "../../src/room.js";
import type { AgentRequest, HostAgentPort, MessageTarget } from "../../src/types.js";

function createDispatcher(agent: HostAgentPort) {
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
  return {
    dispatcher: new AgentDispatcher({ rooms, ledger: new EventLedger(), agent }),
    rooms,
  };
}

function request(
  messageId: string,
  text: string,
  authorMemberId: string,
  target: MessageTarget,
): AgentRequest {
  const message = classifyMessage({
    messageId,
    roomId: "room-1",
    authorMemberId,
    text,
    target,
  });
  if (message.kind !== "agent-request") throw new Error("test fixture did not create an AgentRequest");
  return message;
}

describe("AgentDispatcher control", () => {
  it("sends an explicit Host steer through the steer port", async () => {
    const calls: string[] = [];
    const { dispatcher } = createDispatcher({
      followup() {},
      steer(input) {
        calls.push(input.requestId);
      },
      cancel() {},
    });

    await dispatcher.submit({
      principalId: "host",
      message: request("message-1", "Use staging", "member-host", "dsh-steer"),
    });
    await dispatcher.drainOne();

    expect(calls).toEqual(["message-1"]);
    expect(dispatcher.get("message-1")).toMatchObject({ status: "running", deliveryMode: "steer" });
  });

  it("cancels the active request while keeping queued requests", async () => {
    const cancelCalls: boolean[] = [];
    const { dispatcher } = createDispatcher({
      followup() {},
      steer() {},
      cancel(input) {
        cancelCalls.push(input.keepInbox);
      },
    });
    await dispatcher.submit({ principalId: "alice", message: request("message-1", "First", "member-alice", "dsh") });
    await dispatcher.submit({ principalId: "alice", message: request("message-2", "Second", "member-alice", "dsh") });
    await dispatcher.drainOne();

    const cancelled = await dispatcher.cancel({ roomId: "room-1", principalId: "host", requestId: "message-1", keepInbox: true });
    expect(cancelled).toMatchObject({ requestId: "message-1", status: "cancelled" });
    expect(dispatcher.get("message-2")).toMatchObject({ status: "queued" });
    expect(dispatcher.queued()).toHaveLength(1);
    expect(cancelCalls).toEqual([true]);
  });

  it("cancels the active request and clears queued requests when keepInbox is false", async () => {
    const { dispatcher } = createDispatcher({ followup() {}, steer() {}, cancel() {} });
    await dispatcher.submit({ principalId: "alice", message: request("message-1", "First", "member-alice", "dsh") });
    await dispatcher.submit({ principalId: "alice", message: request("message-2", "Second", "member-alice", "dsh") });
    await dispatcher.drainOne();

    await dispatcher.cancel({ roomId: "room-1", principalId: "host", requestId: "message-1", keepInbox: false });

    expect(dispatcher.get("message-1")).toMatchObject({ status: "cancelled" });
    expect(dispatcher.get("message-2")).toMatchObject({ status: "cancelled" });
    expect(dispatcher.queued()).toHaveLength(0);
  });

  it("keeps other rooms queued when clearing the active room inbox", async () => {
    const { dispatcher, rooms } = createDispatcher({ followup() {}, steer() {}, cancel() {} });
    rooms.createRoom({
      roomId: "room-2",
      hostId: "host",
      hostSessionId: "session-room-2",
      title: "Other room",
      hostDisplayName: "Host",
      now: 3,
    });
    rooms.addMember("room-2", {
      memberId: "member-bob",
      principalId: "bob",
      displayName: "Bob",
      now: 4,
    });
    await dispatcher.submit({ principalId: "alice", message: request("message-1", "Active", "member-alice", "dsh") });
    await dispatcher.submit({ principalId: "alice", message: request("message-2", "Same room", "member-alice", "dsh") });
    await dispatcher.submit({
      principalId: "bob",
      message: { ...request("message-3", "Other room", "member-bob", "dsh"), roomId: "room-2" },
    });
    await dispatcher.drainOne();

    await dispatcher.cancel({ roomId: "room-1", principalId: "host", requestId: "message-1", keepInbox: false });

    expect(dispatcher.get("message-2")?.status).toBe("cancelled");
    expect(dispatcher.get("message-3")?.status).toBe("queued");
    expect(dispatcher.queued()).toEqual([expect.objectContaining({ requestId: "message-3", roomId: "room-2" })]);
  });

  it("does not let a participant cancel the Host request", async () => {
    const { dispatcher } = createDispatcher({ followup() {}, steer() {}, cancel() {} });
    await dispatcher.submit({ principalId: "alice", message: request("message-1", "First", "member-alice", "dsh") });
    await dispatcher.drainOne();

    await expect(dispatcher.cancel({ roomId: "room-1", principalId: "alice", requestId: "message-1", keepInbox: true }))
      .rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
    expect(dispatcher.get("message-1")).toMatchObject({ status: "running" });
  });
});
