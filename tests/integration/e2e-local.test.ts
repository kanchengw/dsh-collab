import { describe, expect, it } from "vitest";
import { request as httpRequest } from "node:http";
import WebSocket from "ws";
import { createDshCollabHostRuntime, type DshCollabHostRuntime } from "../../src/host-runtime.js";
import { decodeServerStreamFrame } from "../../src/protocol.js";
import type { DecodedServerStreamFrame } from "../../src/protocol.js";
import type { RoomEvent } from "../../src/types.js";

async function jsonRequest(base: string, input: { method: "GET" | "POST"; path: string; token?: string; body?: unknown; headers?: Record<string, string> }): Promise<{ status: number; data: any }> {
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  return new Promise((resolve, reject) => {
    const request = httpRequest(base + "/collab" + input.path, {
      method: input.method,
      headers: {
      "content-type": "application/json",
      ...input.headers,
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      ...(body === undefined ? {} : { "content-length": Buffer.byteLength(body) }),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { data?: unknown };
        resolve({ status: response.statusCode ?? 0, data: payload.data });
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}

function connect(base: string, roomId: string, ticket: string, connectionId: string): { socket: WebSocket; frames: DecodedServerStreamFrame[]; connected: Promise<void>; close: () => void } {
  const frames: DecodedServerStreamFrame[] = [];
  let resolveConnected!: () => void;
  let rejectConnected!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => { resolveConnected = resolve; rejectConnected = reject; });
  const socket = new WebSocket(base.replace("http", "ws") + `/collab/v1/stream?roomId=${roomId}&ticket=${encodeURIComponent(ticket)}&connectionId=${connectionId}`);
  socket.once("error", rejectConnected);
  socket.once("unexpected-response", (_request, response) => {
    const chunks: Buffer[] = [];
    response.on("data", (chunk: Buffer) => chunks.push(chunk));
    response.on("end", () => rejectConnected(new Error(`${connectionId} stream upgrade failed (${String(response.statusCode)}): ${Buffer.concat(chunks).toString("utf8").trim()}`)));
  });
  socket.on("message", (data) => {
    const frame = decodeServerStreamFrame(JSON.parse(data.toString()) as unknown);
    frames.push(frame);
    if (frame.kind === "connected") resolveConnected();
  });
  return { socket, frames, connected, close: () => socket.close() };
}

async function waitForEvent(frames: DecodedServerStreamFrame[], predicate: (event: RoomEvent) => boolean): Promise<RoomEvent> {
  for (;;) {
    const event = frames.find((frame): frame is Extract<DecodedServerStreamFrame, { kind: "event" }> => frame.kind === "event" && predicate(frame.event));
    if (event) return event.event;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("local end-to-end collaboration", () => {
  it("runs one Host DSH session with two remote participants over HTTP and WebSocket", async () => {
    const issued = ["invite-1", "invite-2", "room-token-1", "room-token-2"];
    let runtime!: DshCollabHostRuntime;
    const followups: string[] = [];
    runtime = createDshCollabHostRuntime({
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Release", hostDisplayName: "Host",
      allowLoopbackPrincipal: true,
      tokenFactory: () => issued.shift()!,
      sessions: {
        owns: (sessionId) => sessionId === "session-1",
        followup: ({ text }) => {
          followups.push(text);
          runtime.ledger.append({ eventId: "agent-output-1", roomId: "room-1", type: "agent.state.changed", actor: { memberId: "member-host", principalId: "host" }, payload: { state: "output", text: "Agent: " + text, requestId: "request:room-1:m-agent" } });
        },
        steer: () => {},
        cancel: () => {},
      },
    });
    const port = await runtime.http.listen();
    const base = `http://127.0.0.1:${String(port)}`;
    const sockets: Array<{ close: () => void }> = [];
    try {
      const invite1 = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/invites", body: { inviteId: "invite-a", expiresAt: Date.now() + 60_000 } });
      const invite2 = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/invites", body: { inviteId: "invite-b", expiresAt: Date.now() + 60_000 } });
      expect(invite1.status).toBe(201);
      expect(invite2.status).toBe(201);
      const joined1 = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/join", body: { inviteId: "invite-a", token: "invite-1", memberId: "member-1", displayName: "One", resumeCredential: "resume-1" } });
      const joined2 = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/join", body: { inviteId: "invite-b", token: "invite-2", memberId: "member-2", displayName: "Two", resumeCredential: "resume-2" } });
      expect(joined1.status).toBe(201);
      expect(joined2.status).toBe(201);
      expect(joined1.data.member.principalId).toBe("invite:invite-a:member-1");
      expect(joined2.data.member.principalId).toBe("invite:invite-b:member-2");
      const forbiddenAction = await jsonRequest(base, {
        method: "POST",
        path: "/v1/rooms/room-1/actions",
        token: joined1.data.roomToken,
        body: { action: "setMemberStatus", memberId: "member-2", status: "suspended" },
      });
      expect(forbiddenAction.status).toBe(403);
      const participantTicket1 = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/stream-tickets", token: joined1.data.roomToken, body: {} });
      const participantTicket2 = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/stream-tickets", token: joined2.data.roomToken, body: {} });
      expect(participantTicket1.status).toBe(201);
      expect(participantTicket2.status).toBe(201);
      expect(participantTicket1.data.ticket).not.toBe(participantTicket2.data.ticket);
      const one = connect(base, "room-1", participantTicket1.data.ticket, "connection-1");
      const two = connect(base, "room-1", participantTicket2.data.ticket, "connection-2");
      const bootstrappedHost = await jsonRequest(base, { method: "GET", path: "/v1/rooms/room-1/bootstrap", headers: { origin: base } });
      expect(bootstrappedHost.status).toBe(200);
      const hostTicket = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/stream-tickets", token: bootstrappedHost.data.roomToken, body: {} });
      const host = connect(base, "room-1", hostTicket.data.ticket, "connection-host");
      sockets.push(host, one, two);
      await Promise.all([host.connected, one.connected, two.connected]);

      const hostHuman = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/messages", token: bootstrappedHost.data.roomToken, body: { clientMessageId: "m-host-human", text: "Host room announcement", target: "room" } });
      expect(hostHuman.status).toBe(201);
      const hostHumanOnParticipant = await waitForEvent(two.frames, (event) => event.type === "human.message" && typeof event.payload === "object" && event.payload !== null && (event.payload as { text?: string }).text === "Host room announcement");
      expect(hostHumanOnParticipant.actor.memberId).toBe("member-host");

      const human = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/messages", token: joined1.data.roomToken, body: { clientMessageId: "m-human", text: "Can someone review this?", target: "room" } });
      expect(human.status).toBe(201);
      await Promise.all([waitForEvent(one.frames, (event) => event.type === "human.message"), waitForEvent(two.frames, (event) => event.type === "human.message")]);

      const agent = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/messages", token: joined2.data.roomToken, body: { clientMessageId: "m-agent", text: "Summarize the thread", target: "dsh" } });
      expect(agent.status).toBe(202);
      expect(followups).toEqual(["Summarize the thread"]);
      await waitForEvent(one.frames, (event) => event.type === "agent.request.created" && typeof event.payload === "object" && event.payload !== null && (event.payload as { text?: string }).text === "Summarize the thread");
      await Promise.all([waitForEvent(one.frames, (event) => event.type === "agent.state.changed"), waitForEvent(two.frames, (event) => event.type === "agent.state.changed")]);

      const cursor = two.frames.filter((frame): frame is Extract<DecodedServerStreamFrame, { kind: "event" }> => frame.kind === "event").at(-1)?.event.seq ?? 0;
      two.close();
      const reconnectTicket = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/stream-tickets", token: joined2.data.roomToken, body: {} });
      const twoReconnected = connect(base, "room-1", reconnectTicket.data.ticket, "connection-2-reconnect");
      sockets.push(twoReconnected);
      await twoReconnected.connected;
      const afterReconnect = await jsonRequest(base, { method: "POST", path: "/v1/rooms/room-1/messages", token: joined1.data.roomToken, body: { clientMessageId: "m-reconnect", text: "Welcome back", target: "room" } });
      expect(afterReconnect.status).toBe(201);
      const recovered = await waitForEvent(twoReconnected.frames, (event) => event.type === "human.message" && event.payload !== undefined && event.payload !== null && typeof event.payload === "object" && (event.payload as { messageId?: string }).messageId === "message:room-1:m-reconnect");
      expect(recovered.seq).toBeGreaterThan(cursor);
    } finally {
      for (const socket of sockets) socket.close();
      await runtime.dispose();
    }
  }, 15_000);
});
