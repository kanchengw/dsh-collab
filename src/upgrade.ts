import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer } from "ws";
import { CollabError, invalidInput } from "./errors.js";
import { decodeClientStreamFrame, encodeServerStreamFrame } from "./protocol.js";
import { RoomStreamHub } from "./stream.js";
import { RoomTokenStore } from "./tokens.js";
import type { StreamConnection } from "./stream.js";

export const COLLAB_STREAM_PATH = "/collab/v1/stream";

export interface CollabStreamUpgradeOptions {
  hub: RoomStreamHub;
  tokens: RoomTokenStore;
  now?: () => number;
  connectionIdFactory?: () => string;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(field + " must not be blank", { field });
  return value.trim();
}

function cursor(value: string | null): number {
  if (value === null) return 0;
  if (!/^\d+$/.test(value)) throw invalidInput("after must be a non-negative integer", { field: "after" });
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw invalidInput("after must be a safe integer", { field: "after" });
  return parsed;
}

function bearer(value: string | string[] | undefined, queryToken?: string | null): string {
  const authorization = Array.isArray(value) ? value[0] : value;
  const match = typeof authorization === "string" ? /^Bearer (.+)$/.exec(authorization) : undefined;
  if (match) return text(match[1], "token");
  if (queryToken !== undefined && queryToken !== null) return text(queryToken, "token");
  throw new CollabError("AUTH_REQUIRED", "room token is required");
}

function statusFor(error: CollabError): number {
  if (error.code === "AUTH_REQUIRED" || error.code === "AUTH_INVALID") return 401;
  if (error.code === "TOKEN_SCOPE" || error.code === "MEMBER_INACTIVE" || error.code === "MEMBER_NOT_FOUND" || error.code === "ACTION_FORBIDDEN") return 403;
  if (error.code === "ROOM_NOT_FOUND") return 404;
  if (error.code === "RESOURCE_LIMIT") return 429;
  return 422;
}

function reject(socket: Duplex, status: number, message: string): void {
  const body = message + "\n";
  socket.end([
    `HTTP/1.1 ${String(status)} ${status === 401 ? "Unauthorized" : status === 403 ? "Forbidden" : status === 404 ? "Not Found" : status === 429 ? "Too Many Requests" : "Unprocessable Entity"}`,
    "Connection: close",
    "Content-Type: text/plain; charset=utf-8",
    `Content-Length: ${String(Buffer.byteLength(body))}`,
    "",
    body,
  ].join("\r\n"));
}

export class CollabStreamUpgrade {
  private readonly server = new WebSocketServer({ noServer: true });
  private readonly sockets = new Set<WebSocket>();
  private readonly now: () => number;
  private readonly connectionIdFactory: () => string;

  constructor(private readonly options: CollabStreamUpgradeOptions) {
    this.now = options.now ?? (() => Date.now());
    this.connectionIdFactory = options.connectionIdFactory ?? (() => "conn_" + randomUUID());
  }

  handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    let input: { roomId: string; token: string; afterSeq: number; connectionId: string };
    try {
      const url = new URL(request.url ?? "/", "http://dsh-collab.local");
      if (url.pathname !== COLLAB_STREAM_PATH) {
        reject(socket, 404, "stream route not found");
        return;
      }
      const roomId = text(url.searchParams.get("roomId"), "roomId");
      const token = bearer(request.headers.authorization, url.searchParams.get("token"));
      const afterSeq = cursor(url.searchParams.get("after"));
      const connectionId = text(url.searchParams.get("connectionId") ?? this.connectionIdFactory(), "connectionId");
      this.options.tokens.verify({ roomId, token, now: this.now() });
      input = { roomId, token, afterSeq, connectionId };
    } catch (error) {
      if (error instanceof CollabError) {
        reject(socket, statusFor(error), error.message);
        return;
      }
      reject(socket, 422, "invalid stream request");
      return;
    }

    this.server.handleUpgrade(request, socket, head, (websocket) => {
      this.open(websocket, input);
    });
  };

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    if (this.sockets.size === 0) return;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private open(websocket: WebSocket, input: { roomId: string; token: string; afterSeq: number; connectionId: string }): void {
    this.sockets.add(websocket);
    let connection: StreamConnection | undefined;
    let closed = false;
    const send = (frame: Parameters<typeof encodeServerStreamFrame>[0]): void => {
      if (websocket.readyState === WebSocket.OPEN) websocket.send(JSON.stringify(encodeServerStreamFrame(frame)));
      if (frame.kind === "closed" && websocket.readyState === WebSocket.OPEN) {
        websocket.close(frame.reason === "client_closed" ? 1000 : 1008, frame.reason);
      }
    };
    const close = (reason: string, code: number): void => {
      if (closed) return;
      closed = true;
      connection?.close(reason);
      if (websocket.readyState === WebSocket.OPEN) websocket.close(code, reason);
    };

    websocket.once("close", () => {
      this.sockets.delete(websocket);
      if (!closed) {
        closed = true;
        connection?.close("client_closed");
      }
    });
    websocket.once("error", () => close("transport_error", 1011));
    websocket.on("message", (data, isBinary) => {
      if (isBinary) {
        close("protocol_error", 1008);
        return;
      }
      try {
        const frame = decodeClientStreamFrame(JSON.parse(data.toString()) as unknown);
        if (frame.type === "heartbeat") connection?.heartbeat();
        else close("client_closed", 1000);
      } catch {
        close("protocol_error", 1008);
      }
    });

    try {
      connection = this.options.hub.connect({
        connectionId: input.connectionId,
        roomId: input.roomId,
        token: input.token,
        afterSeq: input.afterSeq,
        onFrame: send,
      });
    } catch {
      close("auth_invalid", 1008);
    }
  }
}
