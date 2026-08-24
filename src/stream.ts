import { CollabError, invalidInput } from "./errors.js";
import { EventLedger } from "./events.js";
import { ResourceLimiter } from "./limits.js";
import { RoomStore } from "./room.js";
import { RoomTokenStore } from "./tokens.js";
import type { RoomEvent, StreamFrame } from "./types.js";

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput(field + " must not be blank", { field });
  }
  return value.trim();
}

interface ConnectionRecord {
  connectionId: string;
  roomId: string;
  memberId: string;
  principalId: string;
  token: string;
  lastEventSeq: number;
  onFrame: (frame: StreamFrame) => void;
}

export interface StreamConnection {
  connectionId: string;
  roomId: string;
  memberId: string;
  heartbeat(): { connectionId: string; serverTime: number };
  close(reason?: string): void;
}

export class RoomStreamHub {
  private readonly connections = new Map<string, ConnectionRecord>();
  private readonly unsubscribe: () => void;
  private readonly now: () => number;

  constructor(private readonly options: {
    rooms: RoomStore;
    tokens: RoomTokenStore;
    ledger: EventLedger;
    now?: () => number;
    limits?: ResourceLimiter;
  }) {
    this.now = options.now ?? (() => Date.now());
    this.unsubscribe = options.ledger.subscribe((event) => this.publish(event));
  }

  connect(input: {
    connectionId: string;
    roomId: string;
    token: string;
    afterSeq?: number;
    onFrame: (frame: StreamFrame) => void;
  }): StreamConnection {
    const connectionId = requiredText(input.connectionId, "connectionId");
    const roomId = requiredText(input.roomId, "roomId");
    const afterSeq = input.afterSeq ?? 0;
    if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      throw invalidInput("afterSeq must be a non-negative integer", { afterSeq });
    }
    const claims = this.options.tokens.verify({ roomId, token: input.token, now: this.now() });
    if (this.connections.has(connectionId)) {
      throw new CollabError("CONNECTION_EXISTS", "connection already exists", { connectionId });
    }
    this.options.limits?.acquireConnection(roomId);
    try {
      const record: ConnectionRecord = {
        connectionId,
        roomId,
        memberId: claims.memberId,
        principalId: claims.principalId,
        token: input.token,
        lastEventSeq: afterSeq,
        onFrame: input.onFrame,
      };
      this.connections.set(connectionId, record);
      this.emit(record, { kind: "connected", connectionId, roomId, lastEventSeq: afterSeq });
      for (const event of this.options.ledger.readAfter(roomId, afterSeq, 500)) this.publishTo(record, event);
      return {
        connectionId,
        roomId,
        memberId: claims.memberId,
        heartbeat: () => this.heartbeat(connectionId),
        close: (reason = "client_closed") => this.close(connectionId, reason),
      };
    } catch (error) {
      this.options.limits?.releaseConnection(roomId);
      throw error;
    }
  }

  heartbeat(connectionId: string): { connectionId: string; serverTime: number } {
    const record = this.record(connectionId);
    try {
      this.options.tokens.verify({ roomId: record.roomId, token: record.token, now: this.now() });
    } catch (error) {
      const reason = error instanceof CollabError && error.code === "MEMBER_INACTIVE" ? "member_inactive" : "auth_invalid";
      this.close(connectionId, reason);
      throw error;
    }
    const frame = { connectionId, serverTime: this.now() } as const;
    this.emit(record, { kind: "heartbeat", ...frame });
    return frame;
  }

  close(connectionId: string, reason = "server_closed"): void {
    const record = this.connections.get(connectionId);
    if (!record) return;
    this.connections.delete(connectionId);
    this.options.limits?.releaseConnection(record.roomId);
    this.emit(record, { kind: "closed", connectionId, reason });
  }

  dispose(): void {
    this.unsubscribe();
    for (const connectionId of [...this.connections.keys()]) this.close(connectionId, "hub_disposed");
  }

  private publish(event: RoomEvent): void {
    for (const record of [...this.connections.values()]) {
      if (record.roomId !== event.roomId) continue;
      try {
        this.options.tokens.verify({ roomId: record.roomId, token: record.token, now: this.now() });
      } catch (error) {
        const reason = error instanceof CollabError && error.code === "MEMBER_INACTIVE" ? "member_inactive" : "auth_invalid";
        this.close(record.connectionId, reason);
        continue;
      }
      this.publishTo(record, event);
    }
  }

  private publishTo(record: ConnectionRecord, event: RoomEvent): void {
    if (event.seq <= record.lastEventSeq) return;
    record.lastEventSeq = event.seq;
    this.emit(record, { kind: "event", event });
  }

  private record(connectionId: string): ConnectionRecord {
    const normalizedConnectionId = requiredText(connectionId, "connectionId");
    const record = this.connections.get(normalizedConnectionId);
    if (!record) throw new CollabError("CONNECTION_NOT_FOUND", "connection does not exist", { connectionId: normalizedConnectionId });
    return record;
  }

  private emit(record: ConnectionRecord, frame: StreamFrame): void {
    try {
      record.onFrame(frame);
    } catch {
      // A slow or broken client callback cannot roll back room state.
    }
  }
}
