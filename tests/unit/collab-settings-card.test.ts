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
  it("keeps workspace creation out of plugin settings", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, { port }));

    expect(html).not.toContain("Create a Collab workspace");
    expect(html).not.toContain('name="ownedRoomTitle"');
    expect(html).toContain("Collab Gateway");
  });

  it("owns the Gateway runtime switch inside the plugin settings", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, {
      port: {
        getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }),
        getGatewaySnapshot: () => ({ status: "running" as const, port: 4310 }),
        startGateway: vi.fn(),
        stopGateway: vi.fn(),
        save: vi.fn(),
      },
    }));

    expect(html).toContain("Gateway");
    expect(html).toContain("Running on 4310");
    expect(html).toContain("Stop Gateway");
  });

  it("uses the plugin settings list-card contract", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsCard, { port }));

    expect(html).toMatch(/^<li/);
    expect(html).toContain('data-collab-settings-card="true"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Configure Gateway connectivity and room limits");
    expect(html).not.toContain("dsh-collab-settings-card");
  });

  it("keeps automatic addresses hidden and puts configuration in collapsed advanced options", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, { port }));
    const advancedIndex = html.indexOf("<details");

    expect(html).toContain("Collab Gateway");
    expect(html).not.toContain("Join someone else");
    expect(html.indexOf("Connection method")).toBeGreaterThan(advancedIndex);
    expect(html.indexOf("Private network")).toBeGreaterThan(advancedIndex);
    expect(html.indexOf("Custom WSS endpoint")).toBeGreaterThan(advancedIndex);
    expect(html).not.toContain("Private address");
    expect(html).not.toContain("Invitation address");
    expect(html).not.toContain("This device only");
    expect(html).not.toContain('name="privateAddress"');
    expect(html).not.toContain('name="derivedEndpoint"');
    expect(html).not.toContain("no manual configuration is needed");
    expect(html).not.toContain('name="gatewayPort"');
    expect(html).not.toContain("Open Host room");
    expect(html).not.toContain("Create invitation");
    expect(html).not.toContain('name="hostInvitationOutput"');
    expect(html).not.toContain('name="participantInvitation"');
    expect(html).not.toContain('name="displayName"');
    expect(html).not.toContain('name="approvalPolicy"');
    expect(html).toContain("Advanced options");
    expect(html).toContain("Security");
    expect(html).toContain("Chat");
    expect(html).toContain("LAN settings");
    expect(html).not.toMatch(/<details[^>]*open/);
    expect(html).toContain('id="collab-queue"');
    expect(html).toContain('value="5"');
    expect(html).toContain("Used the next time you share a room");
    expect(html).not.toContain("trusted LAN/VPN");
    expect(html.match(/<h3/g)).toHaveLength(1);
  });

  it("warns when a running Gateway still uses the previous settings", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, {
      port: {
        ...port,
        getGatewaySnapshot: () => ({ status: "running" as const, port: 4310 }),
        getSnapshot: () => ({
          ...port.getSnapshot(),
          advertisedEndpoint: "ws://192.168.0.65:4310/collab",
          appliedGateway: { ...port.getSnapshot(), advertisedEndpoint: "ws://10.131.241.65:4310/collab" },
        }),
      },
    }));

    expect(html).toContain("The running Gateway still uses the previous address");
    expect(html).toContain("Gateway will restart automatically before the next room share");
    expect(html).toContain("sharing refreshes the Gateway when needed");
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
    expect(html).not.toContain('id="collab-private-address"');
    expect(html).toMatch(/type="submit"[^>]*disabled/);
  });

  it("does not render an active room role or credential in Settings", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, { port }));

    expect(html).not.toContain("data-room-role");
    expect(html).not.toContain("Release room");
    expect(html).not.toContain("Alice");
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

    expect(html.indexOf('name="advertisedEndpoint"')).toBeGreaterThan(html.indexOf("<details"));
    expect(html).not.toContain('name="privateAddress"');
    expect(html).not.toContain('name="derivedEndpoint"');
  });
});
