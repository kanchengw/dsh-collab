import { describe, expect, it, vi } from "vitest";
import { createDshBrowserCollabClient, type BrowserFetch, type BrowserRequestInit, type BrowserSocket, type ParticipantResumeState } from "../../src/dsh-browser-client.js";
import { decodeCollabInvitation } from "../../src/invitation.js";

function response(data: unknown, status = 200): { ok: boolean; status: number; json(): Promise<unknown> } {
  return { ok: status < 400, status, json: async () => ({ protocol: "dsh-collab.v1", requestId: "test", ok: true, data }) };
}

describe("browser Gateway client", () => {
  it("uses live presence instead of persisted memberships for the online count", async () => {
    let socket: BrowserSocket | undefined;
    const fetch: BrowserFetch = async (url) => {
      if (url.endsWith("/bootstrap")) return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      return response({
        room: { roomId: "room-1", title: "Release", hostDisplayName: "Host" },
        members: [
          { memberId: "member-host", role: "host", status: "active" },
          { memberId: "member-old-a", role: "participant", status: "active" },
          { memberId: "member-old-b", role: "participant", status: "active" },
        ],
        lastEventSeq: 0,
      });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onmessage?: (event: { data: string }) => void;
      onclose?: () => void;
      onerror?: () => void;
      constructor() { socket = this; queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });

    await client.bootstrap();
    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "presence", roomId: "room-1", onlineMemberCount: 1 }) });

    expect(client.getSnapshot()).toMatchObject({ onlineCount: 1 });
    client.dispose();
  });

  it("connects, disconnects and forgets a saved Joined room only on explicit actions", async () => {
    const saved: ParticipantResumeState[] = [
      { gatewayEndpoint: "wss://one.example/collab", roomId: "room-1", memberId: "member-1", credential: "secret-1", roomTitle: "Design" },
      { gatewayEndpoint: "wss://two.example/collab", roomId: "room-2", memberId: "member-2", credential: "secret-2", roomTitle: "Release" },
    ];
    const requests: string[] = [];
    const fetch: BrowserFetch = async (url) => {
      requests.push(url);
      if (url.endsWith("/resume")) return response({ room: { roomId: "room-2", title: "Release" }, member: { memberId: "member-2", role: "participant" }, roomToken: "token-2" });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "room-2", title: "Release" }, members: [], lastEventSeq: 0 });
      return response({ events: [], nextSeq: 0 });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onclose?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const persistence = {
      load: (ref?: { gatewayEndpoint: string; roomId: string }) => ref ? saved.find((room) => room.gatewayEndpoint === ref.gatewayEndpoint && room.roomId === ref.roomId) : saved[0],
      list: () => saved,
      save: async () => {},
      remove: async (ref: { gatewayEndpoint: string; roomId: string }) => { const index = saved.findIndex((room) => room.gatewayEndpoint === ref.gatewayEndpoint && room.roomId === ref.roomId); if (index >= 0) saved.splice(index, 1); },
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket, participantPersistence: persistence });
    expect(client.listJoinedRooms()).toHaveLength(2);
    expect(requests).toEqual([]);

    const selected = { gatewayEndpoint: "wss://two.example/collab", roomId: "room-2" };
    await client.connectJoinedRoom(selected);
    expect(client.getSnapshot()).toMatchObject({ roomId: "room-2", role: "participant", connection: "online" });
    client.disconnectJoinedRoom();
    expect(client.getSnapshot().connection).toBe("offline");
    await client.forgetJoinedRoom(selected);
    expect(client.listJoinedRooms()).toEqual([expect.objectContaining({ roomId: "room-1" })]);
  });

  it("stops sharing without deleting the saved Host room", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/host") && init?.method === "POST") return response({ room: { roomId: "session-current", title: "Room" }, member: { memberId: "host", role: "host" }, roomToken: "token" });
      if (url.endsWith("/snapshot")) return response({ room: { roomId: "session-current", title: "Room" }, members: [], lastEventSeq: 0 });
      if (url.includes("/events?")) return response({ events: [], nextSeq: 0 });
      return response({ sharing: false });
    };
    const WebSocket = class implements BrowserSocket {
      readyState = 1;
      onopen?: () => void;
      onclose?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      send(): void {}
      close(): void { this.readyState = 3; }
    };
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket });
    await client.shareHostRoom({ sessionId: "session-current", title: "Room" });
    await client.stopSharing("session-current");

    expect(requests.at(-1)).toMatchObject({ url: "http://127.0.0.1:4310/collab/v1/rooms/session-current/host", init: { method: "DELETE" } });
    expect(client.getSnapshot()).toMatchObject({ connection: "offline" });
  });

  it("shares the exact current DSH session and trimmed Room name", async () => {
    const requests: Array<{ url: string; init?: BrowserRequestInit }> = [];
    const fetch: BrowserFetch = async (url, init) => {
      requests.push({ url, init });
      if (url.endsWith("/host")) return response({
        room: { roomId: "session-current", title: "Release room", hostDisplayName: "Host" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      return response({ room: { roomId: "session-current", title: "Release room" }, members: [], lastEventSeq: 0 });
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
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "dsh-room", fetch, WebSocket });

    await client.shareHostRoom({ sessionId: "session-current", title: "  Release room  " });

    expect(requests[0]?.url).toBe("http://127.0.0.1:4310/collab/v1/rooms/session-current/host");
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ hostSessionId: "session-current", title: "Release room" });
    expect(client.getSnapshot()).toMatchObject({ roomId: "session-current", roomTitle: "Release room", role: "host", connection: "online" });
    client.dispose();
  });

  it("keeps the active Host room when sharing another session fails", async () => {
    const requests: string[] = [];
    const fetch: BrowserFetch = async (url) => {
      requests.push(url);
      if (url.endsWith("/room-1/bootstrap")) return response({
        room: { roomId: "room-1", title: "Current room" },
        member: { memberId: "member-host", role: "host" },
        roomToken: "host-token",
      });
      if (url.endsWith("/session-denied/host")) return response({}, 403);
      if (url.endsWith("/room-1/snapshot")) return response({ room: { roomId: "room-1", title: "Current room" }, members: [], lastEventSeq: 0 });
      if (url.endsWith("/room-1/invites")) return response({ invite: { inviteId: "invite-1", roomId: "room-1", expiresAt: 100 }, token: "invite-secret" }, 201);
      throw new Error(`unexpected request ${url}`);
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
    const client = createDshBrowserCollabClient({ gatewayUrl: "http://127.0.0.1:4310/collab", roomId: "room-1", fetch, WebSocket });
    await client.bootstrap();

    await expect(client.shareHostRoom({ sessionId: "session-denied", title: "Denied" })).rejects.toThrow("403");
    await client.createInvite({ inviteId: "invite-1", expiresAt: 100, gatewayEndpoint: "ws://192.168.1.20:4310/collab" });

    expect(requests.at(-1)).toBe("http://127.0.0.1:4310/collab/v1/rooms/room-1/invites");
    client.dispose();
  });

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
        members: [{ memberId: "member-host", role: "host", displayName: "Local Host" }],
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
    expect(client.getSnapshot()).toMatchObject({ members: [{ memberId: "member-host", displayName: "Local Host" }] });
    expect(client.getSnapshot()).toMatchObject({ roomId: "room-1", role: "host", connection: "online", canSteer: true });
    await client.send({ text: "run tests", target: "dsh" });
    expect(requests.at(-1)?.url).toBe("http://127.0.0.1:3080/collab/v1/rooms/room-1/messages");
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toMatchObject({ text: "run tests", target: "dsh" });
    expect(socketUrls[0]).toContain("token=host-room-token");
    expect(new URL(socketUrls[0]!).searchParams.getAll("feature")).toContain("agent-output");
    const created = await client.createInvite({ inviteId: "invite-1", expiresAt: 100, gatewayEndpoint: "ws://192.168.1.20:4310/collab" });
    expect(decodeCollabInvitation(created.invitation)).toMatchObject({ gatewayEndpoint: "ws://192.168.1.20:4310/collab", roomId: "room-1", inviteId: "invite-1", token: "invite-secret" });
    client.dispose();
  });

  it("retains saved Joined rooms after opening the local Host room", async () => {
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
    expect(persisted).toMatchObject({ roomId: "room-2", credential: "resume-secret" });
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
        members: [{ memberId: "member-host", role: "host", displayName: "Local Host" }],
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

    socket?.onmessage?.({ data: JSON.stringify({
      protocol: "dsh-collab.v1",
      type: "agent-output",
      roomId: "room-1",
      requestId: "request-2",
      text: "partial **answer",
      streaming: true,
    }) });
    expect(client.getSnapshot().timeline?.at(-1)).toMatchObject({ eventId: "stream:request-2", kind: "agent", requestId: "request-2", text: "partial **answer", streaming: true });

    socket?.onmessage?.({ data: JSON.stringify({
      protocol: "dsh-collab.v1",
      type: "agent-output",
      roomId: "room-1",
      requestId: "request-2",
      text: "partial **answer**",
      streaming: true,
    }) });
    expect(client.getSnapshot().timeline?.filter((item) => item.requestId === "request-2")).toHaveLength(1);

    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "event", event: {
      eventId: "agent-2", roomId: "room-1", seq: 3, type: "agent.state.changed",
      actor: { memberId: "member-host", principalId: "host" }, createdAt: 3, payload: { requestId: "request-2", state: "output", text: "final **answer**" },
    } }) });
    expect(client.getSnapshot().timeline?.filter((item) => item.requestId === "request-2")).toEqual([
      expect.objectContaining({ eventId: "agent-2", text: "final **answer**", streaming: false }),
    ]);

    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "event", event: {
      eventId: "human-2", roomId: "room-1", seq: 4, type: "human.message",
      actor: { memberId: "member-host", principalId: "host" }, createdAt: 4, payload: { text: "live" },
    } }) });
    expect(client.getSnapshot().timeline?.at(-1)).toMatchObject({ kind: "human", text: "live" });

    socket?.onmessage?.({ data: JSON.stringify({ protocol: "dsh-collab.v1", type: "event", event: {
      eventId: "member-joined", roomId: "room-1", seq: 5, type: "member.joined",
      actor: { memberId: "member-bob", principalId: "bob" }, createdAt: 5,
      payload: { memberId: "member-bob", displayName: "Bob", role: "participant" },
    } }) });
    expect(client.getSnapshot()).toMatchObject({
      members: [
        { memberId: "member-host", displayName: "Local Host" },
        { memberId: "member-bob", displayName: "Bob" },
      ],
    });

    socket?.onmessage?.({ data: JSON.stringify({
      protocol: "dsh-collab.v1", type: "agent-output", roomId: "room-1",
      requestId: "request-3", text: "do not retain", streaming: true,
    }) });
    client.disconnect();
    expect(client.getSnapshot().timeline?.some((item) => item.requestId === "request-3")).toBe(false);
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
    expect(persisted).toEqual({ gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret", roomTitle: "Remote" });
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

  it("reconnects the explicitly selected Joined room instead of the first saved room", async () => {
    vi.useFakeTimers();
    try {
      const first: ParticipantResumeState = { gatewayEndpoint: "wss://first.example/collab", roomId: "room-first", memberId: "member-bob", credential: "first-secret" };
      const second: ParticipantResumeState = { gatewayEndpoint: "wss://second.example/collab", roomId: "room-second", memberId: "member-bob", credential: "second-secret" };
      const loaded: Array<{ gatewayEndpoint: string; roomId: string } | undefined> = [];
      const sockets: BrowserSocket[] = [];
      const fetch: BrowserFetch = async (url) => {
        const roomId = url.includes("second.example") ? "room-second" : "room-first";
        if (url.endsWith("/resume")) return response({ room: { roomId, title: roomId }, member: { memberId: "member-bob", role: "participant" }, roomToken: `${roomId}-token` });
        if (url.endsWith("/snapshot")) return response({ room: { roomId, title: roomId }, members: [], lastEventSeq: 0 });
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
        participantPersistence: {
          load: (ref) => {
            loaded.push(ref);
            if (!ref) return first;
            return [first, second].find((room) => room.gatewayEndpoint === ref.gatewayEndpoint && room.roomId === ref.roomId);
          },
          save: async () => {},
          clear: async () => {},
        },
      });

      await client.connectJoinedRoom({ gatewayEndpoint: second.gatewayEndpoint, roomId: second.roomId });
      sockets[0]?.onclose?.();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(client.getSnapshot()).toMatchObject({ roomId: "room-second", connection: "online" });
      expect(loaded).toEqual([
        { gatewayEndpoint: second.gatewayEndpoint, roomId: second.roomId },
        { gatewayEndpoint: second.gatewayEndpoint, roomId: second.roomId },
        { gatewayEndpoint: second.gatewayEndpoint, roomId: second.roomId },
      ]);
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

      expect(persisted).toMatchObject({ roomId: "room-old", credential: "old-secret" });
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
