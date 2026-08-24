import { describe, expect, it } from "vitest";
import { renderParticipantShell, type ParticipantShellState } from "../../src/ui.js";

describe("Participant shell view", () => {
  it("renders a remote-room shell with Host identity and no local Agent affordance", () => {
    const state: ParticipantShellState = {
      roomId: "room-1",
      roomTitle: "Release",
      hostDisplayName: "Host",
      connection: "online",
      memberCount: 3,
    };

    const html = renderParticipantShell(state);
    expect(html).toContain("Release");
    expect(html).toContain("Host");
    expect(html).toContain('data-collab-mode="participant"');
    expect(html).toContain('data-connection="online"');
    expect(html).toContain("3 members");
    expect(html).not.toContain("Create Agent");
  });

  it("renders explicit empty, offline, and escaped error states", () => {
    const state: ParticipantShellState = {
      roomId: "room-1",
      roomTitle: "<Room>",
      hostDisplayName: "Host & Co",
      connection: "offline",
      memberCount: 0,
      error: "<script>alert(1)</script>",
    };

    const html = renderParticipantShell(state);
    expect(html).toContain("No collaborators yet");
    expect(html).toContain('data-connection="offline"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)");
  });
});
