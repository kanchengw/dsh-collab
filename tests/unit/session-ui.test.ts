import { describe, expect, it } from "vitest";
import { renderCollabSession, type CollabSessionViewState } from "../../src/session-ui.js";

const base: CollabSessionViewState = {
  roomId: "room-1",
  roomTitle: "Release room",
  hostDisplayName: "Ada",
  role: "participant",
  connection: "online",
  memberCount: 3,
  members: [
    { memberId: "m-host", displayName: "Ada", role: "host", status: "active" },
    { memberId: "m-me", displayName: "Lin", role: "participant", status: "active" },
  ],
  timeline: [],
  composer: { draft: "" },
};

describe("unified session UI", () => {
  it("renders a participant room with remote identity, timeline, members and composer", () => {
    const html = renderCollabSession(base);
    expect(html).toContain('data-collab-mode="participant"');
    expect(html).toContain("Participant");
    expect(html).toContain("Hosted by Ada");
    expect(html).toContain('aria-label="Collaborators"');
    expect(html).not.toContain("<select");
    expect(html).toContain("@agent");
    expect(html).not.toContain("Invite");
  });

  it("renders host controls and explicit loading/offline/error states", () => {
    const html = renderCollabSession({ ...base, role: "host", connection: "offline", loading: true, error: "Gateway unavailable" });
    expect(html).toContain('data-collab-mode="host"');
    expect(html).toContain("Host");
    expect(html).toContain("Invite");
    expect(html).not.toContain("Steer Agent");
    expect(html).toContain('data-state="loading"');
    expect(html).toContain('data-state="offline"');
    expect(html).toContain("Gateway unavailable");
  });

  it("escapes room and member text and contains no executable script", () => {
    const html = renderCollabSession({ ...base, roomTitle: "<Room>", hostDisplayName: "A & B", members: [{ ...base.members[0]!, displayName: "<img>" }] });
    expect(html).toContain("&lt;Room&gt;");
    expect(html).toContain("&lt;img&gt;");
    expect(html).not.toMatch(/<script\b/i);
  });
});
