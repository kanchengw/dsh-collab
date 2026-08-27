import type { ComposerTarget } from "./ui.js";
import { projectTimeline } from "./ui.js";
import { gatewayHttpUrl } from "./endpoint-policy.js";
import { decodeCollabInvitation, encodeCollabInvitation } from "./invitation.js";
import { COLLAB_PROTOCOL, decodeServerStreamFrame, encodeClientStreamFrame } from "./protocol.js";
import type { AgentOutputFrame, RoomEvent, StreamFrame } from "./types.js";
import type { DshCollabClientPort, DshCollabClientSnapshot, DshCollabSettingsPort } from "./dsh-client.js";

export interface BrowserRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface BrowserResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type BrowserFetch = (url: string, init?: BrowserRequestInit) => Promise<BrowserResponse>;

export interface BrowserSocket {
  readonly readyState: number;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface DshBrowserCollabOptions {
  gatewayUrl: string;
  roomId: string;
  role?: "host" | "participant";
  principalId?: string;
  token?: string;
  fetch?: BrowserFetch;
  WebSocket?: new (url: string) => BrowserSocket;
  connectionIdFactory?: () => string;
  participantPersistence?: ParticipantPersistence;
}

export interface ParticipantResumeState {
  gatewayEndpoint: string;
  roomId: string;
  memberId: string;
  credential: string;
  roomTitle?: string;
  hostDisplayName?: string;
}

export interface JoinedRoomRef { gatewayEndpoint: string; roomId: string }

export interface ParticipantPersistence {
  load(ref?: JoinedRoomRef): ParticipantResumeState | undefined;
  list?(): readonly ParticipantResumeState[];
  subscribe?(listener: () => void): () => void;
  save(state: ParticipantResumeState): Promise<void>;
  remove?(ref: JoinedRoomRef): Promise<void>;
  clear?(): Promise<void>;
}

export interface DshBrowserJoinInput {
  invitation: string;
  memberId?: string;
  displayName: string;
}

export interface DshBrowserInviteInput {
  inviteId?: string;
  expiresAt: number;
  gatewayEndpoint: string;
}

export interface DshBrowserSettingsPort extends DshCollabSettingsPort {
  bootstrap(roomId?: string): Promise<void>;
  shareHostRoom(input: { sessionId: string; title: string }): Promise<void>;
  stopSharing(roomId: string): Promise<void>;
  join(input: DshBrowserJoinInput, roomId?: string): Promise<void>;
  createInvite(input: DshBrowserInviteInput, roomId?: string): Promise<{ invitation: string }>;
  listJoinedRooms(): readonly ParticipantResumeState[];
  subscribeJoinedRooms(listener: () => void): () => void;
  connectJoinedRoom(ref: JoinedRoomRef): Promise<void>;
  disconnectJoinedRoom(): void;
  forgetJoinedRoom(ref: JoinedRoomRef): Promise<void>;
  configureGateway?(input: { gatewayHost: string; gatewayPort: number }): void;
}

type RoomData = {
  room: { roomId: string; title: string; hostDisplayName?: string };
  member: { memberId: string; role: string; displayName?: string };
  roomToken: string;
  resumeCredential?: string;
};

type SnapshotData = {
  room: { roomId: string; title: string; hostDisplayName?: string };
  members: Array<{ memberId: string; role: string; displayName?: string; status?: string }>;
  lastEventSeq: number;
};

type EventsData = { events: RoomEvent[]; nextSeq?: number };

type Envelope = { ok: boolean; data?: unknown; error?: { message?: string } };

const OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 5_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 5_000;

function randomId(prefix: string): string {
  const crypto = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  return `${prefix}_${crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function defaultFetch(): BrowserFetch {
  const fetch = (globalThis as unknown as { fetch?: BrowserFetch }).fetch;
  if (!fetch) throw new Error("browser fetch is unavailable");
  return fetch.bind(globalThis);
}

function defaultWebSocket(): new (url: string) => BrowserSocket {
  const WebSocket = (globalThis as unknown as { WebSocket?: new (url: string) => BrowserSocket }).WebSocket;
  if (!WebSocket) throw new Error("browser WebSocket is unavailable");
  return WebSocket;
}

function normalizeBase(value: string): string {
  const base = value.trim().replace(/\/+$/, "");
  if (base === "") throw new Error("gatewayUrl must not be blank");
  return base;
}

function parseEnvelope(value: unknown): unknown {
  if (!value || typeof value !== "object") throw new Error("invalid Gateway response");
  const envelope = value as Envelope;
  if (!envelope.ok) throw new Error(envelope.error?.message ?? "Gateway request failed");
  return envelope.data;
}

function roomData(value: unknown): RoomData {
  if (!value || typeof value !== "object") throw new Error("Gateway room response is invalid");
  const data = value as RoomData;
  if (!data.room || !data.member || typeof data.roomToken !== "string") throw new Error("Gateway room response is incomplete");
  return data;
}

export class DshBrowserCollabClient implements DshCollabClientPort {
  private hostBase: string;
  private base: string;
  private readonly fetcher: BrowserFetch;
  private readonly socketFactory: new (url: string) => BrowserSocket;
  private readonly connectionIdFactory: () => string;
  private roomId: string;
  private readonly listeners = new Set<() => void>();
  private socket: BrowserSocket | undefined;
  private token: string | undefined;
  private lastEventSeq = 0;
  private readonly events = new Map<string, RoomEvent>();
  private readonly activeAgentOutputs = new Map<string, AgentOutputFrame>();
  private snapshot: DshCollabClientSnapshot;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatAcknowledged = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private disposed = false;
  private manuallyDisconnected = false;
  private participantRef: JoinedRoomRef | undefined;

  constructor(private readonly options: DshBrowserCollabOptions) {
    this.hostBase = normalizeBase(options.gatewayUrl);
    this.base = this.hostBase;
    this.roomId = options.roomId;
    this.fetcher = options.fetch ?? defaultFetch();
    this.socketFactory = options.WebSocket ?? defaultWebSocket();
    this.connectionIdFactory = options.connectionIdFactory ?? (() => randomId("conn"));
    this.token = options.token;
    this.snapshot = {
      roomId: options.roomId,
      roomTitle: "Collaboration room",
      hostDisplayName: "",
      role: options.role ?? "participant",
      connection: options.token ? "connecting" : "offline",
      onlineCount: 0,
      canSteer: options.role === "host",
      members: [],
      timeline: [],
    };
  }

  getSnapshot(): DshCollabClientSnapshot { return { ...this.snapshot }; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getSettingsSnapshot(): { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; advertisedEndpoint: string } {
    const url = new URL(this.hostBase);
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    return { gatewayHost: url.hostname, gatewayPort: port, exposeMode: url.hostname === "127.0.0.1" ? "loopback" : "network", advertisedEndpoint: "" };
  }

  configureGateway(input: { gatewayHost: string; gatewayPort: number }): void {
    const hostname = input.gatewayHost === "0.0.0.0" ? "127.0.0.1" : input.gatewayHost;
    this.hostBase = normalizeBase(`http://${hostname}:${String(input.gatewayPort)}/collab`);
  }

