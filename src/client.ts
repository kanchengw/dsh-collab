import { CollabError } from "./errors.js";
import { RoomStreamHub, type StreamConnection } from "./stream.js";
import type { RoomEvent, StreamFrame } from "./types.js";

export type CursorApplyResult = "applied" | "duplicate" | "gap";

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class EventCursor {
  private readonly pending = new Map<number, RoomEvent>();
  private readonly seen = new Set<string>();
  private readonly received: RoomEvent[] = [];
  lastEventSeq = 0;

  get events(): RoomEvent[] {
    return this.received.map(copy);
  }

  apply(event: RoomEvent): CursorApplyResult {
    if (this.seen.has(event.eventId) || event.seq <= this.lastEventSeq) return "duplicate";
    const existing = this.pending.get(event.seq);
    if (existing) {
      if (existing.eventId !== event.eventId) {
        throw new CollabError("EVENT_CONFLICT", "two events use the same sequence", { seq: event.seq });
      }
      return "duplicate";
    }
    this.seen.add(event.eventId);
    this.pending.set(event.seq, copy(event));
    const hadGap = event.seq > this.lastEventSeq + 1;
    while (this.pending.has(this.lastEventSeq + 1)) {
      const nextSeq = this.lastEventSeq + 1;
      const next = this.pending.get(nextSeq)!;
      this.pending.delete(nextSeq);
      this.received.push(next);
      this.lastEventSeq = nextSeq;
    }
    return hadGap && this.lastEventSeq < event.seq ? "gap" : "applied";
  }

  applyFrame(frame: StreamFrame): CursorApplyResult | undefined {
    if (frame.kind === "event") return this.apply(frame.event);
    return undefined;
  }
}

export class RoomClient {
  private connection: StreamConnection | undefined;
  readonly cursor = new EventCursor();

  constructor(private readonly options: {
    connectionId: string;
    roomId: string;
    token: string;
    hub: RoomStreamHub;
  }) {}

  get lastEventSeq(): number {
    return this.cursor.lastEventSeq;
  }

  get events(): RoomEvent[] {
    return this.cursor.events;
  }

  connect(): void {
    if (this.connection) this.close();
    this.connection = this.options.hub.connect({
      connectionId: this.options.connectionId,
      roomId: this.options.roomId,
      token: this.options.token,
      afterSeq: this.cursor.lastEventSeq,
      onFrame: (frame) => this.cursor.applyFrame(frame),
    });
  }

  heartbeat(): { connectionId: string; serverTime: number } {
    if (!this.connection) throw new CollabError("CONNECTION_NOT_FOUND", "client is not connected");
    return this.connection.heartbeat();
  }

  close(): void {
    if (!this.connection) return;
    this.connection.close("client_closed");
    this.connection = undefined;
  }
}
