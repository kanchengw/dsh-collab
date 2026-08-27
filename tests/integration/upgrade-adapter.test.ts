import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { EventLedger } from "../../src/events.js";
import { RoomStreamHub } from "../../src/stream.js";
import { RoomStore } from "../../src/room.js";
import { RoomTokenStore } from "../../src/tokens.js";
import { CollabStreamUpgrade, COLLAB_STREAM_PATH } from "../../src/upgrade.js";
import { SIDECAR_REVIEW_CAPABILITY } from "../../src/collaboration-types.js";

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

describe("WebSocket upgrade adapter", () => {
  it("authenticates, upgrades, replays and streams versioned room frames", async () => {
    const { ledger, hub, tokens, token } = setup();
    upgrade = new CollabStreamUpgrade({ hub, tokens, now: () => 10, connectionIdFactory: () => "conn-1" });
    httpServer = createServer();
    httpServer.on("upgrade", (request, socket, head) => upgrade!.handleUpgrade(request, socket, head));
    const port = await listen(httpServer);
    const socket = new WebSocket(`ws://127.0.0.1:${String(port)}${COLLAB_STREAM_PATH}?roomId=room-1&after=0&feature=agent-output&feature=${SIDECAR_REVIEW_CAPABILITY}&feature=future.v9`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const connected = nextMessage(socket);
    await once(socket, "open");

    await expect(connected).resolves.toMatchObject({
      protocol: "dsh-collab.v1",
      type: "connected",
      connectionId: "conn-1",
      roomId: "room-1",
      capabilities: [SIDECAR_REVIEW_CAPABILITY],
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

    const agentOutput = nextMessage(socket);
    hub.publishAgentOutput({ roomId: "room-1", requestId: "request-1", text: "partial", streaming: true });
    await expect(agentOutput).resolves.toMatchObject({ protocol: "dsh-collab.v1", type: "agent-output", requestId: "request-1", text: "partial" });

    const collaborationEvent = nextMessage(socket);
    hub.publishCollaborationEvent({
      type: "workspace-sharing.changed",
      state: { roomId: "room-1", enabled: false, revision: 1 },
    });
    await expect(collaborationEvent).resolves.toEqual({
      protocol: "dsh-collab.v1",
      type: "collaboration-event",
      event: {
        type: "workspace-sharing.changed",
        state: { roomId: "room-1", enabled: false, revision: 1 },
      },
    });

    const heartbeat = nextMessage(socket);
    socket.send(JSON.stringify({ protocol: "dsh-collab.v1", type: "heartbeat" }));
    await expect(heartbeat).resolves.toMatchObject({ protocol: "dsh-collab.v1", type: "heartbeat", connectionId: "conn-1" });

    socket.close();
    await once(socket, "close");
  });

  it("accepts a browser-compatible token query when no Authorization header is available", async () => {
    const { hub, tokens, token } = setup();
    const server = createServer();
    const upgrade = new CollabStreamUpgrade({ hub, tokens, now: () => 10, connectionIdFactory: () => "query-connection" });
    server.on("upgrade", upgrade.handleUpgrade);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing test address");
    const socket = new WebSocket(`ws://127.0.0.1:${String(address.port)}/collab/v1/stream?roomId=room-1&token=${encodeURIComponent(token)}`);
    const frame = await new Promise<string>((resolve, reject) => {
      socket.once("message", (data) => resolve(data.toString()));
      socket.once("error", reject);
    });
    expect(frame).toContain('"type":"connected"');
    socket.close();
    await upgrade.close();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
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
