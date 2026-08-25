import { describe, expect, it } from "vitest";
import { decodeCollabInvitation, encodeCollabInvitation } from "../../src/invitation.js";

describe("shareable Collab invitation", () => {
  it("carries every value a Participant needs without putting the token in a URL", () => {
    const encoded = encodeCollabInvitation({
      protocol: "dsh-collab.v1",
      type: "invite",
      gatewayEndpoint: "ws://192.168.1.20:4310/collab/",
      roomId: "room-1",
      inviteId: "invite-1",
      token: "invite-secret",
      expiresAt: 100,
    });

    expect(encoded.startsWith("{")).toBe(true);
    expect(decodeCollabInvitation(encoded)).toEqual({
      protocol: "dsh-collab.v1",
      type: "invite",
      gatewayEndpoint: "ws://192.168.1.20:4310/collab",
      roomId: "room-1",
      inviteId: "invite-1",
      token: "invite-secret",
      expiresAt: 100,
    });
  });

  it("rejects unsafe endpoints, wrong protocols, and incomplete invitations", () => {
    const valid = {
      protocol: "dsh-collab.v1",
      type: "invite",
      gatewayEndpoint: "wss://collab.example/collab",
      roomId: "room-1",
      inviteId: "invite-1",
      token: "invite-secret",
      expiresAt: 100,
    };

    expect(() => decodeCollabInvitation(JSON.stringify({ ...valid, protocol: "dsh-collab.v2" }))).toThrow("protocol");
    expect(() => decodeCollabInvitation(JSON.stringify({ ...valid, gatewayEndpoint: "ws://collab.example/collab" }))).toThrow("wss");
    expect(() => decodeCollabInvitation(JSON.stringify({ ...valid, token: "" }))).toThrow("token");
    expect(() => decodeCollabInvitation(JSON.stringify({ ...valid, expiresAt: -1 }))).toThrow("expiresAt");
    expect(() => decodeCollabInvitation("not json")).toThrow("invitation");
  });
});
