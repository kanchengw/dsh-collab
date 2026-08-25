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

  it("separates Host setup, invitation output and Participant join", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, { port }));

    expect(html).toContain("Host a room");
    expect(html).toContain("Invite people");
    expect(html).toContain("Join someone else");
    expect(html).toContain('name="hostInvitationOutput"');
    expect(html).toContain('name="participantInvitation"');
    expect(html).toContain('name="displayName"');
    expect(html).toContain("Restart DSH to apply Gateway and room safety changes");
    expect(html).not.toContain("trusted LAN/VPN");
    expect(html.match(/<h3/g)).toHaveLength(3);
  });

  it("makes Host configuration visibly read-only when DSH cannot persist it", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, {
      port: { ...port, getSnapshot: () => ({ ...port.getSnapshot(), writable: false }) },
    }));

    expect(html).toContain("Collaboration settings are read-only");
    expect(html).toMatch(/name="gatewayPort"[^>]*disabled/);
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
});
