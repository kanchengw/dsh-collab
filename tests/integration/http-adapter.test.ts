import { createServer as createTcpServer, type Server } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CollabGateway } from "../../src/gateway.js";
import { EventLedger } from "../../src/events.js";
import { InviteStore } from "../../src/invites.js";
import { authenticateCollabRequest, createCollabHttpServer, type CollabHttpServer } from "../../src/http.js";
import { RoomStore } from "../../src/room.js";
import type { HostAgentPort } from "../../src/types.js";

let server: CollabHttpServer | undefined;
let blocker: Server | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await new Promise<void>((resolve, reject) => blocker?.listening ? blocker.close((error) => error ? reject(error) : resolve()) : resolve());
  blocker = undefined;
});

async function consecutiveFreePorts(): Promise<[number, number]> {
  for (let first = 50_000; first < 51_000; first += 2) {
    const left = createTcpServer();
    const right = createTcpServer();
    try {
      await new Promise<void>((resolve, reject) => { left.once("error", reject); left.listen(first, "127.0.0.1", resolve); });
      await new Promise<void>((resolve, reject) => { right.once("error", reject); right.listen(first + 1, "127.0.0.1", resolve); });
      await Promise.all([left, right].map((item) => new Promise<void>((resolve) => item.close(() => resolve()))));
      return [first, first + 1];
    } catch {
      await Promise.all([left, right].map((item) => new Promise<void>((resolve) => item.listening ? item.close(() => resolve()) : resolve())));
    }
  }
  throw new Error("No consecutive test ports are available");
}

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
  it("selects the first available port in the configured bounded range", async () => {
    const [preferred, fallback] = await consecutiveFreePorts();
    blocker = createTcpServer();
    await new Promise<void>((resolve, reject) => { blocker!.once("error", reject); blocker!.listen(preferred, "127.0.0.1", resolve); });
    server = createCollabHttpServer({
      gateway: setup(),
      port: preferred,
      portScan: { start: preferred, end: fallback },
    });

    await expect(server.listen()).resolves.toBe(fallback);
  });

  it("mounts the public route, preserves request ids, and forwards gateway responses", async () => {
    let remoteAddress: string | undefined;
    server = createCollabHttpServer({
      gateway: setup(),
      port: 0,
      requestIdFactory: () => "req-generated",
      authenticate: ({ headers, remoteAddress: address }) => {
        remoteAddress = address;
        return { principalId: headers["x-principal-id"] };
      },
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
    expect(remoteAddress).toMatch(/127\.0\.0\.1|::1/);
    expect(invite).toMatchObject({ protocol: "dsh-collab.v1", requestId: "req-invite", ok: true });

    const joinResponse = await fetch(`${base}/collab/v1/rooms/room-1/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-request-id": "req-join",
      },
      body: JSON.stringify({ inviteId: "invite-1", token: invite.data.token, memberId: "member-bob", displayName: "Bob" }),
    });
    const join = await json(joinResponse);
    expect(joinResponse.status).toBe(201);
    expect(join).toMatchObject({
      protocol: "dsh-collab.v1",
      requestId: "req-join",
      ok: true,
      data: {
        member: { principalId: "invite:invite-1" },
        event: { type: "member.joined", payload: { memberId: "member-bob", displayName: "Bob" } },
      },
    });

    const snapshotResponse = await fetch(`${base}/collab/v1/rooms/room-1/snapshot`, {
      headers: { authorization: `Bearer ${join.data.roomToken}`, "x-request-id": "req-snapshot" },
    });
    const snapshot = await json(snapshotResponse);
    expect(snapshotResponse.status).toBe(200);
    expect(snapshot).toMatchObject({ protocol: "dsh-collab.v1", requestId: "req-snapshot", ok: true, data: { room: { roomId: "room-1" } } });
  });

  it("answers CORS preflight without trusting a public browser origin as the Host", async () => {
    server = createCollabHttpServer({
      gateway: setup(),
      port: 0,
      authenticate: (input) => authenticateCollabRequest(input, { hostPrincipalId: "host", allowLoopbackPrincipal: true }),
    });
    const port = await server.listen();
    const base = `http://127.0.0.1:${String(port)}`;
    const origin = "http://127.0.0.1:3080";
    const preflight = await fetch(`${base}/collab/v1/rooms/room-1/join`, {
      method: "OPTIONS",
      headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type, authorization" },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
    expect(preflight.headers.get("access-control-allow-headers")).toContain("x-dsh-collab-capabilities");
    expect(preflight.headers.get("access-control-allow-methods")).toContain("PUT");

    const blocked = await fetch(`${base}/collab/v1/rooms/room-1/bootstrap`, { headers: { origin: "https://evil.example" } });
    expect(blocked.status).toBe(401);
    const allowed = await fetch(`${base}/collab/v1/rooms/room-1/bootstrap`, { headers: { origin } });
    expect(allowed.status).toBe(200);
  });

  it("forwards PUT requests and their JSON body to the gateway", async () => {
    const gateway = setup();
    const handle = vi.spyOn(gateway, "handle").mockResolvedValue({ status: 200, body: { accepted: true } });
    server = createCollabHttpServer({ gateway, port: 0 });
    const port = await server.listen();

    const response = await fetch(`http://127.0.0.1:${String(port)}/collab/v1/rooms/room-1/review-points/review/publications/publication/state`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: "accepted" }),
    });

    expect(response.status).toBe(200);
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      body: { state: "accepted" },
    }));
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
