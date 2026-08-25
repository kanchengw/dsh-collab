import { describe, expect, it } from "vitest";
import { ResumeCredentialStore } from "../../src/resume-credentials.js";
import { RoomStore } from "../../src/room.js";

function rooms(): RoomStore {
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", now: 1 });
  rooms.addMember("room-1", { memberId: "member-bob", principalId: "bob", displayName: "Bob", now: 2 });
  return rooms;
}

describe("Participant resume credentials", () => {
  it("persists only a credential digest and restores the member binding", () => {
    const store = new ResumeCredentialStore(rooms(), { credentialFactory: () => "resume-secret" });
    const issued = store.issue({ roomId: "room-1", memberId: "member-bob", principalId: "bob", now: 3 });

    expect(issued.credential).toBe("resume-secret");
    expect(JSON.stringify(store.snapshot())).not.toContain("resume-secret");

    const restored = ResumeCredentialStore.fromSnapshot(rooms(), store.snapshot());
    expect(restored.verify({ roomId: "room-1", credential: "resume-secret" })).toMatchObject({
      roomId: "room-1",
      memberId: "member-bob",
      principalId: "bob",
    });
  });

  it("revokes every resume credential for a suspended or removed member", () => {
    const store = new ResumeCredentialStore(rooms(), { credentialFactory: () => "resume-secret" });
    store.issue({ roomId: "room-1", memberId: "member-bob", principalId: "bob", now: 3 });

    expect(store.revokeMember("room-1", "member-bob", 4)).toBe(1);
    expect(() => store.verify({ roomId: "room-1", credential: "resume-secret" })).toThrow(/revoked/i);
  });

  it("fails closed when a restored digest is malformed", () => {
    expect(() => ResumeCredentialStore.fromSnapshot(rooms(), {
      version: 1,
      records: [{ digest: "raw-secret", roomId: "room-1", memberId: "member-bob", principalId: "bob", createdAt: 3 }],
    })).toThrow(/snapshot/i);
  });
});
