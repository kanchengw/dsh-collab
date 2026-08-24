import { describe, expect, it } from "vitest";
import { InviteStore } from "../../src/invites.js";
import { RoomStore } from "../../src/room.js";

function createRooms() {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1",
    hostId: "host",
    hostSessionId: "session-host",
    title: "Release",
    hostDisplayName: "Host",
    now: 1,
  });
  rooms.createRoom({
    roomId: "room-2",
    hostId: "other-host",
    hostSessionId: "session-other-host",
    title: "Other",
    hostDisplayName: "Other Host",
    now: 1,
  });
  return rooms;
}

function createInvites() {
  const rooms = createRooms();
  const tokens = ["opaque-token-1", "opaque-token-2"];
  const invites = new InviteStore(rooms, {
    tokenFactory: () => tokens.shift() ?? "opaque-token-fallback",
  });
  return { rooms, invites };
}

describe("InviteStore", () => {
  it("lets only the Host create a one-time invite without exposing its digest", () => {
    const { invites, rooms } = createInvites();
    rooms.addMember("room-1", {
      memberId: "member-alice",
      principalId: "alice",
      displayName: "Alice",
      now: 2,
    });

    const created = invites.createInvite({
      roomId: "room-1",
      principalId: "host",
      inviteId: "invite-1",
      expiresAt: 100,
      now: 1,
    });

    expect(created).toMatchObject({
      invite: {
        inviteId: "invite-1",
        roomId: "room-1",
        hostId: "host",
        state: "active",
        expiresAt: 100,
      },
      token: "opaque-token-1",
    });
    expect(created.invite).not.toHaveProperty("token");
    expect(created.invite).not.toHaveProperty("tokenDigest");
    expect(() => invites.createInvite({
      roomId: "room-1",
      principalId: "alice",
      inviteId: "invite-2",
      expiresAt: 100,
      now: 1,
    })).toThrowError(expect.objectContaining({ code: "ACTION_FORBIDDEN" }));
    expect(() => invites.revokeInvite({
      roomId: "room-1",
      principalId: "alice",
      inviteId: "invite-1",
      now: 2,
    })).toThrowError(expect.objectContaining({ code: "ACTION_FORBIDDEN" }));
  });

  it("accepts an invite once and binds the new member to the presented principal", () => {
    const { invites, rooms } = createInvites();
    const created = invites.createInvite({
      roomId: "room-1",
      principalId: "host",
      inviteId: "invite-1",
      expiresAt: 100,
      now: 1,
    });

    const member = invites.acceptInvite({
      roomId: "room-1",
      inviteId: "invite-1",
      token: created.token,
      principalId: "alice",
      memberId: "member-alice",
      displayName: "Alice",
      now: 2,
    });

    expect(member).toMatchObject({
      memberId: "member-alice",
      principalId: "alice",
      role: "participant",
      status: "active",
    });
    expect(invites.getInvite("invite-1")).toMatchObject({
      state: "accepted",
      acceptedPrincipalId: "alice",
      acceptedMemberId: "member-alice",
    });
    expect(rooms.listMembers("room-1")).toContainEqual(expect.objectContaining({ principalId: "alice" }));
    expect(() => invites.acceptInvite({
      roomId: "room-1",
      inviteId: "invite-1",
      token: created.token,
      principalId: "bob",
      memberId: "member-bob",
      displayName: "Bob",
      now: 3,
    })).toThrowError(expect.objectContaining({ code: "INVITE_USED" }));
  });

  it("rejects wrong tokens and tokens presented for another room", () => {
    const { invites } = createInvites();
    const created = invites.createInvite({
      roomId: "room-1",
      principalId: "host",
      inviteId: "invite-1",
      expiresAt: 100,
      now: 1,
    });

    expect(() => invites.acceptInvite({
      roomId: "room-1",
      inviteId: "invite-1",
      token: "wrong-token",
      principalId: "alice",
      memberId: "member-alice",
      displayName: "Alice",
      now: 2,
    })).toThrowError(expect.objectContaining({ code: "INVITE_INVALID" }));
    expect(() => invites.acceptInvite({
      roomId: "room-2",
      inviteId: "invite-1",
      token: created.token,
      principalId: "alice",
      memberId: "member-alice",
      displayName: "Alice",
      now: 2,
    })).toThrowError(expect.objectContaining({ code: "INVITE_INVALID" }));
  });

  it("expires at the boundary and can be revoked by the Host", () => {
    const { invites } = createInvites();
    const expired = invites.createInvite({
      roomId: "room-1",
      principalId: "host",
      inviteId: "invite-expired",
      expiresAt: 10,
      now: 1,
    });

    expect(() => invites.acceptInvite({
      roomId: "room-1",
      inviteId: "invite-expired",
      token: expired.token,
      principalId: "alice",
      memberId: "member-alice",
      displayName: "Alice",
      now: 10,
    })).toThrowError(expect.objectContaining({ code: "INVITE_EXPIRED" }));
    expect(invites.getInvite("invite-expired")).toMatchObject({ state: "expired" });

    const revoked = invites.createInvite({
      roomId: "room-1",
      principalId: "host",
      inviteId: "invite-revoked",
      expiresAt: 100,
      now: 1,
    });
    expect(invites.revokeInvite({
      roomId: "room-1",
      principalId: "host",
      inviteId: "invite-revoked",
      now: 2,
    })).toMatchObject({ state: "revoked" });
    expect(() => invites.acceptInvite({
      roomId: "room-1",
      inviteId: "invite-revoked",
      token: revoked.token,
      principalId: "alice",
      memberId: "member-alice",
      displayName: "Alice",
      now: 3,
    })).toThrowError(expect.objectContaining({ code: "INVITE_REVOKED" }));
  });

  it("does not consume an invite when member binding fails", () => {
    const { invites, rooms } = createInvites();
    rooms.addMember("room-1", {
      memberId: "member-alice",
      principalId: "alice",
      displayName: "Existing Alice",
      now: 2,
    });
    const created = invites.createInvite({
      roomId: "room-1",
      principalId: "host",
      inviteId: "invite-1",
      expiresAt: 100,
      now: 3,
    });

    expect(() => invites.acceptInvite({
      roomId: "room-1",
      inviteId: "invite-1",
      token: created.token,
      principalId: "alice",
      memberId: "member-alice-2",
      displayName: "Alice Again",
      now: 4,
    })).toThrowError(expect.objectContaining({ code: "MEMBER_EXISTS" }));
    expect(invites.getInvite("invite-1")).toMatchObject({ state: "active" });
  });
});
