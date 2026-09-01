import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../../src/approvals.js";
import { AgentDispatcher } from "../../src/dispatcher.js";
import { EventLedger } from "../../src/events.js";
import { CollabRuntime } from "../../src/runtime.js";
import { RoomStore } from "../../src/room.js";
import { classifyMessage } from "../../src/messages.js";
import type { AgentRequest, HostAgentPort } from "../../src/types.js";

const agent: HostAgentPort = { followup() {}, steer() {}, cancel() {} };

function request(messageId: string): AgentRequest {
  const message = classifyMessage({ messageId, roomId: "room-1", authorMemberId: "member-host", text: messageId, target: "dsh" });
  if (message.kind !== "agent-request") throw new Error("test fixture did not create an AgentRequest");
  return message;
}

describe("CollabRuntime snapshot", () => {
  it("restores room, ledger, dispatcher, approvals, output, and cursor state", async () => {
    const rooms = new RoomStore();
    rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Release", hostDisplayName: "Host", now: 1 });
    const ledger = new EventLedger();
    const dispatcher = new AgentDispatcher({ rooms, ledger, agent });
    const approvals = new ApprovalStore({ rooms, ledger, answerer: {} });
    await dispatcher.submit({ principalId: "host", message: request("request-1") });
    await dispatcher.submit({ principalId: "host", message: request("request-2") });
    await dispatcher.drainOne();
    await dispatcher.complete("request-1");
    await dispatcher.drainOne();
    approvals.request({ approvalId: "approval-1", roomId: "room-1", requesterPrincipalId: "host", toolName: "bash", reason: "release", expiresAt: 100, now: 10 });
    ledger.append({ eventId: "output-1", roomId: "room-1", type: "agent.state.changed", actor: { memberId: "member-host", principalId: "host" }, createdAt: 11, payload: { state: "output", text: "done" } });

    const snapshot = new CollabRuntime({ rooms, ledger, dispatcher, approvals }).snapshot();
    const restored = CollabRuntime.fromSnapshot({ snapshot, agent, answerer: {} });

    expect(restored.rooms.getRoom("room-1")).toMatchObject({ hostSessionId: "session-host" });
    expect(restored.dispatcher.get("request-1")).toMatchObject({ status: "completed" });
    expect(restored.dispatcher.get("request-2")).toMatchObject({ status: "running" });
    expect(restored.approvals?.get("approval-1")).toMatchObject({ state: "pending" });
    expect(restored.ledger.readAfter("room-1", 0).at(-1)).toMatchObject({ eventId: "output-1", seq: snapshot.ledger.rooms[0]?.events.length });
    const cursor = snapshot.ledger.rooms[0]!.events.length - 1;
    expect(restored.ledger.readAfter("room-1", cursor).map((event) => event.eventId)).toEqual(["output-1"]);
  });

  it("rejects an unsupported runtime snapshot version", () => {
    expect(() => CollabRuntime.fromSnapshot({ snapshot: { version: 99 } as never, agent })).toThrow("snapshot");
  });
});
