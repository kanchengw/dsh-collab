import { describe, expect, it } from "vitest";
import { composerTargetForGesture, composerTargetForText } from "../../src/ui.js";
import { classifyMessage } from "../../src/messages.js";
import { migrateRoomStoreSnapshot } from "../../src/room.js";

describe("CRD-U13 legacy collaboration cutover", () => {
  it("routes every composer submission to the human General room", () => {
    expect(composerTargetForText("@agent run the tests")).toBe("room");
    expect(composerTargetForGesture("@agent run the tests", true, true)).toBe("room");
  });

  it("rejects the retired @agent message targets at the protocol boundary", () => {
    expect(() => classifyMessage({
      messageId: "legacy-agent-message",
      roomId: "room-1",
      authorMemberId: "member-host",
      text: "run the tests",
      target: "dsh",
    })).toThrow(/retired|removed|human|room/i);
    expect(() => classifyMessage({
      messageId: "legacy-steer-message",
      roomId: "room-1",
      authorMemberId: "member-host",
      text: "interrupt",
      target: "dsh-steer",
    })).toThrow(/retired|removed|human|room/i);
  });

  it("migrates legacy room snapshots by preserving the human host member", () => {
    const migrated = migrateRoomStoreSnapshot({
      version: 1,
      rooms: [{
        room: {
          roomId: "room-legacy",
          hostId: "principal-host",
          hostSessionId: "old-primary-session",
          title: "Legacy room",
          state: "open",
          revision: 3,
          createdAt: 10,
        },
        members: [{
          memberId: "member-host",
          principalId: "principal-host",
          displayName: "Host",
          role: "participant",
          status: "active",
          joinedAt: 10,
        }],
      }],
    });

    expect(migrated.rooms[0]?.members).toEqual([expect.objectContaining({
      memberId: "member-host",
      principalId: "principal-host",
      role: "host",
    })]);
    expect(migrated.rooms[0]?.room.hostSessionId).toBe("old-primary-session");
  });
});
