import { describe, expect, it } from "vitest";
import { defaultCollabSettings, DSH_COLLAB_PARTICIPANT_SCHEMA, renderCollabSettings, validateDshCollabParticipantSettings, validateCollabSettings, validateDshCollabPersistedSettings, type CollabSettings } from "../../src/settings.js";
import { detectPrivateNetworkAddress } from "../../src/network-address.js";

describe("collab settings", () => {
  it("provides safe defaults and separates host and participant settings", () => {
    expect(defaultCollabSettings.exposeMode).toBe("loopback");
    expect(defaultCollabSettings.gatewayPort).toBe(4310);
    expect(defaultCollabSettings.tokenTtlMs).toBe(24 * 60 * 60 * 1000);
    const html = renderCollabSettings(defaultCollabSettings);
    expect(html).toContain('data-settings-namespace="collab"');
    expect(html).toContain("Host gateway");
    expect(html).not.toContain("Invitation address");
    expect(html).not.toContain('name="gatewayPort"');
    expect(html).not.toContain('name="advertisedEndpoint"');
    expect(html).toContain("Not configured");
    expect(html.indexOf("Connection method")).toBeGreaterThan(html.indexOf("<details"));
    expect(html).toContain('name="tokenTtl"');
    expect(html).toContain("1 day");
    expect(html).toContain("Never");
    expect(html).toContain("Advanced options");
    expect(html).toContain("Security");
    expect(html).toContain("Chat");
    expect(html).toContain("LAN settings");
    expect(html).toContain('name="maxQueue" type="number" min="0" value="5"');
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).not.toContain(">Loopback<");
    expect(html).not.toContain("participantGatewayUrl");
  });

  it("warns before non-loopback exposure and rejects unsafe values", () => {
    const settings: CollabSettings = { ...defaultCollabSettings, exposeMode: "network", gatewayHost: "0.0.0.0", advertisedEndpoint: "ws://192.168.1.20:4310/collab" };
    expect(renderCollabSettings(settings)).toContain("trusted network");
    expect(() => validateCollabSettings({ ...settings, gatewayPort: 70000 })).toThrow("gatewayPort");
    expect(() => validateCollabSettings({ ...settings, tokenTtlMs: 0 })).toThrow("tokenTtlMs");
    expect(() => validateCollabSettings({ ...settings, tokenTtlMs: null })).not.toThrow();
  });

  it("validates the endpoint Host puts in invitations", () => {
    const gateway = { gatewayHost: "127.0.0.1" as const, gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" };
    expect(() => validateDshCollabPersistedSettings({ gateway })).not.toThrow();
    expect(() => validateDshCollabPersistedSettings({ gateway: { ...gateway, advertisedEndpoint: "wss://host.example/collab" } })).not.toThrow();
    expect(() => validateDshCollabPersistedSettings({ gateway: { gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "" } })).not.toThrow();
    expect(() => validateDshCollabPersistedSettings({ gateway: { ...gateway, advertisedEndpoint: "ws://192.168.1.20:4310/collab" } })).toThrow("loopback mode");
    expect(() => validateDshCollabPersistedSettings({ gateway: { gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "ws://127.0.0.1:4310/collab" } })).toThrow("network mode");
    expect(() => validateDshCollabPersistedSettings({ gateway: { ...gateway, gatewayPort: 0 } })).toThrow("gatewayPort");

    for (const advertisedEndpoint of [
      "not a URL",
      "ws://host.example/collab",
      "wss://user:pass@host.example/collab",
      "wss://host.example/collab?room=one",
      "wss://host.example/collab#invite",
      "wss://host.example/not-collab",
    ]) {
      expect(() => validateDshCollabPersistedSettings({ gateway: { ...gateway, advertisedEndpoint } })).toThrow("gatewayEndpoint");
      expect(() => validateCollabSettings({ ...defaultCollabSettings, advertisedEndpoint })).toThrow("gatewayEndpoint");
    }
  });

  it("detects a usable LAN address with home-network priority", () => {
    expect(detectPrivateNetworkAddress({
      vpn: [{ address: "10.8.0.2", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "10.8.0.2/24" }],
      lan: [{ address: "192.168.1.3", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: false, cidr: "192.168.1.3/24" }],
      loopback: [{ address: "192.168.1.99", netmask: "255.255.255.0", family: "IPv4", mac: "", internal: true, cidr: "192.168.1.99/24" }],
    })).toBe("192.168.1.3");
  });

  it("validates hidden Participant resume state at the DSH persistence boundary", () => {
    expect(DSH_COLLAB_PARTICIPANT_SCHEMA({})).toEqual({ joinedRooms: [] });
    expect(() => validateDshCollabParticipantSettings({ resume: { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" } })).not.toThrow();
    expect(() => validateDshCollabParticipantSettings({ resume: { gatewayEndpoint: "ws://public.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" } })).toThrow("gatewayEndpoint");
    expect(() => validateDshCollabParticipantSettings({ resume: { gatewayEndpoint: "wss://collab.example/collab", roomId: "", memberId: "member-bob", credential: "resume-secret" } })).toThrow("roomId");
    expect(JSON.stringify(DSH_COLLAB_PARTICIPANT_SCHEMA.toJSON())).toContain('"hidden":true');
  });
});
