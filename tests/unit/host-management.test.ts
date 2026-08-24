import { describe, expect, it } from "vitest";
import { renderHostRoomManagement, type HostRoomManagementState } from "../../src/ui.js";

const state: HostRoomManagementState = {
  roomId: "room-1",
  roomTitle: "Release",
  roomState: "open",
  hostSessionId: "session-host",
  canManage: true,
  members: [
    { memberId: "member-host", displayName: "Host", role: "host", status: "active" },
    { memberId: "member-bob", displayName: "Bob", role: "participant", status: "active" },
  ],
};

describe("Host room management view", () => {
  it("renders room state, one Host Agent binding, members, and management actions", () => {
    const html = renderHostRoomManagement(state);
    expect(html).toContain('data-room-state="open"');
    expect(html).toContain("session-host");
    expect(html).toContain("Bob");
    expect(html).toContain('data-action="suspend"');
    expect(html).toContain('data-action="remove"');
  });

  it("hides management actions for a read-only view", () => {
    const html = renderHostRoomManagement({ ...state, canManage: false });
    expect(html).not.toContain('data-action="suspend"');
    expect(html).not.toContain('data-action="remove"');
  });
});
