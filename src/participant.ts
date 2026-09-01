import { CollabError } from "./errors.js";
import type { CollaborationCapability } from "./collaboration-types.js";
import type { GatewayResponse, MessageTarget, RoomEvent } from "./types.js";
import type { RoomSessionContext } from "./role.js";

export interface ParticipantGatewayTransport {
  request(input: { method: "GET" | "POST" | "PUT"; path: string; token: string; body?: unknown; capabilities?: readonly CollaborationCapability[]; signal?: AbortSignal }): Promise<GatewayResponse>;
  connect?(input: { connectionId: string; roomId: string; token: string; afterSeq: number; onEvent: (event: RoomEvent) => void }): { close(reason?: string): void };
}

export interface ParticipantMessageInput {
  clientMessageId: string;
  text: string;
  target?: MessageTarget;
  sourceMessageId?: string;
  contextRefs?: string[];
}

function expectBody<T>(response: GatewayResponse): T {
  if (response.status >= 400) throw new Error(`remote collab request failed (${String(response.status)})`);
  return response.body as T;
}

export class ParticipantSessionAdapter {
  private connection: { close(reason?: string): void } | undefined;
  private lastEventSeq = 0;
  constructor(private readonly context: RoomSessionContext, private readonly transport: ParticipantGatewayTransport, private readonly connectionId: string) {
    if (context.role !== "participant" || !context.remoteGatewayUrl || !context.token) throw new Error("participant adapter requires participant room context");
  }
  get roomId(): string { return this.context.roomId; }
  get role(): "participant" { return "participant"; }
  get connected(): boolean { return this.connection !== undefined; }
  async snapshot(): Promise<unknown> {
    return expectBody(await this.transport.request({ method: "GET", path: `/v1/rooms/${encodeURIComponent(this.context.roomId)}/snapshot`, token: this.context.token! }));
  }
  async sendMessage(input: ParticipantMessageInput): Promise<unknown> {
    return expectBody(await this.transport.request({ method: "POST", path: `/v1/rooms/${encodeURIComponent(this.context.roomId)}/messages`, token: this.context.token!, body: input }));
  }
  connect(onEvent: (event: RoomEvent) => void): void {
    if (!this.transport.connect) throw new Error("participant transport does not support event streams");
    this.connection?.close("replaced");
    this.connection = this.transport.connect({ connectionId: this.connectionId, roomId: this.context.roomId, token: this.context.token!, afterSeq: this.lastEventSeq, onEvent: (event) => { this.lastEventSeq = Math.max(this.lastEventSeq, event.seq); onEvent(event); } });
  }
  close(): void { this.connection?.close("client_closed"); this.connection = undefined; }
}
