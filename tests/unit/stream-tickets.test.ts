import { describe, expect, it } from "vitest";
import { RoomStore } from "../../src/room.js";
import { StreamTicketStore } from "../../src/stream-tickets.js";
import { RoomTokenStore } from "../../src/tokens.js";

function setup() {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "One", hostDisplayName: "Host", now: 1,
  });
  rooms.createRoom({
    roomId: "room-2", hostId: "host", hostSessionId: "session-2", title: "Two", hostDisplayName: "Host", now: 1,
  });
  const tokens = new RoomTokenStore(rooms, { tokenFactory: () => "room-token", ttlMs: null });
  const member = rooms.authorize("room-1", "host", "read");
  const roomToken = tokens.issue({ roomId: "room-1", member, now: 10 }).token;
  let ticketSequence = 0;
  const tickets = new StreamTicketStore(tokens, {
    ticketFactory: () => `stream-ticket-${String(++ticketSequence)}`,
    ttlMs: 30,
  });
  return { tokens, tickets, roomToken };
}

describe("StreamTicketStore", () => {
  it("issues a short-lived ticket that can be consumed only once", () => {
    const { tickets, roomToken } = setup();
    const issued = tickets.issue({ roomId: "room-1", roomToken, now: 10 });

    expect(issued).toEqual({ ticket: "stream-ticket-1", expiresAt: 40 });
    expect(tickets.consume({ roomId: "room-1", ticket: issued.ticket, now: 20 })).toBe(roomToken);
    expect(() => tickets.consume({ roomId: "room-1", ticket: issued.ticket, now: 20 })).toThrowError(expect.objectContaining({ code: "AUTH_INVALID" }));
  });

  it("rejects expired, cross-room and room-token-revoked tickets", () => {
    const { tokens, tickets, roomToken } = setup();
    const expired = tickets.issue({ roomId: "room-1", roomToken, now: 10 });
    expect(() => tickets.consume({ roomId: "room-1", ticket: expired.ticket, now: 40 })).toThrowError(expect.objectContaining({ code: "AUTH_INVALID" }));

    const crossRoom = tickets.issue({ roomId: "room-1", roomToken, now: 50 });
    expect(() => tickets.consume({ roomId: "room-2", ticket: crossRoom.ticket, now: 51 })).toThrowError(expect.objectContaining({ code: "TOKEN_SCOPE" }));

    const revoked = tickets.issue({ roomId: "room-1", roomToken, now: 60 });
    tokens.revokeToken(roomToken, 61);
    expect(() => tickets.consume({ roomId: "room-1", ticket: revoked.ticket, now: 61 })).toThrowError(expect.objectContaining({ code: "AUTH_INVALID" }));
  });

  it("bounds unconsumed tickets per room and releases capacity after expiry", () => {
    const { tokens, roomToken } = setup();
    let ticketSequence = 0;
    const tickets = new StreamTicketStore(tokens, {
      ticketFactory: () => `bounded-ticket-${String(++ticketSequence)}`,
      ttlMs: 30,
      maxPendingPerRoom: 2,
    });

    tickets.issue({ roomId: "room-1", roomToken, now: 10 });
    tickets.issue({ roomId: "room-1", roomToken, now: 10 });
    expect(() => tickets.issue({ roomId: "room-1", roomToken, now: 10 })).toThrowError(
      expect.objectContaining({ code: "RESOURCE_LIMIT" }),
    );

    expect(tickets.issue({ roomId: "room-1", roomToken, now: 40 })).toEqual({
      ticket: "bounded-ticket-3",
      expiresAt: 70,
    });
  });
});
