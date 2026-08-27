import { CollabError, invalidInput } from "./errors.js";
import { EventLedger } from "./events.js";
import { ResourceLimiter } from "./limits.js";
import { RoomStore } from "./room.js";
import { RoomTokenStore } from "./tokens.js";
import type { AgentOutputFrame, RoomEvent, StreamFrame } from "./types.js";
import type { ActiveRoomRegistry } from "./active-rooms.js";

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
  private readonly activeAgentOutputs = new Map<string, AgentOutputFrame>();
  private readonly unsubscribe: () => void;
  private readonly unsubscribeActive: (() => void) | undefined;
  private readonly now: () => number;

  constructor(private readonly options: {
    rooms: RoomStore;
    tokens: RoomTokenStore;
    ledger: EventLedger;
    now?: () => number;
    limits?: ResourceLimiter;
    activeRooms?: ActiveRoomRegistry;
  }) {
    this.now = options.now ?? (() => Date.now());
    this.unsubscribe = options.ledger.subscribe((event) => this.publish(event));
    this.unsubscribeActive = options.activeRooms?.subscribe((roomId, active) => {
      if (!active) {
        this.clearRoomAgentOutputs(roomId);
        this.closeRoom(roomId, "room_not_shared");
      }
    });
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
    this.options.activeRooms?.requireActive(roomId);
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
      for (const frame of this.activeAgentOutputs.values()) {
        if (frame.roomId === roomId) this.emit(record, frame);
      }
      this.broadcastPresence(roomId);
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

  publishAgentOutput(frame: Omit<AgentOutputFrame, "kind">): void {
    if (this.options.activeRooms && !this.options.activeRooms.isActive(frame.roomId)) return;
    const output: AgentOutputFrame = { kind: "agent-output", ...frame };
    this.activeAgentOutputs.set(frame.roomId + ":" + frame.requestId, output);
    for (const record of [...this.connections.values()]) {
      if (record.roomId !== frame.roomId) continue;
      try {
        this.options.tokens.verify({ roomId: record.roomId, token: record.token, now: this.now() });
      } catch (error) {
        const reason = error instanceof CollabError && error.code === "MEMBER_INACTIVE" ? "member_inactive" : "auth_invalid";
        this.close(record.connectionId, reason);
        continue;
      }
      this.emit(record, output);
    }
  }

  close(connectionId: string, reason = "server_closed"): void {
    const record = this.connections.get(connectionId);
    if (!record) return;
    this.connections.delete(connectionId);
    this.options.limits?.releaseConnection(record.roomId);
    this.emit(record, { kind: "closed", connectionId, reason });
    this.broadcastPresence(record.roomId);
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeActive?.();
    for (const connectionId of [...this.connections.keys()]) this.close(connectionId, "hub_disposed");
  }

  private closeRoom(roomId: string, reason: string): void {
    for (const record of [...this.connections.values()]) {
      if (record.roomId === roomId) this.close(record.connectionId, reason);
    }
  }

  private publish(event: RoomEvent): void {
    if (event.type === "agent.state.changed" || event.type === "agent.request.failed" || event.type === "agent.request.cancelled") {
      const requestId = recordText(event.payload, "requestId");
      if (requestId) this.activeAgentOutputs.delete(event.roomId + ":" + requestId);
    }
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

  private clearRoomAgentOutputs(roomId: string): void {
    for (const [key, frame] of this.activeAgentOutputs) {
      if (frame.roomId === roomId) this.activeAgentOutputs.delete(key);
    }
  }

  private publishTo(record: ConnectionRecord, event: RoomEvent): void {
    if (event.seq <= record.lastEventSeq) return;
    record.lastEventSeq = event.seq;
    this.emit(record, { kind: "event", event });
  }

  private broadcastPresence(roomId: string): void {
    const roomConnections = [...this.connections.values()].filter((record) => record.roomId === roomId);
    const onlineMemberCount = new Set(roomConnections.map((record) => record.memberId)).size;
    for (const record of roomConnections) this.emit(record, { kind: "presence", roomId, onlineMemberCount });
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

function recordText(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[field];
  return typeof candidate === "string" && candidate !== "" ? candidate : undefined;
}
