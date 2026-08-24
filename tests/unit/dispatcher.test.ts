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
  const ledger = new EventLedger();
  return { dispatcher: new AgentDispatcher({ rooms, ledger, agent }), rooms, ledger };
}

function request(messageId: string, text: string, target: MessageTarget = "dsh"): AgentRequest {
  const message = classifyMessage({
    messageId,
    roomId: "room-1",
    authorMemberId: "member-alice",
    text,
    target,
  });
  if (message.kind !== "agent-request") throw new Error("test fixture did not create an AgentRequest");
  return message;
}

describe("AgentDispatcher", () => {
  it("queues a request and delivers it to the one host session", async () => {
    const calls: unknown[] = [];
    const { dispatcher } = createDispatcher({
      followup(input) {
        calls.push(input);
      },
      steer() {},
      cancel() {},
    });

    const queued = await dispatcher.submit({ principalId: "alice", message: request("message-1", "Run tests") });
    expect(queued).toMatchObject({
      requestId: "message-1",
      hostSessionId: "session-host",
      status: "queued",
    });

    const running = await dispatcher.drainOne();
    expect(running).toMatchObject({ requestId: "message-1", status: "running" });
    expect(calls).toEqual([expect.objectContaining({
      requestId: "message-1",
      roomId: "room-1",
      hostSessionId: "session-host",
      text: "Run tests",
    })]);
  });

  it("routes requests from multiple participants to the same host session", async () => {
    const calls: Array<{ authorMemberId: string; hostSessionId: string }> = [];
    const { dispatcher, rooms } = createDispatcher({
      followup(input) {
        calls.push({ authorMemberId: input.authorMemberId, hostSessionId: input.hostSessionId });
      },
      steer() {},
      cancel() {},
    });
    rooms.addMember("room-1", {
      memberId: "member-bob",
      principalId: "bob",
      displayName: "Bob",
      now: 3,
    });

    await dispatcher.submit({ principalId: "alice", message: request("message-alice", "Alice request") });
    await dispatcher.submit({
      principalId: "bob",
      message: {
        ...request("message-bob", "Bob request"),
        authorMemberId: "member-bob",
      },
    });
    await dispatcher.drainOne();
    await dispatcher.complete("message-alice");
    await dispatcher.drainOne();

    expect(calls).toEqual([
      { authorMemberId: "member-alice", hostSessionId: "session-host" },
      { authorMemberId: "member-bob", hostSessionId: "session-host" },
    ]);
  });

  it("keeps a second request queued while the first request is running", async () => {
    const calls: string[] = [];
    const { dispatcher } = createDispatcher({
      followup(input) {
        calls.push(input.requestId);
      },
      steer() {},
      cancel() {},
    });

    await dispatcher.submit({ principalId: "alice", message: request("message-1", "First") });
    await dispatcher.submit({ principalId: "alice", message: request("message-2", "Second") });
    await dispatcher.drainOne();
    expect(await dispatcher.drainOne()).toBeUndefined();
    expect(calls).toEqual(["message-1"]);

    await dispatcher.complete("message-1");
    const second = await dispatcher.drainOne();
    expect(second).toMatchObject({ requestId: "message-2", status: "running" });
    expect(calls).toEqual(["message-1", "message-2"]);
  });

  it("treats retrying the same request as idempotent", async () => {
    const { dispatcher } = createDispatcher({ followup() {}, steer() {}, cancel() {} });
    const message = request("message-1", "Retry me");

    const first = await dispatcher.submit({ principalId: "alice", message });
    const retry = await dispatcher.submit({ principalId: "alice", message });

    expect(retry).toEqual(first);
    expect(dispatcher.queued()).toHaveLength(1);
  });

  it("does not allow a participant to smuggle a steer into the queue", async () => {
    const calls: string[] = [];
    const { dispatcher } = createDispatcher({
      followup(input) {
        calls.push(input.requestId);
      },
      steer(input) {
        calls.push(input.requestId);
      },
      cancel() {},
    });

    const steer = request("message-1", "Change direction", "dsh-steer");
    await expect(dispatcher.submit({ principalId: "alice", message: steer })).rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
    expect(dispatcher.queued()).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("publishes Host Agent output before completing the request", async () => {
    const { dispatcher, ledger } = createDispatcher({
      followup() {}, steer() {}, cancel() {},
      whenIdle: async () => ({ text: "COLLAB_AGENT_OUTPUT" }),
    });
    await dispatcher.submit({ principalId: "alice", message: request("message-output", "Reply once") });

    await dispatcher.processQueue();

    expect(ledger.readAfter("room-1", 0).slice(-2)).toMatchObject([
      { type: "agent.state.changed", actor: { memberId: "member-host", principalId: "host" }, payload: { requestId: "message-output", state: "output", text: "COLLAB_AGENT_OUTPUT" } },
      { type: "agent.request.completed", payload: { requestId: "message-output" } },
    ]);
  });

  it("rechecks membership before delivering a queued request", async () => {
    const calls: string[] = [];
    const { dispatcher, rooms } = createDispatcher({
      followup(input) {
        calls.push(input.requestId);
      },
      steer() {},
      cancel() {},
    });

    await dispatcher.submit({ principalId: "alice", message: request("message-1", "Run later") });
    rooms.setMemberStatus("room-1", "member-alice", "suspended");

    await expect(dispatcher.drainOne()).rejects.toMatchObject({ code: "MEMBER_INACTIVE" });
    expect(calls).toEqual([]);
  });
});
