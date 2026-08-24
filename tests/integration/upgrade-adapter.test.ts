import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EventLedger } from "../../src/events.js";
import { RoomStreamHub } from "../../src/stream.js";
import { RoomStore } from "../../src/room.js";
import { RoomTokenStore } from "../../src/tokens.js";
import { CollabStreamUpgrade, COLLAB_STREAM_PATH } from "../../src/upgrade.js";
import { registerCollabRoutes } from "../../src/webserver.js";
import type { CollabHttpOptions } from "../../src/http.js";
import type { CollabWebServer } from "../../src/webserver.js";

let httpServer: Server | undefined;
let upgrade: CollabStreamUpgrade | undefined;

afterEach(async () => {
  await upgrade?.close();
  upgrade = undefined;
  if (httpServer?.listening) await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
  httpServer = undefined;
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
  const tokens = new RoomTokenStore(rooms, { tokenFactory: () => "room-token", ttlMs: 1000 });
  const member = rooms.authorize("room-1", "host", "read");
  const issued = tokens.issue({ roomId: "room-1", member, now: 10 });
  const hub = new RoomStreamHub({ rooms, tokens, ledger, now: () => 10 });
  return { rooms, ledger, tokens, hub, token: issued.token };
}

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once("message", (data, binary) => {
      if (binary) {
        reject(new Error("unexpected binary frame"));
        return;
      }
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
    socket.once("error", reject);
  });
}

describe("DSH-compatible upgrade adapter", () => {
  it("registers one prefix HTTP route and one exact stream route with symmetric disposal", () => {
    const registrations: string[] = [];
    const webServer: CollabWebServer = {
      register(route) {
        registrations.push(`${route.kind}:${route.path}`);
        return () => { registrations.splice(registrations.indexOf(`${route.kind}:${route.path}`), 1); };
      },
      registerUpgrade(route) {
        registrations.push(`upgrade:${route.path}`);
        return () => { registrations.splice(registrations.indexOf(`upgrade:${route.path}`), 1); };
      },
    };
    const fakeUpgrade = { handleUpgrade() {} } as unknown as CollabStreamUpgrade;
    const http: CollabHttpOptions = { gateway: {} as CollabHttpOptions["gateway"] };

    const dispose = registerCollabRoutes({ webServer, http, upgrade: fakeUpgrade });
    expect(registrations).toEqual(["prefix:/collab", `upgrade:${COLLAB_STREAM_PATH}`]);
    dispose();
    expect(registrations).toEqual([]);
  });

  it("authenticates, upgrades, replays and streams versioned room frames", async () => {
    const { ledger, hub, tokens, token } = setup();
    upgrade = new CollabStreamUpgrade({ hub, tokens, now: () => 10, connectionIdFactory: () => "conn-1" });
    httpServer = createServer();
    httpServer.on("upgrade", (request, socket, head) => upgrade!.handleUpgrade(request, socket, head));
    const port = await listen(httpServer);
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${COLLAB_STREAM_PATH}?roomId=room-1&after=0`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const connected = nextMessage(socket);
    await once(socket, "open");

    await expect(connected).resolves.toMatchObject({
      protocol: "dsh-collab.v1",
      type: "connected",
      connectionId: "conn-1",
      roomId: "room-1",
    });

    const event = nextMessage(socket);
    ledger.append({
      eventId: "event-1",
      roomId: "room-1",
      type: "human.message",
      actor: { memberId: "host", principalId: "host" },
      createdAt: 10,
      payload: { text: "hello" },
    });
    await expect(event).resolves.toMatchObject({ protocol: "dsh-collab.v1", type: "event", event: { seq: 1 } });

    const heartbeat = nextMessage(socket);
    socket.send(JSON.stringify({ protocol: "dsh-collab.v1", type: "heartbeat" }));
    await expect(heartbeat).resolves.toMatchObject({ protocol: "dsh-collab.v1", type: "heartbeat", connectionId: "conn-1" });

    socket.close();
    await once(socket, "close");
  });

  it("rejects an invalid room token before websocket upgrade", async () => {
    const { hub, tokens } = setup();
    upgrade = new CollabStreamUpgrade({ hub, tokens, now: () => 10 });
    httpServer = createServer();
    httpServer.on("upgrade", (request, socket, head) => upgrade!.handleUpgrade(request, socket, head));
    const port = await listen(httpServer);
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${COLLAB_STREAM_PATH}?roomId=room-1`, {
      headers: { authorization: "Bearer invalid" },
    });
    const [, response] = await once(socket, "unexpected-response") as [import("node:http").ClientRequest, import("node:http").IncomingMessage];
    expect(response.statusCode).toBe(401);
  });
});
