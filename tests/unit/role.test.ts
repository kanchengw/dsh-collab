import { describe, expect, it } from "vitest";
import { resolveRoomSession } from "../../src/role.js";

const claims = {
  roomId: "room-1",
  memberId: "member-2",
  principalId: "person-2",
  role: "participant" as const,
  expiresAt: 9999,
};

describe("room role resolver", () => {
  it("selects host from trusted local session ownership", () => {
    expect(resolveRoomSession({ evidence: {
      kind: "local-session", roomId: "room-1", sessionId: "session-1", owned: true,
    } })).toMatchObject({ roomId: "room-1", role: "host", localSessionId: "session-1" });
  });

  it("selects participant from a verified remote room token", () => {
    expect(resolveRoomSession({ token: "room-token", evidence: {
      kind: "remote-token", roomId: "room-1", gatewayUrl: "http://127.0.0.1:4310", claims,
    } })).toMatchObject({ role: "participant", remoteGatewayUrl: "http://127.0.0.1:4310", token: "room-token" });
  });

  it("rejects a client-declared host role over participant evidence", () => {
    expect(() => resolveRoomSession({ token: "room-token", requestedRole: "host", evidence: {
      kind: "remote-token", roomId: "room-1", gatewayUrl: "http://127.0.0.1:4310", claims,
    } })).toThrow("does not match");
  });

  it("fails closed when evidence is absent or token is not for this room", () => {
    expect(() => resolveRoomSession({})).toThrow("evidence");
    expect(() => resolveRoomSession({ token: "room-token", evidence: {
      kind: "remote-token", roomId: "room-1", gatewayUrl: "http://127.0.0.1:4310", claims: { ...claims, roomId: "room-2" },
    } })).toThrow("participant token");
  });
});
