import { randomUUID } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { CollabError, invalidInput } from "./errors.js";
import { CollabGateway } from "./gateway.js";
import { COLLAB_CAPABILITY_HEADER, encodeGatewayResponse } from "./protocol.js";
import type { GatewayResponse } from "./types.js";

const PUBLIC_PREFIX = "/collab";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

export type HttpHeaders = Record<string, string | undefined>;

export interface CollabAuthInput {
  method: string;
  path: string;
  headers: HttpHeaders;
  remoteAddress?: string;
}

export interface CollabIdentityOptions {
  hostPrincipalId: string;
  allowLoopbackPrincipal?: boolean;
  trustedProxyAddresses?: readonly string[];
  trustedPrincipalHeader?: string;
  trustedProxyMarkerHeader?: string;
  principalFromHeaders?: (headers: HttpHeaders) => string | undefined;
}

function normalizeAddress(address: string | undefined): string | undefined {
  if (!address) return undefined;
  const value = address.trim().toLowerCase();
  if (value.startsWith("::ffff:")) return value.slice("::ffff:".length);
  return value;
}

export function isLoopbackAddress(address: string | undefined): boolean {
  const normalized = normalizeAddress(address);
  return normalized === "127.0.0.1" || normalized === "::1";
}

function headerName(value: string | undefined, fallback: string): string {
  const name = (value ?? fallback).trim().toLowerCase();
  if (!/^[a-z0-9-]+$/.test(name)) throw invalidInput("trusted proxy header name is invalid");
  return name;
}

export function authenticateCollabRequest(input: CollabAuthInput, options: CollabIdentityOptions): { principalId?: string } {
  const remoteAddress = normalizeAddress(input.remoteAddress);
  const trustedProxy = options.trustedProxyAddresses?.some((address) => normalizeAddress(address) === remoteAddress) === true;
  const markerHeader = headerName(options.trustedProxyMarkerHeader, "forwarded");
  if (trustedProxy && input.headers[markerHeader]?.trim()) {
    const principalHeader = headerName(options.trustedPrincipalHeader, "x-authenticated-user");
    const principal = options.principalFromHeaders?.(input.headers) ?? input.headers[principalHeader];
    return principal?.trim() ? { principalId: principal.trim() } : {};
  }
  const origin = input.headers.origin?.trim();
  let loopbackOrigin = origin === undefined;
  if (origin) {
    try {
      loopbackOrigin = isLoopbackAddress(new URL(origin).hostname.replace(/^\[|\]$/g, "")) || new URL(origin).hostname === "localhost";
    } catch { /* invalid browser origins are not trusted */ }
  }
  if (options.allowLoopbackPrincipal === true && isLoopbackAddress(remoteAddress) && loopbackOrigin) {
    return { principalId: options.hostPrincipalId };
  }
  return {};
}

export type CollabAuthenticator =
  (input: CollabAuthInput) => { principalId?: string } | Promise<{ principalId?: string } | undefined> | undefined;

export interface CollabHttpOptions {
  gateway: CollabGateway;
  host?: "127.0.0.1" | "0.0.0.0";
  port?: number;
  portScan?: { start: number; end: number };
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

function corsHeaders(origin: string | undefined): Record<string, string> {
  return origin ? { "access-control-allow-origin": origin, vary: "origin" } : {};
}

function writeResponse(response: ServerResponse, id: string, gatewayResponse: GatewayResponse, origin?: string): void {
  const body = JSON.stringify(encodeGatewayResponse(id, gatewayResponse));
  response.writeHead(gatewayResponse.status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "x-request-id": id,
    ...corsHeaders(origin),
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
      const origin = headers.origin?.trim();
      if (path !== undefined && request.method === "OPTIONS") {
        response.writeHead(204, {
          ...corsHeaders(origin),
          "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
          "access-control-allow-headers": `authorization, content-type, x-request-id, ${COLLAB_CAPABILITY_HEADER}`,
          "access-control-max-age": "600",
        });
        response.end();
        return;
      }
      if (path === undefined || (request.method !== "GET" && request.method !== "POST" && request.method !== "PUT" && request.method !== "DELETE")) {
        writeResponse(response, id, notFound(), origin);
        return;
      }
      const auth = await options.authenticate?.({ method: request.method, path, headers, remoteAddress: request.socket.remoteAddress });
      const body = request.method === "POST" || request.method === "PUT" ? await readJsonBody(request, maxBodyBytes) : undefined;
      const result = await options.gateway.handle({
        method: request.method,
        path,
        headers,
        auth,
        body,
      });
      writeResponse(response, id, result, origin);
    } catch (error) {
      writeResponse(response, id, errorResponse(error), headers.origin?.trim());
    }
  };
}

export function createCollabHttpServer(options: CollabHttpOptions): CollabHttpServer {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw invalidInput("port must be between 0 and 65535", { port });
  const scan = options.portScan;
  if (scan && (!Number.isSafeInteger(scan.start) || !Number.isSafeInteger(scan.end) || scan.start < 1 || scan.end > 65535 || scan.start > scan.end)) {
    throw invalidInput("portScan must be a valid bounded port range");
  }
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
      const candidates = port === 0 || !scan
        ? [port]
        : [port, ...Array.from({ length: scan.end - scan.start + 1 }, (_, index) => scan.start + index).filter((candidate) => candidate !== port)];
      let lastError: Error | undefined;
      for (const candidate of candidates) {
        try {
          await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
              server.off("listening", onListening);
              reject(error);
            };
            const onListening = (): void => {
              server.off("error", onError);
              resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(candidate, host);
          });
          const address = server.address();
          if (!address || typeof address === "string") throw new Error("HTTP server did not expose a TCP address");
          listeningPort = address.port;
          return listeningPort;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error("Gateway failed to listen");
          if ((error as NodeJS.ErrnoException)?.code !== "EADDRINUSE") throw error;
        }
      }
      throw lastError ?? new Error("No Gateway port is available");
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
