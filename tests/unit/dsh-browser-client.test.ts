import { describe, expect, it, vi } from "vitest";
import { createDshBrowserCollabClient, type BrowserFetch, type BrowserRequestInit, type BrowserSocket, type ParticipantResumeState } from "../../src/dsh-browser-client.js";
import { decodeCollabInvitation } from "../../src/invitation.js";

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
      if (url.endsWith("/invites")) return response({ invite: { inviteId: "invite-1", roomId: "room-1", expiresAt: 100 }, token: "invite-secret" }, 201);
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
    const created = await client.createInvite({ inviteId: "invite-1", expiresAt: 100, gatewayEndpoint: "ws://192.168.1.20:4310/collab" });
    expect(decodeCollabInvitation(created.invitation)).toMatchObject({ gatewayEndpoint: "ws://192.168.1.20:4310/collab", roomId: "room-1", inviteId: "invite-1", token: "invite-secret" });
    client.dispose();
  });

  it("clears a saved remote Participant role after opening the local Host room", async () => {
    let persisted: ParticipantResumeState | undefined = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" };
    const fetch: BrowserFetch = async (url) => url.endsWith("/bootstrap") ? response({
      room: { roomId: "room-1", title: "Local" }, member: { memberId: "member-host", role: "host" }, roomToken: "host-token",
    }) : response({ room: { roomId: "room-1", title: "Local" }, members: [], lastEventSeq: 0 });
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket,
      participantPersistence: { load: () => persisted, save: async (state) => { persisted = state; }, clear: async () => { persisted = undefined; } },
    });
    await client.bootstrap();
    expect(client.getSnapshot().role).toBe("host");
    expect(persisted).toBeUndefined();
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
    await client.join({
      invitation: JSON.stringify({ protocol: "dsh-collab.v1", type: "invite", gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", inviteId: "invite-1", token: "invite-token", expiresAt: 100 }),
      memberId: "member-bob",
      displayName: "Bob",
    });
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

  it("paginates recovery through the authoritative event sequence", async () => {
    const eventCursors: number[] = [];
    let socketUrl = "";
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-room-token",
      });
      if (url.endsWith("/snapshot")) return response({
        room: { roomId: "room-1", title: "Release" },
        members: [{ memberId: "member-host", role: "host" }],
        lastEventSeq: 1_001,
      });
      const after = Number(new URL(url).searchParams.get("after"));
      eventCursors.push(after);
      const end = Math.min(after + 500, 1_001);
      const events = Array.from({ length: end - after }, (_, offset) => {
        const seq = after + offset + 1;
        return { eventId: `event-${String(seq)}`, roomId: "room-1", seq, type: "human.message", actor: { memberId: "member-host", principalId: "host" }, createdAt: seq, payload: { text: String(seq) } };
      });
      return response({ events, nextSeq: end });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor(url: string) { socketUrl = url; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });

    await client.bootstrap();

    expect(eventCursors).toEqual([0, 500, 1_000]);
    expect(client.getSnapshot().timeline).toHaveLength(1_001);
    expect(new URL(socketUrl).searchParams.get("after")).toBe("1001");
    client.dispose();
  });

  it("persists join credentials in the Participant DSH and resumes without reusing the invite", async () => {
    let persisted: ParticipantResumeState | undefined;
    const urls: string[] = [];
    const fetch: BrowserFetch = async (url) => {
      urls.push(url);
      if (url.endsWith("/join")) return response({
        room: { roomId: "room-2", title: "Remote" },
        member: { memberId: "member-bob", role: "participant" },
        roomToken: "room-token-1",
        resumeCredential: "resume-secret",
      }, 201);
      if (url.endsWith("/resume")) return response({
        room: { roomId: "room-2", title: "Remote" },
        member: { memberId: "member-bob", role: "participant" },
        roomToken: "room-token-2",
      });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-2", title: "Remote" }, members: [], lastEventSeq: 0 });
      return response({ events: [], nextSeq: 0 });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const persistence = {
      load: () => persisted,
      save: async (state: ParticipantResumeState) => { persisted = state; },
      clear: async () => { persisted = undefined; },
    };
    const invitation = JSON.stringify({ protocol: "dsh-collab.v1", type: "invite", gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", inviteId: "invite-1", token: "invite-token", expiresAt: 100 });
    const first = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket, participantPersistence: persistence });
    await first.join({ invitation, memberId: "member-bob", displayName: "Bob" });
    expect(persisted).toEqual({ gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" });
    first.dispose();

    const second = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket, participantPersistence: persistence });
    await expect(second.restoreParticipant()).resolves.toBe(true);
    expect(second.getSnapshot()).toMatchObject({ roomId: "room-2", role: "participant", connection: "online" });
    expect(urls.filter((url) => url.endsWith("/join"))).toHaveLength(1);
    expect(urls.filter((url) => url.endsWith("/resume"))).toHaveLength(1);
  });

  it("resumes a live Participant after the Host Gateway restarts", async () => {
    vi.useFakeTimers();
    try {
      const persisted: ParticipantResumeState = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" };
      const sockets: BrowserSocket[] = [];
      let resumeRequests = 0;
      const fetch: BrowserFetch = async (url) => {
        if (url.endsWith("/resume")) {
          resumeRequests += 1;
          if (resumeRequests === 2) throw new Error("Host Gateway is offline");
          return response({
            room: { roomId: "room-2", title: "Remote" },
            member: { memberId: "member-bob", role: "participant" },
            roomToken: `room-token-${String(resumeRequests)}`,
          });
        }
        if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-2", title: "Remote" }, members: [], lastEventSeq: 0 });
        return response({ events: [], nextSeq: 0 });
      };
      const WebSocket = class implements BrowserSocket {
        readyState = 1;
        onopen?: () => void;
        onmessage?: (event: { data: string }) => void;
        onclose?: () => void;
        onerror?: () => void;
        constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
        send(): void {}
        close(): void { this.readyState = 3; }
      };
      const client = createDshBrowserCollabClient({
        gatewayUrl: "http://127.0.0.1:4310/collab",
        roomId: "dsh-room",
        fetch,
        WebSocket,
        participantPersistence: { load: () => persisted, save: async () => {}, clear: async () => {} },
      });

      await expect(client.restoreParticipant()).resolves.toBe(true);
      expect(client.getSnapshot().connection).toBe("online");
      sockets[0]?.onclose?.();
      expect(client.getSnapshot().connection).toBe("offline");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(resumeRequests).toBe(2);
      expect(sockets).toHaveLength(1);
      expect(client.getSnapshot().connection).toBe("offline");
      await vi.advanceTimersByTimeAsync(2_000);

      expect(resumeRequests).toBe(3);
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot().connection).toBe("online");
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebootstraps a Host stream after it disconnects", async () => {
    vi.useFakeTimers();
    try {
      let persisted: ParticipantResumeState | undefined = { gatewayEndpoint: "wss://old.example/collab", roomId: "room-old", memberId: "member-old", credential: "old-secret" };
      const sockets: BrowserSocket[] = [];
      let bootstrapRequests = 0;
      const fetch: BrowserFetch = async (url) => {
        if (url.endsWith("/bootstrap")) {
          bootstrapRequests += 1;
          return response({
            room: { roomId: "room-1", title: "Local" },
            member: { memberId: "member-host", role: "host" },
            roomToken: `host-token-${String(bootstrapRequests)}`,
          });
        }
        if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-1", title: "Local" }, members: [], lastEventSeq: 0 });
        return response({ events: [], nextSeq: 0 });
      };
      const WebSocket = class implements BrowserSocket {
        readyState = 1;
        onopen?: () => void;
        onmessage?: (event: { data: string }) => void;
        onclose?: () => void;
        onerror?: () => void;
        constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
        send(): void {}
        close(): void { this.readyState = 3; }
      };
      const client = createDshBrowserCollabClient({
        gatewayUrl: "http://127.0.0.1:4310/collab",
        roomId: "room-1",
        fetch,
        WebSocket,
        participantPersistence: { load: () => persisted, save: async () => {}, clear: async () => { persisted = undefined; } },
      });

      await client.bootstrap();
      sockets[0]?.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(persisted).toBeUndefined();
      expect(bootstrapRequests).toBe(2);
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot()).toMatchObject({ role: "host", connection: "online" });
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("replaces a silent Participant stream when heartbeat responses stop", async () => {
    vi.useFakeTimers();
    try {
      const persisted: ParticipantResumeState = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" };
      const sockets: BrowserSocket[] = [];
      const sent: string[] = [];
      let resumeRequests = 0;
      const fetch: BrowserFetch = async (url) => {
        if (url.endsWith("/resume")) {
          resumeRequests += 1;
          return response({
            room: { roomId: "room-2", title: "Remote" },
            member: { memberId: "member-bob", role: "participant" },
            roomToken: `room-token-${String(resumeRequests)}`,
          });
        }
        if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-2", title: "Remote" }, members: [], lastEventSeq: 0 });
        return response({ events: [], nextSeq: 0 });
      };
      const WebSocket = class implements BrowserSocket {
        readyState = 1;
        onopen?: () => void;
        onmessage?: (event: { data: string }) => void;
        onclose?: () => void;
        onerror?: () => void;
        constructor() { sockets.push(this); queueMicrotask(() => this.onopen?.()); }
        send(data: string): void { sent.push(data); }
        close(): void { this.readyState = 2; }
      };
      const client = createDshBrowserCollabClient({
        gatewayUrl: "http://127.0.0.1:4310/collab",
        roomId: "dsh-room",
        fetch,
        WebSocket,
        participantPersistence: { load: () => persisted, save: async () => {}, clear: async () => {} },
      });

      await expect(client.restoreParticipant()).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sent.map((frame) => JSON.parse(frame))).toContainEqual({ protocol: "dsh-collab.v1", type: "heartbeat" });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(client.getSnapshot().connection).toBe("offline");
      await vi.advanceTimersByTimeAsync(1_000);

      expect(resumeRequests).toBe(2);
      expect(sockets).toHaveLength(2);
      expect(client.getSnapshot().connection).toBe("online");
      client.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears a rejected resume credential but retains it on a network failure", async () => {
    let persisted: ParticipantResumeState | undefined = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "rejected" };
    const persistence = { load: () => persisted, save: async (state: ParticipantResumeState) => { persisted = state; }, clear: async () => { persisted = undefined; } };
    const rejected = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", participantPersistence: persistence,
      fetch: async () => ({ ok: false, status: 401, json: async () => ({ ok: false, error: { message: "invalid" } }) }),
      WebSocket: class {} as never,
    });
    await expect(rejected.restoreParticipant()).rejects.toThrow();
    expect(persisted).toBeUndefined();

    persisted = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "offline" };
    const offline = createDshBrowserCollabClient({
      gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", participantPersistence: persistence,
      fetch: async () => { throw new Error("network offline"); }, WebSocket: class {} as never,
    });
    await expect(offline.restoreParticipant()).rejects.toThrow("network offline");
    expect(persisted?.credential).toBe("offline");
  });
});
