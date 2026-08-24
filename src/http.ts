import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CollabError, invalidInput } from "./errors.js";
import { CollabGateway } from "./gateway.js";
import { encodeGatewayResponse } from "./protocol.js";
import type { GatewayResponse } from "./types.js";

const PUBLIC_PREFIX = "/collab";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export type HttpHeaders = Record<string, string | undefined>;

export interface CollabAuthInput {
  method: string;
  path: string;
  headers: HttpHeaders;
}

export type CollabAuthenticator =
  (input: CollabAuthInput) => { principalId?: string } | Promise<{ principalId?: string } | undefined> | undefined;

export interface CollabHttpOptions {
  gateway: CollabGateway;
  host?: "127.0.0.1" | "0.0.0.0";
  port?: number;
  maxBodyBytes?: number;
  requestIdFactory?: () => string;
  authenticate?: CollabAuthenticator;
}

export interface CollabHttpServer {
  readonly server: Server;
  readonly port: number;
  listen(): Promise<number>;
  close(): Promise<void>;
}

function normalizeHeaders(input: IncomingHttpHeaders): HttpHeaders {
  const output: HttpHeaders = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = Array.isArray(value) ? value[0] : value;
  }
  return output;
}

function requestId(headers: HttpHeaders, factory: () => string): string {
  const provided = headers["x-request-id"]?.trim();
  return provided || factory();
}

function statusFor(error: CollabError): number {
  if (error.code === "AUTH_REQUIRED" || error.code === "AUTH_INVALID") return 401;
  if (error.code === "ACTION_FORBIDDEN" || error.code === "TOKEN_SCOPE" || error.code === "MEMBER_INACTIVE" || error.code === "MEMBER_NOT_FOUND") return 403;
  if (error.code === "ROOM_NOT_FOUND" || error.code === "INVITE_NOT_FOUND") return 404;
  if (error.code === "INVITE_EXISTS" || error.code === "EVENT_CONFLICT" || error.code === "REQUEST_CONFLICT" || error.code === "INVITE_USED") return 409;
  if (error.code === "RESOURCE_LIMIT") return 429;
  return 422;
}

function errorResponse(error: unknown): GatewayResponse {
  if (error instanceof CollabError) {
    return {
      status: statusFor(error),
      body: { error: { code: error.code, message: error.message, ...(error.details ? { details: error.details } : {}) } },
    };
  }
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "internal error" } } };
}

function notFound(): GatewayResponse {
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } };
}

function gatewayPath(rawUrl: string | undefined): string | undefined {
  const parsed = new URL(rawUrl ?? "/", "http://dsh-collab.local");
  if (!parsed.pathname.startsWith(PUBLIC_PREFIX + "/")) return undefined;
  return parsed.pathname.slice(PUBLIC_PREFIX.length) + parsed.search;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.byteLength;
    if (size > maxBytes) throw invalidInput("request body exceeds configured limit", { maxBytes });
    chunks.push(buffer);
  }
  if (size === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw invalidInput("request body must be valid JSON");
  }
}

function writeResponse(response: ServerResponse, id: string, gatewayResponse: GatewayResponse): void {
  const body = JSON.stringify(encodeGatewayResponse(id, gatewayResponse));
  response.writeHead(gatewayResponse.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-request-id": id,
  });
  response.end(body);
}

export function createCollabHttpHandler(options: CollabHttpOptions): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) throw invalidInput("maxBodyBytes must be positive", { maxBodyBytes });
  const makeRequestId = options.requestIdFactory ?? (() => "req_" + randomUUID());
  return async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const headers = normalizeHeaders(request.headers);
    const id = requestId(headers, makeRequestId);
    try {
      const path = gatewayPath(request.url);
      if (path === undefined || (request.method !== "GET" && request.method !== "POST")) {
        writeResponse(response, id, notFound());
        return;
      }
      const auth = await options.authenticate?.({ method: request.method, path, headers });
      const body = request.method === "POST" ? await readJsonBody(request, maxBodyBytes) : undefined;
      const result = await options.gateway.handle({
        method: request.method,
        path,
        headers,
        auth,
        body,
      });
      writeResponse(response, id, result);
    } catch (error) {
      writeResponse(response, id, errorResponse(error));
    }
  };
}

export function createCollabHttpServer(options: CollabHttpOptions): CollabHttpServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw invalidInput("port must be between 0 and 65535", { port });
  let listeningPort = 0;
  const handler = createCollabHttpHandler(options);
  const server = createServer((request, response) => { void handler(request, response); });

  return {
    server,
    get port() {
      return listeningPort;
    },
    async listen(): Promise<number> {
      if (server.listening) return listeningPort;
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off("error", onError);
          const address = server.address();
          if (!address || typeof address === "string") {
            reject(new Error("HTTP server did not expose a TCP address"));
            return;
          }
          listeningPort = address.port;
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      return listeningPort;
    },
    async close(): Promise<void> {
      if (!server.listening) return;
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => error ? reject(error) : resolve());
      });
      listeningPort = 0;
    },
  };
}
