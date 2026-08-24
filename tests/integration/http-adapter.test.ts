import { afterEach, describe, expect, it } from "vitest";
import { CollabGateway } from "../../src/gateway.js";
import { EventLedger } from "../../src/events.js";
import { InviteStore } from "../../src/invites.js";
import { createCollabHttpServer, type CollabHttpServer } from "../../src/http.js";
import { RoomStore } from "../../src/room.js";
import type { HostAgentPort } from "../../src/types.js";

let server: CollabHttpServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function setup() {
  const rooms = new RoomStore();
  rooms.createRoom({
    roomId: "room-1",
    hostId: "host",
    hostSessionId: "session-host",
    title: "Release",
    hostDisplayName: "Host",
    now: 1,
  });
  const ledger = new EventLedger();
  const invites = new InviteStore(rooms, { tokenFactory: () => "invite-token" });
  const agent: HostAgentPort = { followup() {}, steer() {}, cancel() {} };
  const gateway = new CollabGateway({ rooms, ledger, invites, agent, now: () => 10, tokenFactory: () => "room-token" });
  return gateway;
}

async function json(response: Response): Promise<Record<string, any>> {
  return await response.json() as Record<string, any>;
}

describe("localhost HTTP adapter", () => {
  it("mounts the public route, preserves request ids, and forwards gateway responses", async () => {
    server = createCollabHttpServer({
      gateway: setup(),
      port: 0,
      requestIdFactory: () => "req-generated",
      authenticate: ({ headers }) => ({ principalId: headers["x-principal-id"] }),
    });
    const port = await server.listen();
    const base = `http://127.0.0.1:${String(port)}`;

    const inviteResponse = await fetch(`${base}/collab/v1/rooms/room-1/invites`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-invite",
        "x-principal-id": "host",
      },
      body: JSON.stringify({ inviteId: "invite-1", expiresAt: 100 }),
    });
    const invite = await json(inviteResponse);
    expect(inviteResponse.status).toBe(201);
    expect(invite).toMatchObject({ protocol: "dsh-collab.v1", requestId: "req-invite", ok: true });

    const joinResponse = await fetch(`${base}/collab/v1/rooms/room-1/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-join",
        "x-principal-id": "bob",
      },
      body: JSON.stringify({ inviteId: "invite-1", token: invite.data.token, memberId: "member-bob", displayName: "Bob" }),
    });
    const join = await json(joinResponse);
    expect(joinResponse.status).toBe(201);
    expect(join).toMatchObject({ protocol: "dsh-collab.v1", requestId: "req-join", ok: true });

    const snapshotResponse = await fetch(`${base}/collab/v1/rooms/room-1/snapshot`, {
      headers: { authorization: `Bearer ${join.data.roomToken}`, "x-request-id": "req-snapshot" },
    });
    const snapshot = await json(snapshotResponse);
    expect(snapshotResponse.status).toBe(200);
    expect(snapshot).toMatchObject({ protocol: "dsh-collab.v1", requestId: "req-snapshot", ok: true, data: { room: { roomId: "room-1" } } });
  });

  it("returns protocol errors for malformed JSON and unknown public paths", async () => {
    server = createCollabHttpServer({ gateway: setup(), port: 0, requestIdFactory: () => "req-fallback" });
    const port = await server.listen();
    const base = `http://127.0.0.1:${String(port)}`;

    const malformed = await fetch(`${base}/collab/v1/rooms/room-1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": "req-bad" },
      body: "{",
    });
    expect(malformed.status).toBe(422);
    expect(await json(malformed)).toMatchObject({ protocol: "dsh-collab.v1", requestId: "req-bad", ok: false, error: { code: "INVALID_INPUT" } });

    const missing = await fetch(`${base}/other/v1/rooms/room-1/snapshot`, { headers: { "x-request-id": "req-missing" } });
    expect(missing.status).toBe(404);
    expect(await json(missing)).toMatchObject({ protocol: "dsh-collab.v1", requestId: "req-missing", ok: false, error: { code: "NOT_FOUND" } });
  });
});
