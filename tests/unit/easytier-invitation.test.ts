import { describe, expect, it } from "vitest";
import {
  COLLAB_INVITATION_PROTOCOL,
  decodeCollabInvitation,
  encodeCollabInvitation,
} from "../../src/invitation.js";
import { COLLAB_PROTOCOL } from "../../src/protocol.js";

describe("EasyTier invitation contract", () => {
  const base = {
    protocol: COLLAB_INVITATION_PROTOCOL,
    type: "invite" as const,
    gatewayEndpoint: "ws://10.231.0.1:4310/collab",
    roomId: "room-1",
    inviteId: "invite-1",
    token: "collab-room-token",
    expiresAt: 100,
  };

  it("uses a protocol old clients reject and keeps network credentials separate from Collab authorization", () => {
    expect(COLLAB_INVITATION_PROTOCOL).not.toBe(COLLAB_PROTOCOL);

    const encoded = encodeCollabInvitation({
      ...base,
      network: {
        mode: "easytier",
        version: 1,
        networkName: "dsh-collab-room-1",
        networkSecret: "overlay-network-secret",
        ownerVirtualAddress: "10.231.0.1",
        sharedNode: "tcp://shared.example.com:11010",
      },
    });

    expect(decodeCollabInvitation(encoded)).toEqual({
      ...base,
      network: {
        mode: "easytier",
        version: 1,
        networkName: "dsh-collab-room-1",
        networkSecret: "overlay-network-secret",
        ownerVirtualAddress: "10.231.0.1",
        sharedNode: "tcp://shared.example.com:11010",
      },
    });
  });

  it("supports versioned LAN and custom WSS descriptions without changing their endpoint", () => {
    for (const value of [
      {
        ...base,
        gatewayEndpoint: "ws://192.168.1.20:4310/collab",
        network: { mode: "lan" as const, version: 1 as const, endpoint: "ws://192.168.1.20:4310/collab/" },
      },
      {
        ...base,
        gatewayEndpoint: "wss://collab.example/collab",
        network: { mode: "custom-wss" as const, version: 1 as const, endpoint: "wss://collab.example/collab/" },
      },
    ]) {
      const decoded = decodeCollabInvitation(encodeCollabInvitation(value));
      expect(decoded.gatewayEndpoint).toBe(value.gatewayEndpoint);
      if (decoded.protocol !== COLLAB_INVITATION_PROTOCOL) throw new Error("expected versioned invitation");
      expect(decoded.network).toMatchObject({ mode: value.network.mode, version: 1, endpoint: value.gatewayEndpoint });
    }
  });

  it("rejects unknown versions, unknown modes, mismatched endpoints, and invalid EasyTier fields", () => {
    const valid = {
      ...base,
      network: {
        mode: "easytier",
        version: 1,
        networkName: "dsh-collab-room-1",
        networkSecret: "overlay-network-secret",
        ownerVirtualAddress: "10.231.0.1",
        sharedNode: "tcp://shared.example.com:11010",
      },
    };

    expect(() => decodeCollabInvitation(JSON.stringify({ ...valid, network: { ...valid.network, version: 2 } }))).toThrow("version");
    expect(() => decodeCollabInvitation(JSON.stringify({ ...valid, network: { ...valid.network, mode: "unknown" } }))).toThrow("mode");
    expect(() => decodeCollabInvitation(JSON.stringify({ ...valid, gatewayEndpoint: "ws://10.231.0.2:4310/collab" }))).toThrow("ownerVirtualAddress");
    expect(() => decodeCollabInvitation(JSON.stringify({ ...valid, network: { ...valid.network, sharedNode: "tcp://user:password@shared.example.com:11010" } }))).toThrow("sharedNode");
    expect(() => decodeCollabInvitation(JSON.stringify({ ...valid, network: { ...valid.network, networkName: "bad name" } }))).toThrow("networkName");
    expect(() => decodeCollabInvitation(JSON.stringify({ ...valid, network: { ...valid.network, networkSecret: "short" } }))).toThrow("networkSecret");

    const lan = {
      ...base,
      gatewayEndpoint: "ws://192.168.1.20:4310/collab",
      network: { mode: "lan", version: 1, endpoint: "ws://192.168.1.21:4310/collab" },
    };
    expect(() => decodeCollabInvitation(JSON.stringify(lan))).toThrow("gatewayEndpoint");
  });

  it("never echoes a rejected network secret in validation errors", () => {
    const secret = 'invalid"network-secret';
    const encoded = JSON.stringify({
      ...base,
      network: {
        mode: "easytier",
        version: 1,
        networkName: "dsh-collab-room-1",
        networkSecret: secret,
        ownerVirtualAddress: "10.231.0.1",
        sharedNode: "tcp://shared.example.com:11010",
      },
    });

    let validationError: unknown;
    try {
      decodeCollabInvitation(encoded);
    } catch (error) {
      validationError = error;
    }
    expect(validationError).toBeInstanceOf(Error);
    expect(String(validationError)).toContain("networkSecret");
    expect(String(validationError)).not.toContain(secret);
  });
});
