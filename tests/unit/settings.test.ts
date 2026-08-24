import { describe, expect, it } from "vitest";
import { defaultCollabSettings, renderCollabSettings, validateCollabSettings, validateDshCollabPersistedSettings, type CollabSettings } from "../../src/settings.js";

describe("collab settings", () => {
  it("provides safe defaults and separates host and participant settings", () => {
    expect(defaultCollabSettings.exposeMode).toBe("loopback");
    const html = renderCollabSettings(defaultCollabSettings);
    expect(html).toContain('data-settings-namespace="collab"');
    expect(html).toContain("Host gateway");
    expect(html).toContain("Participant connection");
    expect(html).toContain('name="gatewayPort"');
    expect(html).toContain('name="participantGatewayUrl"');
  });

  it("warns before non-loopback exposure and rejects unsafe values", () => {
    const settings: CollabSettings = { ...defaultCollabSettings, exposeMode: "network", gatewayHost: "0.0.0.0" };
    expect(renderCollabSettings(settings)).toContain("Anyone who can reach this address");
    expect(() => validateCollabSettings({ ...settings, gatewayPort: 70000 })).toThrow("gatewayPort");
    expect(() => validateCollabSettings({ ...settings, tokenTtlMs: 0 })).toThrow("tokenTtlMs");
  });

  it("accepts only an http(s) /collab Participant Gateway URL without URL extras", () => {
    const gateway = { gatewayHost: "127.0.0.1" as const, gatewayPort: 3080, exposeMode: "loopback" as const };
    expect(() => validateDshCollabPersistedSettings({ gateway, participantGatewayUrl: "https://host.example/collab" })).not.toThrow();
    expect(() => validateDshCollabPersistedSettings({ gateway, participantGatewayUrl: "" })).not.toThrow();

    for (const participantGatewayUrl of [
      "not a URL",
      "ftp://host.example/collab",
      "https://user:pass@host.example/collab",
      "https://host.example/collab?room=one",
      "https://host.example/collab#invite",
      "https://host.example/not-collab",
    ]) {
      expect(() => validateDshCollabPersistedSettings({ gateway, participantGatewayUrl })).toThrow("participantGatewayUrl");
      expect(() => validateCollabSettings({ ...defaultCollabSettings, participantGatewayUrl })).toThrow("participantGatewayUrl");
    }
  });
});
