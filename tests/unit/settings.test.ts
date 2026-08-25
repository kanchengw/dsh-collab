import { describe, expect, it } from "vitest";
import { defaultCollabSettings, renderCollabSettings, validateCollabSettings, validateDshCollabPersistedSettings, type CollabSettings } from "../../src/settings.js";

describe("collab settings", () => {
  it("provides safe defaults and separates host and participant settings", () => {
    expect(defaultCollabSettings.exposeMode).toBe("loopback");
    expect(defaultCollabSettings.gatewayPort).toBe(4310);
    const html = renderCollabSettings(defaultCollabSettings);
    expect(html).toContain('data-settings-namespace="collab"');
    expect(html).toContain("Host gateway");
    expect(html).toContain("Invitation address");
    expect(html).toContain('name="gatewayPort"');
    expect(html).toContain('name="advertisedEndpoint"');
    expect(html).not.toContain("participantGatewayUrl");
  });

  it("warns before non-loopback exposure and rejects unsafe values", () => {
    const settings: CollabSettings = { ...defaultCollabSettings, exposeMode: "network", gatewayHost: "0.0.0.0", advertisedEndpoint: "ws://192.168.1.20:4310/collab" };
    expect(renderCollabSettings(settings)).toContain("trusted network");
    expect(() => validateCollabSettings({ ...settings, gatewayPort: 70000 })).toThrow("gatewayPort");
    expect(() => validateCollabSettings({ ...settings, tokenTtlMs: 0 })).toThrow("tokenTtlMs");
  });

  it("validates the endpoint Host puts in invitations", () => {
    const gateway = { gatewayHost: "127.0.0.1" as const, gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" };
    expect(() => validateDshCollabPersistedSettings({ gateway })).not.toThrow();
    expect(() => validateDshCollabPersistedSettings({ gateway: { ...gateway, advertisedEndpoint: "wss://host.example/collab" } })).not.toThrow();
    expect(() => validateDshCollabPersistedSettings({ gateway: { gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network", advertisedEndpoint: "" } })).toThrow("advertisedEndpoint");
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
});
