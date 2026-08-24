import type { ComposerTarget } from "./ui.js";
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
}

export interface DshBrowserJoinInput {
  inviteId: string;
  inviteToken: string;
  memberId: string;
  displayName: string;
  /** @deprecated Identity is asserted by the trusted Gateway proxy. */
  principalId?: string;
  gatewayUrl?: string;
}

export interface DshBrowserInviteInput {
  inviteId: string;
  expiresAt: number;
}

export interface DshBrowserSettingsPort extends DshCollabSettingsPort {
  bootstrap(roomId?: string): Promise<void>;
  join(input: DshBrowserJoinInput, roomId?: string): Promise<void>;
  createInvite(input: DshBrowserInviteInput, roomId?: string): Promise<{ token: string }>;
}

type RoomData = {
  room: { roomId: string; title: string; hostDisplayName: string };
  member: { memberId: string; role: string };
  roomToken: string;
};

type SnapshotData = {
  room: { roomId: string; title: string; hostDisplayName: string };
  members: Array<{ memberId: string; role: string; status?: string }>;
  lastEventSeq: number;
};

type Envelope = { ok: boolean; data?: unknown; error?: { message?: string } };

const OPEN = 1;

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
  private readonly hostBase: string;
  private base: string;
  private readonly fetcher: BrowserFetch;
  private readonly socketFactory: new (url: string) => BrowserSocket;
  private readonly connectionIdFactory: () => string;
  private roomId: string;
  private readonly listeners = new Set<() => void>();
  private socket: BrowserSocket | undefined;
  private token: string | undefined;
  private lastEventSeq = 0;
  private snapshot: DshCollabClientSnapshot;

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
      memberCount: 0,
      canSteer: options.role === "host",
    };
  }

  getSnapshot(): DshCollabClientSnapshot { return { ...this.snapshot }; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getSettingsSnapshot(): { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; participantGatewayUrl: string } {
    const url = new URL(this.hostBase);
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    return { gatewayHost: url.hostname, gatewayPort: port, exposeMode: url.hostname === "127.0.0.1" ? "loopback" : "network", participantGatewayUrl: this.base };
  }

  settingsPort(): DshBrowserSettingsPort { return new DshBrowserCollabSettings(this); }

  async bootstrap(roomId?: string): Promise<void> {
    this.base = this.hostBase;
    if (roomId?.trim()) this.roomId = roomId.trim();
    const data = roomData(parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(this.roomId)}/bootstrap`, undefined, false)));
    this.applyRoom(data);
    await this.connect();
  }

  async join(input: DshBrowserJoinInput, roomId?: string): Promise<void> {
    if (input.gatewayUrl?.trim()) this.base = normalizeBase(input.gatewayUrl);
    if (roomId?.trim()) this.roomId = roomId.trim();
    const data = roomData(parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(this.roomId)}/join`, {
      inviteId: input.inviteId,
      token: input.inviteToken,
      memberId: input.memberId,
      displayName: input.displayName,
    }, false)));
    this.applyRoom(data);
    await this.connect();
  }

  async createInvite(input: DshBrowserInviteInput, roomId?: string): Promise<{ token: string }> {
    this.base = this.hostBase;
    if (roomId?.trim()) this.roomId = roomId.trim();
    const data = parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(this.roomId)}/invites`, input, false));
    if (!data || typeof data !== "object" || typeof (data as { token?: unknown }).token !== "string") throw new Error("Gateway invite response is invalid");
    return { token: (data as { token: string }).token };
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
    this.socket?.close(1000, "client_closed");
    this.socket = undefined;
    this.setConnection("offline");
    this.listeners.clear();
  }

  private async connect(): Promise<void> {
    if (!this.token) throw new Error("room token is missing");
    const snapshot = parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(this.roomId)}/snapshot`, undefined, true)) as SnapshotData;
    this.lastEventSeq = snapshot.lastEventSeq;
    this.snapshot = {
      ...this.snapshot,
      roomId: snapshot.room.roomId,
      roomTitle: snapshot.room.title,
      hostDisplayName: snapshot.room.hostDisplayName,
      memberCount: snapshot.members.filter((member) => member.status !== "removed" && member.status !== "suspended").length,
    };
    this.emit();
    this.socket?.close(1000, "reconnect");
    this.setConnection("connecting");
    const url = new URL(this.base.replace(/^http/, "ws") + "/v1/stream");
    url.searchParams.set("roomId", this.roomId);
    url.searchParams.set("after", String(this.lastEventSeq));
    url.searchParams.set("connectionId", this.connectionIdFactory());
    url.searchParams.set("token", this.token);
    await new Promise<void>((resolve, reject) => {
      const socket = new this.socketFactory(url.toString());
      this.socket = socket;
      let settled = false;
      socket.onopen = () => { this.setConnection("online"); settled = true; resolve(); };
      socket.onmessage = (event) => { this.applyFrame(event.data); };
      socket.onclose = () => { this.socket = undefined; this.setConnection("offline"); if (!settled) reject(new Error("collaboration stream closed")); };
      socket.onerror = () => { if (!settled) { settled = true; reject(new Error("collaboration stream failed")); } this.setConnection("offline"); };
    });
  }

  private async request(method: string, path: string, body: unknown, withToken: boolean): Promise<unknown> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (withToken && this.token) headers.authorization = `Bearer ${this.token}`;
    const response = await this.fetcher(this.base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const envelope = await response.json();
    if (!response.ok) throw new Error(`Gateway request failed (${String(response.status)})`);
    return envelope;
  }

  private applyRoom(data: RoomData): void {
    this.token = data.roomToken;
    this.snapshot = {
      roomId: data.room.roomId,
      roomTitle: data.room.title,
      hostDisplayName: data.room.hostDisplayName,
      role: data.member.role === "host" ? "host" : "participant",
      connection: "connecting",
      memberCount: this.snapshot.memberCount,
      canSteer: data.member.role === "host" || data.member.role === "lead",
    };
    this.emit();
  }

  private applyFrame(raw: string): void {
    let frame: { type?: string; event?: { seq: number; type: string; payload?: unknown } };
    try { frame = JSON.parse(raw) as typeof frame; } catch { return; }
    if (frame.type === "event" && frame.event) {
      this.lastEventSeq = Math.max(this.lastEventSeq, frame.event.seq);
      if (frame.event.type === "member.joined") this.snapshot.memberCount += 1;
      if (frame.event.type === "member.removed") this.snapshot.memberCount = Math.max(0, this.snapshot.memberCount - 1);
      this.emit();
    }
  }

  private setConnection(connection: DshCollabClientSnapshot["connection"]): void {
    if (this.snapshot.connection === connection) return;
    this.snapshot = { ...this.snapshot, connection };
    this.emit();
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}

class DshBrowserCollabSettings implements DshBrowserSettingsPort {
  constructor(private readonly client: DshBrowserCollabClient) {}
  getSnapshot(): { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; participantGatewayUrl: string } {
    return this.client.getSettingsSnapshot();
  }
  async save(): Promise<void> {}
  bootstrap(roomId?: string): Promise<void> { return this.client.bootstrap(roomId); }
  join(input: DshBrowserJoinInput, roomId?: string): Promise<void> { return this.client.join(input, roomId); }
  createInvite(input: DshBrowserInviteInput, roomId?: string): Promise<{ token: string }> { return this.client.createInvite(input, roomId); }
}

export function createDshBrowserCollabClient(options: DshBrowserCollabOptions): DshBrowserCollabClient {
  return new DshBrowserCollabClient(options);
}
