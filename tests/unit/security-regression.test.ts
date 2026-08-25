import { describe, expect, it } from "vitest";
import { ApprovalStore } from "../../src/approvals.js";
import { CollabGateway } from "../../src/gateway.js";
import { EventLedger } from "../../src/events.js";
import { InviteStore } from "../../src/invites.js";
import { classifyMessage } from "../../src/messages.js";
import { RoomStore } from "../../src/room.js";
import type { HostAgentPort } from "../../src/types.js";

function setup() {
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-host", title: "Release", hostDisplayName: "Host", now: 1 });
  rooms.createRoom({ roomId: "room-2", hostId: "other-host", hostSessionId: "session-other", title: "Other", hostDisplayName: "Other", now: 1 });
  const ledger = new EventLedger();
  const invites = new InviteStore(rooms, { tokenFactory: () => "invite-token" });
  const agent: HostAgentPort = { followup() {}, steer() {}, cancel() {} };
  return { rooms, ledger, gateway: new CollabGateway({ rooms, ledger, invites, agent, tokenFactory: () => "room-token", now: () => 10 }) };
}

async function participantToken(gateway: CollabGateway): Promise<string> {
  const invite = await gateway.handle({ method: "POST", path: "/v1/rooms/room-1/invites", auth: { principalId: "host" }, body: { inviteId: "invite-1", expiresAt: 100 } });
  const joined = await gateway.handle({ method: "POST", path: "/v1/rooms/room-1/join", body: { inviteId: "invite-1", token: (invite.body as { token: string }).token, memberId: "member-bob", displayName: "Bob" } });
  return (joined.body as { roomToken: string }).roomToken;
}

describe("security regression", () => {
  it("keeps room scope and author binding independent from client fields", async () => {
    const { gateway, ledger } = setup();
    const token = await participantToken(gateway);
    const crossRoom = await gateway.handle({ method: "GET", path: "/v1/rooms/room-2/snapshot", headers: { authorization: `Bearer ${token}` } });
    expect(crossRoom.status).toBe(403);
    const message = await gateway.handle({ method: "POST", path: "/v1/rooms/room-1/messages", headers: { authorization: `Bearer ${token}` }, body: { clientMessageId: "forged", authorMemberId: "member-host", text: "hello" } });
    expect(message.status).toBe(201);
    const replayConflict = await gateway.handle({ method: "POST", path: "/v1/rooms/room-1/messages", headers: { authorization: `Bearer ${token}` }, body: { clientMessageId: "forged", text: "changed" } });
    expect(replayConflict.status).toBe(409);
    expect(ledger.readAfter("room-1", 0).at(-1)?.actor).toEqual({ memberId: "member-bob", principalId: "invite:invite-1" });
  });

  it("rejects participant steer and approval decisions", async () => {
    const { gateway, rooms, ledger } = setup();
    const token = await participantToken(gateway);
    const steer = await gateway.handle({ method: "POST", path: "/v1/rooms/room-1/messages", headers: { authorization: `Bearer ${token}` }, body: { clientMessageId: "steer", target: "dsh-steer", text: "interrupt" } });
    expect(steer.status).toBe(403);
    const approvals = new ApprovalStore({ rooms, ledger, answerer: {} });
    approvals.request({ approvalId: "approval-1", roomId: "room-1", requesterPrincipalId: "host", toolName: "bash", reason: "release", expiresAt: 100, now: 10 });
    expect(() => approvals.decide({ approvalId: "approval-1", principalId: "invite:invite-1", outcome: "allowed-once", now: 11 })).toThrow("not allowed");
  });

  it("bounds context references before mapping untrusted input", () => {
    expect(() => classifyMessage({ messageId: "message-1", roomId: "room-1", authorMemberId: "member-1", text: "hello", target: "dsh", contextRefs: Array.from({ length: 65 }, (_, index) => `ref-${String(index)}`) }))
      .toThrow("too many context references");
  });
});
