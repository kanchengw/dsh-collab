import { describe, expect, it } from "vitest";
import { createDshBrowserCollabClient, type BrowserFetch, type BrowserRequestInit, type BrowserSocket } from "../../src/dsh-browser-client.js";

function response(data: unknown, status = 200): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: status < 400, status, json: async () => ({ protocol: "dsh-collab.v1", requestId: "test", ok: true, data }) };
}

describe("browser Gateway client", () => {
  it("bootstraps a Host, connects with the browser-safe token query, and sends an Agent request", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const socketUrls: string[] = [];
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-room-token",
      });
      if (url.endsWith("/snapshot")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        members: [{ memberId: "member-host", role: "host" }],
        lastEventSeq: 0,
      });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      return response({ request: { requestId: "request-1" } }, 202);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor(readonly url: string) { socketUrls.push(url); queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; this.onclose?.(); }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:3080/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();
    expect(client.getSnapshot()).toMatchObject({ roomId: "room-1", role: "host", connection: "online", canSteer: true });
    await client.send({ text: "run tests", target: "dsh" });
    expect(requests.at(-1)?.url).toBe("http://127.0.0.1:3080/collab/v1/rooms/room-1/messages");
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toMatchObject({ text: "run tests", target: "dsh" });
    expect(socketUrls[0]).toContain("token=host-room-token");
    client.dispose();
  });

  it("joins as a Participant with its own principal and never enables steer", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/join")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        member: { memberId: "member-bob", role: "participant" },
        roomToken: "bob-room-token",
      }, 201);
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      return response({
        room: { roomId: "room-1", title: "Release" },
        members: [{ memberId: "member-host", role: "host", displayName: "Local Host" }],
        lastEventSeq: 0,
      });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; this.onclose?.(); }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:3080/collab", roomId: "room-1", role: "participant", fetch, WebSocket });
    await client.join({ inviteId: "invite-1", inviteToken: "invite-token", memberId: "member-bob", displayName: "Bob", principalId: "bob", gatewayUrl: "https://collab.example/collab" }, "room-2");
    expect(client.getSnapshot()).toMatchObject({ role: "participant", canSteer: false, connection: "online", hostDisplayName: "Local Host" });
    expect(requests[0]?.init?.headers).not.toHaveProperty("x-dsh-principal-id");
    expect(requests[0]?.url).toBe("https://collab.example/collab/v1/rooms/room-2/join");
  });

  it("recovers room events and projects live human and Agent output into the timeline", async () => {
    const requests: string[] = [];
    let socket: BrowserSocket | undefined;
    const fetch: BrowserFetch = async (url) => {
      requests.push(url);
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-room-token",
      });
      if (url.endsWith("/snapshot")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        members: [{ memberId: "member-host", role: "host" }],
        lastEventSeq: 2,
      });
      if (url.includes("/events?")) return response({ events: [
        { eventId: "human-1", roomId: "room-1", seq: 1, type: "human.message", actor: { memberId: "member-host", principalId: "host" }, createdAt: 1, payload: { text: "hello" } },
        { eventId: "agent-1", roomId: "room-1", seq: 2, type: "agent.state.changed", actor: { memberId: "member-host", principalId: "host" }, createdAt: 2, payload: { requestId: "request-1", state: "output", text: "done" } },
      ] });
      throw new Error(`unexpected request ${url}`);
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor(readonly url: string) { socket = this; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; this.onclose?.(); }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:3080/collab", roomId: "room-1", fetch, WebSocket });

    await client.bootstrap();
    expect(requests).toContain("http://127.0.0.1:3080/collab/v1/rooms/room-1/events?after=0&limit=500");
    expect(client.getSnapshot().timeline).toMatchObject([
      { kind: "human", text: "hello" },
      { kind: "agent", text: "done", state: "output" },
    ]);

    socket?.onmessage?.({ data: JSON.stringify({ type: "event", event: {
      eventId: "human-2", roomId: "room-1", seq: 3, type: "human.message",
      actor: { memberId: "member-host", principalId: "host" }, createdAt: 3, payload: { text: "live" },
    } }) });
    expect(client.getSnapshot().timeline?.at(-1)).toMatchObject({ kind: "human", text: "live" });
  });
});
