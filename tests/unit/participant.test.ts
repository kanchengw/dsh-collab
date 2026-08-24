import { describe, expect, it, vi } from "vitest";
import { ParticipantSessionAdapter, type ParticipantGatewayTransport } from "../../src/participant.js";
import { resolveRoomSession } from "../../src/role.js";

const context = resolveRoomSession({ token: "room-token", evidence: {
  kind: "remote-token", roomId: "room-1", gatewayUrl: "http://127.0.0.1:4310",
  claims: { roomId: "room-1", memberId: "member-2", principalId: "person-2", role: "participant", expiresAt: 9999 },
} });

describe("participant session adapter", () => {
  it("routes snapshot and messages to the remote gateway", async () => {
    const calls: unknown[] = [];
    const transport: ParticipantGatewayTransport = { request: async (input) => { calls.push(input); return { status: 200, body: { ok: true } }; } };
    const adapter = new ParticipantSessionAdapter(context, transport, "connection-2");
    await adapter.snapshot();
    await adapter.sendMessage({ clientMessageId: "m-1", text: "hello", target: "room" });
    expect(calls).toMatchObject([
      { method: "GET", path: "/v1/rooms/room-1/snapshot", token: "room-token" },
      { method: "POST", path: "/v1/rooms/room-1/messages", token: "room-token", body: { clientMessageId: "m-1", target: "room" } },
    ]);
  });
  it("only accepts participant context and owns no local dispatcher", () => {
    expect(() => new ParticipantSessionAdapter({ ...context, role: "host", remoteGatewayUrl: undefined, token: undefined }, { request: vi.fn() }, "connection-1")).toThrow("participant");
    expect("dispatcher" in new ParticipantSessionAdapter(context, { request: vi.fn() }, "connection-2")).toBe(false);
  });
});
