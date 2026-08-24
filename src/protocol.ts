import { invalidInput } from "./errors.js";
import type { GatewayResponse, RoomEvent, StreamFrame } from "./types.js";

export const COLLAB_PROTOCOL = "dsh-collab.v1" as const;

export interface ProtocolError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ProtocolResponse<T> =
  | { protocol: typeof COLLAB_PROTOCOL; requestId: string; ok: true; data: T }
  | { protocol: typeof COLLAB_PROTOCOL; requestId: string; ok: false; error: ProtocolError };

export type ClientStreamFrame =
  | { protocol: typeof COLLAB_PROTOCOL; type: "heartbeat" }
  | { protocol: typeof COLLAB_PROTOCOL; type: "close" };

export type ServerStreamFrame =
  | { protocol: typeof COLLAB_PROTOCOL; type: "connected"; connectionId: string; roomId: string; lastEventSeq: number }
  | { protocol: typeof COLLAB_PROTOCOL; type: "event"; event: RoomEvent }
  | { protocol: typeof COLLAB_PROTOCOL; type: "heartbeat"; connectionId: string; serverTime: number }
  | { protocol: typeof COLLAB_PROTOCOL; type: "closed"; connectionId: string; reason: string };

const EVENT_TYPES = new Set<RoomEvent["type"]>([
  "room.created",
  "member.joined",
  "member.suspended",
  "member.removed",
  "human.message",
  "agent.request.created",
  "agent.request.queued",
  "agent.request.claimed",
  "agent.request.rejected",
  "agent.request.failed",
  "agent.request.cancelled",
  "agent.request.completed",
  "agent.state.changed",
  "approval.requested",
  "approval.decided",
]);

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidInput(field + " must be an object", { field });
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput(field + " must not be blank", { field });
  }
  return value.trim();
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw invalidInput(field + " must be a non-negative safe integer", { field });
  }
  return value;
}

function protocol(value: unknown): void {
  if (value !== COLLAB_PROTOCOL) throw invalidInput("protocol is not supported", { protocol: value });
}

function requestId(value: string): string {
  return text(value, "requestId");
}

export function encodeGatewayResponse<T>(id: string, response: GatewayResponse): ProtocolResponse<T> {
  const normalizedRequestId = requestId(id);
  if (response.status < 400) {
    return {
      protocol: COLLAB_PROTOCOL,
      requestId: normalizedRequestId,
      ok: true,
      data: response.body as T,
    };
  }
  const body = record(response.body, "error response");
  const error = decodeError(body.error);
  return {
    protocol: COLLAB_PROTOCOL,
    requestId: normalizedRequestId,
    ok: false,
    error,
  };
}

export function encodeClientStreamFrame(frame: ClientStreamFrame): ClientStreamFrame {
  if (frame.protocol !== COLLAB_PROTOCOL) throw invalidInput("protocol is not supported", { protocol: frame.protocol });
  if (frame.type !== "heartbeat" && frame.type !== "close") {
    throw invalidInput("stream frame.type is not supported", { field: "type" });
  }
  return { protocol: COLLAB_PROTOCOL, type: frame.type };
}

export function encodeServerStreamFrame(frame: StreamFrame): ServerStreamFrame {
  switch (frame.kind) {
    case "connected":
      return { protocol: COLLAB_PROTOCOL, type: "connected", connectionId: frame.connectionId, roomId: frame.roomId, lastEventSeq: frame.lastEventSeq };
    case "event":
      return { protocol: COLLAB_PROTOCOL, type: "event", event: frame.event };
    case "heartbeat":
      return { protocol: COLLAB_PROTOCOL, type: "heartbeat", connectionId: frame.connectionId, serverTime: frame.serverTime };
    case "closed":
      return { protocol: COLLAB_PROTOCOL, type: "closed", connectionId: frame.connectionId, reason: frame.reason };
  }
}

export function decodeClientStreamFrame(value: unknown): ClientStreamFrame {
  const input = record(value, "stream frame");
  protocol(input.protocol);
  if (input.type === "heartbeat") return { protocol: COLLAB_PROTOCOL, type: "heartbeat" };
  if (input.type === "close") return { protocol: COLLAB_PROTOCOL, type: "close" };
  throw invalidInput("stream frame.type is not supported", { field: "type" });
}

export function decodeServerStreamFrame(value: unknown): StreamFrame {
  const input = record(value, "stream frame");
  protocol(input.protocol);
  const type = text(input.type, "type");
  if (type === "connected") {
    return {
      kind: "connected",
      connectionId: text(input.connectionId, "connectionId"),
      roomId: text(input.roomId, "roomId"),
      lastEventSeq: nonNegativeInteger(input.lastEventSeq, "lastEventSeq"),
    };
  }
  if (type === "event") return { kind: "event", event: decodeEvent(input.event) };
  if (type === "heartbeat") {
    return {
      kind: "heartbeat",
      connectionId: text(input.connectionId, "connectionId"),
      serverTime: nonNegativeInteger(input.serverTime, "serverTime"),
    };
  }
  if (type === "closed") {
    return {
      kind: "closed",
      connectionId: text(input.connectionId, "connectionId"),
      reason: text(input.reason, "reason"),
    };
  }
  throw invalidInput("stream frame.type is not supported", { field: "type" });
}

function decodeEvent(value: unknown): RoomEvent {
  const input = record(value, "event");
  const actor = record(input.actor, "event.actor");
  const type = text(input.type, "event.type");
  if (!EVENT_TYPES.has(type as RoomEvent["type"])) {
    throw invalidInput("event.type is not supported", { field: "event.type" });
  }
  return {
    eventId: text(input.eventId, "event.eventId"),
    roomId: text(input.roomId, "event.roomId"),
    seq: nonNegativeInteger(input.seq, "event.seq"),
    type: type as RoomEvent["type"],
    actor: {
      memberId: text(actor.memberId, "event.actor.memberId"),
      principalId: text(actor.principalId, "event.actor.principalId"),
    },
    createdAt: nonNegativeInteger(input.createdAt, "event.createdAt"),
    payload: input.payload,
  };
}

function decodeError(value: unknown): ProtocolError {
  const input = record(value, "error response.error");
  const error: ProtocolError = {
    code: text(input.code, "error.code"),
    message: text(input.message, "error.message"),
  };
  if (input.details !== undefined) error.details = record(input.details, "error.details");
  return error;
}