  settingsPort(): DshBrowserSettingsPort { return new DshBrowserCollabSettings(this); }

  async bootstrap(roomId?: string): Promise<void> {
    this.base = this.hostBase;
    this.participantRef = undefined;
    if (roomId?.trim()) this.roomId = roomId.trim();
    const data = roomData(parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(this.roomId)}/bootstrap`, undefined, false)));
    this.applyRoom(data);
    await this.connect();
  }

  async shareHostRoom(input: { sessionId: string; title: string }): Promise<void> {
    const sessionId = input.sessionId.trim();
    const title = input.title.trim();
    if (sessionId === "") throw new Error("sessionId must not be blank");
    if (title === "") throw new Error("Room name must not be blank");
    if (title.length > 80) throw new Error("Room name must be at most 80 characters");
    const data = roomData(parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(sessionId)}/host`, { hostSessionId: sessionId, title }, false, this.hostBase)));
    this.base = this.hostBase;
    this.participantRef = undefined;
    this.roomId = sessionId;
    this.applyRoom(data);
    await this.connect();
  }

  async stopSharing(roomId: string): Promise<void> {
    const normalizedRoomId = roomId.trim();
    if (normalizedRoomId === "") throw new Error("roomId must not be blank");
    parseEnvelope(await this.request("DELETE", `/v1/rooms/${encodeURIComponent(normalizedRoomId)}/host`, undefined, false, this.hostBase));
    this.disconnect();
  }

  disconnect(): void {
    this.manuallyDisconnected = true;
    this.participantRef = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    this.token = undefined;
    this.activeAgentOutputs.clear();
    this.snapshot = { ...this.snapshot, timeline: this.projectTimeline() };
    socket?.close(1000, "client_disconnected");
    this.setConnection("offline");
  }

  async join(input: DshBrowserJoinInput, roomId?: string): Promise<void> {
    const invitation = decodeCollabInvitation(input.invitation);
    this.base = normalizeBase(gatewayHttpUrl(invitation.gatewayEndpoint));
    this.roomId = invitation.roomId;
    const data = roomData(parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(this.roomId)}/join`, {
      inviteId: invitation.inviteId,
      token: invitation.token,
      memberId: input.memberId?.trim() || randomId("member"),
      displayName: input.displayName,
    }, false)));
    if (this.options.participantPersistence) {
      if (typeof data.resumeCredential !== "string" || data.resumeCredential.trim() === "") throw new Error("Gateway join response is missing a resume credential");
      await this.options.participantPersistence.save({
        gatewayEndpoint: invitation.gatewayEndpoint,
        roomId: invitation.roomId,
        memberId: data.member.memberId,
        credential: data.resumeCredential,
        roomTitle: data.room.title,
        ...(data.room.hostDisplayName ? { hostDisplayName: data.room.hostDisplayName } : {}),
      });
    }
    this.participantRef = { gatewayEndpoint: invitation.gatewayEndpoint, roomId: invitation.roomId };
    this.applyRoom(data);
    await this.connect();
  }

  async restoreParticipant(ref?: JoinedRoomRef): Promise<boolean> {
    const state = this.options.participantPersistence?.load(ref);
    if (!state) return false;
    this.participantRef = { gatewayEndpoint: state.gatewayEndpoint, roomId: state.roomId };
    this.base = normalizeBase(gatewayHttpUrl(state.gatewayEndpoint));
    this.roomId = state.roomId;
    try {
      const data = roomData(parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(this.roomId)}/resume`, { credential: state.credential }, false)));
      this.applyRoom(data);
      await this.connect();
      return true;
    } catch (error) {
      if (error instanceof GatewayRequestError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        if (this.options.participantPersistence?.remove) await this.options.participantPersistence.remove(state);
        else await this.options.participantPersistence?.clear?.();
      }
      throw error;
    }
  }

  listJoinedRooms(): readonly ParticipantResumeState[] {
    return this.options.participantPersistence?.list?.() ?? [];
  }

  subscribeJoinedRooms(listener: () => void): () => void {
    return this.options.participantPersistence?.subscribe?.(listener) ?? (() => {});
  }

  async connectJoinedRoom(ref: JoinedRoomRef): Promise<void> {
    if (!(await this.restoreParticipant(ref))) throw new Error("Joined room is not saved");
  }

  disconnectJoinedRoom(): void { this.disconnect(); }

  async forgetJoinedRoom(ref: JoinedRoomRef): Promise<void> {
    const saved = this.options.participantPersistence?.load(ref);
    if (!saved) return;
    if (this.snapshot.role === "participant" && this.roomId === ref.roomId && this.base === normalizeBase(gatewayHttpUrl(ref.gatewayEndpoint))) this.disconnect();
    if (this.options.participantPersistence?.remove) await this.options.participantPersistence.remove(ref);
    else await this.options.participantPersistence?.clear?.();
  }

  async createInvite(input: DshBrowserInviteInput, roomId?: string): Promise<{ invitation: string }> {
    this.base = this.hostBase;
    if (roomId?.trim()) this.roomId = roomId.trim();
    const inviteId = input.inviteId?.trim() || randomId("invite");
    const data = parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(this.roomId)}/invites`, { inviteId, expiresAt: input.expiresAt }, false));
    const created = data as { invite?: { inviteId?: unknown; roomId?: unknown; expiresAt?: unknown }; token?: unknown };
    if (!created?.invite || typeof created.invite.inviteId !== "string" || typeof created.invite.roomId !== "string" || typeof created.invite.expiresAt !== "number" || typeof created.token !== "string") {
      throw new Error("Gateway invite response is invalid");
    }
    return { invitation: encodeCollabInvitation({
      protocol: "dsh-collab.v1",
      type: "invite",
      gatewayEndpoint: input.gatewayEndpoint,
      roomId: created.invite.roomId,
      inviteId: created.invite.inviteId,
      token: created.token,
      expiresAt: created.invite.expiresAt,
    }) };
  }

  async send(input: { text: string; target: ComposerTarget }): Promise<void> {
    if (!this.token) throw new Error("join or bootstrap a collaboration room first");
    await this.request("POST", `/v1/rooms/${encodeURIComponent(this.roomId)}/messages`, {
      clientMessageId: randomId("message"),
      text: input.text,
      target: input.target,
    }, true);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "client_closed");
    this.setConnection("offline");
    this.listeners.clear();
  }

  private async connect(): Promise<void> {
    this.manuallyDisconnected = false;
    if (!this.token) throw new Error("room token is missing");
    const snapshot = parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(this.roomId)}/snapshot`, undefined, true)) as SnapshotData;
    await this.recoverEvents(snapshot.lastEventSeq);
    this.activeAgentOutputs.clear();
    this.lastEventSeq = Math.max(snapshot.lastEventSeq, ...[...this.events.values()].map((event) => event.seq));
    this.snapshot = {
      ...this.snapshot,
      roomId: snapshot.room.roomId,
      roomTitle: snapshot.room.title,
      hostDisplayName: snapshot.room.hostDisplayName ?? snapshot.members.find((member) => member.role === "host")?.displayName ?? this.snapshot.hostDisplayName,
      onlineCount: 0,
      members: snapshot.members.flatMap((member) => typeof member.displayName === "string" && member.displayName.trim() !== ""
        ? [{ memberId: member.memberId, displayName: member.displayName }]
        : []),
      timeline: this.projectTimeline(),
    };
    this.emit();
    const previousSocket = this.socket;
    this.socket = undefined;
    this.clearHeartbeat();
    previousSocket?.close(1000, "reconnect");
    this.setConnection("connecting");
    const url = new URL(this.base.replace(/^http/, "ws") + "/v1/stream");
    url.searchParams.set("roomId", this.roomId);
    url.searchParams.set("after", String(this.lastEventSeq));
    url.searchParams.set("connectionId", this.connectionIdFactory());
    url.searchParams.set("token", this.token);
    url.searchParams.append("feature", "agent-output");
    await new Promise<void>((resolve, reject) => {
      const socket = new this.socketFactory(url.toString());
      this.socket = socket;
      let settled = false;
      socket.onopen = () => { this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS; this.startHeartbeat(socket); this.setConnection("online"); settled = true; resolve(); };
      socket.onmessage = (event) => { if (this.socket !== socket) return; this.heartbeatAcknowledged = true; this.applyFrame(event.data); };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = undefined;
        this.clearHeartbeat();
        this.setConnection("offline");
        if (!settled) reject(new Error("collaboration stream closed"));
        else this.scheduleReconnect();
      };
      socket.onerror = () => {
        if (this.socket !== socket) return;
        if (!settled) { settled = true; reject(new Error("collaboration stream failed")); }
        this.setConnection("offline");
      };
    });
  }

  private startHeartbeat(socket: BrowserSocket): void {
    this.clearHeartbeat();
    this.heartbeatAcknowledged = true;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== OPEN) return;
      if (!this.heartbeatAcknowledged) {
        this.socket = undefined;
        this.clearHeartbeat();
        this.setConnection("offline");
        this.scheduleReconnect();
        socket.close(4000, "heartbeat_timeout");
        return;
      }
      this.heartbeatAcknowledged = false;
      socket.send(JSON.stringify(encodeClientStreamFrame({ protocol: COLLAB_PROTOCOL, type: "heartbeat" })));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.heartbeatAcknowledged = true;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.manuallyDisconnected || this.reconnectTimer) return;
    if (this.snapshot.role === "participant" && (!this.participantRef || !this.options.participantPersistence?.load(this.participantRef))) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      const reconnect = this.snapshot.role === "host" ? this.bootstrap() : this.restoreParticipant(this.participantRef);
      void reconnect.catch(() => {
        this.reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async request(method: string, path: string, body: unknown, withToken: boolean, base = this.base): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (withToken && this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await this.fetcher(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const envelope = await response.json();
    if (!response.ok) throw new GatewayRequestError(response.status);
    return envelope;
  }

  private applyRoom(data: RoomData): void {
    const sameRoom = data.room.roomId === this.snapshot.roomId;
    if (!sameRoom) {
      this.events.clear();
      this.activeAgentOutputs.clear();
    }
    this.token = data.roomToken;
    this.snapshot = {
      roomId: data.room.roomId,
      roomTitle: data.room.title,
      hostDisplayName: data.room.hostDisplayName ?? this.snapshot.hostDisplayName,
      role: data.member.role === "host" ? "host" : "participant",
      connection: "connecting",
      onlineCount: sameRoom ? this.snapshot.onlineCount : 0,
      canSteer: data.member.role === "host" || data.member.role === "lead",
      members: sameRoom
        ? this.snapshot.members
        : typeof data.member.displayName === "string" && data.member.displayName.trim() !== ""
          ? [{ memberId: data.member.memberId, displayName: data.member.displayName }]
          : [],
      timeline: this.projectTimeline(),
    };
    this.emit();
  }

  private applyFrame(raw: string): void {
    let frame: StreamFrame;
    try { frame = decodeServerStreamFrame(JSON.parse(raw) as unknown); } catch { return; }
    if (frame.kind === "presence" && frame.roomId === this.snapshot.roomId) {
      this.snapshot = { ...this.snapshot, onlineCount: frame.onlineMemberCount };
      this.emit();
      return;
    }
    if (frame.kind === "agent-output" && frame.roomId === this.snapshot.roomId) {
      if (frame.streaming) this.activeAgentOutputs.set(frame.requestId, frame);
      else this.activeAgentOutputs.delete(frame.requestId);
      this.snapshot = { ...this.snapshot, timeline: this.projectTimeline() };
      this.emit();
      return;
    }
    if (frame.kind === "event") {
      const event = frame.event;
      if (this.events.has(event.eventId)) return;
      this.events.set(event.eventId, event);
      this.lastEventSeq = Math.max(this.lastEventSeq, event.seq);
      if (event.type === "agent.state.changed" || event.type === "agent.request.completed" || event.type === "agent.request.failed" || event.type === "agent.request.rejected" || event.type === "agent.request.cancelled") {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : undefined;
        if (typeof payload?.requestId === "string") this.activeAgentOutputs.delete(payload.requestId);
      }
      let members = this.snapshot.members;
      if (event.type === "member.joined" && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
        const payload = event.payload as Record<string, unknown>;
        if (typeof payload.memberId === "string" && typeof payload.displayName === "string" && payload.displayName.trim() !== "") {
          members = [...(members ?? []).filter((member) => member.memberId !== payload.memberId), { memberId: payload.memberId, displayName: payload.displayName }];
        }
      }
      this.snapshot = { ...this.snapshot, members, timeline: this.projectTimeline() };
      this.emit();
    }
  }

  private projectTimeline(): DshCollabClientSnapshot["timeline"] {
    return projectTimeline([...this.events.values()], [...this.activeAgentOutputs.values()]);
  }

  private async recoverEvents(untilSeq: number): Promise<void> {
    let after = 0;
    while (after < untilSeq) {
      const data = parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(this.roomId)}/events?after=${String(after)}&limit=500`, undefined, true)) as EventsData;
      if (!Array.isArray(data.events) || data.events.length === 0) break;
      for (const event of data.events) this.events.set(event.eventId, event);
      const next = data.nextSeq ?? data.events.at(-1)?.seq ?? after;
      if (next <= after) break;
      after = next;
    }
  }

  private setConnection(connection: DshCollabClientSnapshot["connection"]): void {
    if (this.snapshot.connection === connection) return;
    this.snapshot = { ...this.snapshot, connection, ...(connection === "offline" ? { onlineCount: 0 } : {}) };
    this.emit();
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}

class GatewayRequestError extends Error {
  constructor(readonly status: number) {
    super(`Gateway request failed (${String(status)})`);
  }
}

class DshBrowserCollabSettings implements DshBrowserSettingsPort {
  constructor(private readonly client: DshBrowserCollabClient) {}
  getSnapshot(): { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; advertisedEndpoint: string } {
    return this.client.getSettingsSnapshot();
  }
  getRoomSnapshot(): Pick<DshCollabClientSnapshot, "roomId" | "roomTitle" | "hostDisplayName" | "role" | "connection"> { return this.client.getSnapshot(); }
  subscribeRoom(listener: () => void): () => void { return this.client.subscribe(listener); }
  async save(): Promise<void> {}
  bootstrap(roomId?: string): Promise<void> { return this.client.bootstrap(roomId); }
  shareHostRoom(input: { sessionId: string; title: string }): Promise<void> { return this.client.shareHostRoom(input); }
  stopSharing(roomId: string): Promise<void> { return this.client.stopSharing(roomId); }
  join(input: DshBrowserJoinInput, roomId?: string): Promise<void> { return this.client.join(input, roomId); }
  createInvite(input: DshBrowserInviteInput, roomId?: string): Promise<{ invitation: string }> { return this.client.createInvite(input, roomId); }
  listJoinedRooms(): readonly ParticipantResumeState[] { return this.client.listJoinedRooms(); }
  subscribeJoinedRooms(listener: () => void): () => void { return this.client.subscribeJoinedRooms(listener); }
  connectJoinedRoom(ref: JoinedRoomRef): Promise<void> { return this.client.connectJoinedRoom(ref); }
  disconnectJoinedRoom(): void { this.client.disconnectJoinedRoom(); }
  forgetJoinedRoom(ref: JoinedRoomRef): Promise<void> { return this.client.forgetJoinedRoom(ref); }
  configureGateway(input: { gatewayHost: string; gatewayPort: number }): void { this.client.configureGateway(input); }
}

export function createDshBrowserCollabClient(options: DshBrowserCollabOptions): DshBrowserCollabClient {
  return new DshBrowserCollabClient(options);
}
