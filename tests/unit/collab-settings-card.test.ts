import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DshCollabSettingsCard, DshCollabSettingsPanel } from "../../src/collab-settings-card.js";

const port = {
  getSnapshot: () => ({
    gatewayHost: "0.0.0.0",
    gatewayPort: 4310,
    exposeMode: "network" as const,
    advertisedEndpoint: "ws://192.168.1.20:4310/collab",
  }),
  getRoomSnapshot: () => ({
    roomId: "room-remote",
    roomTitle: "Release room",
    hostDisplayName: "Alice",
    role: "participant" as const,
    connection: "online" as const,
  }),
  save: vi.fn(),
};

describe("DSH-native collaboration settings", () => {
  it("uses the plugin settings list-card contract", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsCard, { port }));

    expect(html).toMatch(/^<li/);
    expect(html).toContain('data-collab-settings-card="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Share one Host Agent with other people");
    expect(html).not.toContain("dsh-collab-settings-card");
  });

  it("keeps Host connectivity in Settings and moves room sharing out of Settings", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, { port }));

    expect(html).toContain("Host a room");
    expect(html).toContain("Join someone else");
    expect(html).toContain("Connection method");
    expect(html).toContain("Private network");
    expect(html).toContain("Custom WSS endpoint");
    expect(html).not.toContain("Who can connect");
    expect(html).not.toContain("This device only");
    expect(html).toContain('name="privateAddress"');
    expect(html).toContain('name="derivedEndpoint"');
    expect(html).not.toContain('name="gatewayPort"');
    expect(html).not.toContain("Open Host room");
    expect(html).not.toContain("Create invitation");
    expect(html).not.toContain('name="hostInvitationOutput"');
    expect(html).toContain('name="participantInvitation"');
    expect(html).toContain('name="displayName"');
    expect(html).toContain("Restart DSH to apply Gateway and room safety changes");
    expect(html).not.toContain("trusted LAN/VPN");
    expect(html.match(/<h3/g)).toHaveLength(2);
  });

  it("keeps a fresh install unconfigured without exposing a local-only invitation mode", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, {
      port: {
        ...port,
        getSnapshot: () => ({
          gatewayHost: "127.0.0.1",
          gatewayPort: 4310,
          exposeMode: "loopback" as const,
          advertisedEndpoint: "",
        }),
      },
    }));

    expect(html).toContain('<option value="unconfigured" disabled="" selected="">Not configured</option>');
    expect(html).not.toContain('name="gatewayPort"');
    expect(html).not.toContain("Create invitation");
    expect(html).not.toContain("127.0.0.1");
    expect(html).not.toContain("This device only");
  });

  it("makes Host configuration visibly read-only when DSH cannot persist it", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, {
      port: { ...port, getSnapshot: () => ({ ...port.getSnapshot(), writable: false }) },
    }));

    expect(html).toContain("Collaboration settings are read-only");
    expect(html).toMatch(/name="privateAddress"[^>]*disabled/);
    expect(html).toMatch(/type="submit"[^>]*disabled/);
  });

  it("shows a recovered remote Participant role without exposing its credential", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, { port }));

    expect(html).toContain("Participant");
    expect(html).toContain("Release room");
    expect(html).toContain("Alice");
    expect(html).not.toContain("resumeCredential");
    expect(html).not.toContain("credential");
  });

  it("keeps Custom WSS editable while private endpoints are derived", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, {
      port: {
        ...port,
        getSnapshot: () => ({
          gatewayHost: "0.0.0.0",
          gatewayPort: 4310,
          exposeMode: "loopback" as const,
          advertisedEndpoint: "wss://collab.example.com/collab",
        }),
      },
    }));

    expect(html).toContain('name="advertisedEndpoint"');
    expect(html).not.toContain('name="privateAddress"');
    expect(html).not.toContain('name="derivedEndpoint"');
  });
});
