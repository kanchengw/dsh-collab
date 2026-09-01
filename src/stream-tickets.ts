import { createHash, randomBytes } from "node:crypto";
import { CollabError, invalidInput } from "./errors.js";
import type { RoomTokenStore } from "./tokens.js";

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_PENDING_PER_ROOM = 128;

interface StreamTicketRecord {
  roomId: string;
  roomToken: string;
  expiresAt: number;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(`${field} must not be blank`, { field });
  return value.trim();
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export class StreamTicketStore {
  private readonly records = new Map<string, StreamTicketRecord>();
  private readonly ttlMs: number;
  private readonly maxPendingPerRoom: number;

  constructor(
    private readonly tokens: RoomTokenStore,
    private readonly options: { ticketFactory?: () => string; ttlMs?: number; maxPendingPerRoom?: number } = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxPendingPerRoom = options.maxPendingPerRoom ?? DEFAULT_MAX_PENDING_PER_ROOM;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1) throw invalidInput("stream ticket TTL must be positive");
    if (!Number.isSafeInteger(this.maxPendingPerRoom) || this.maxPendingPerRoom < 1) {
      throw invalidInput("stream ticket pending limit must be positive");
    }
  }

  issue(input: { roomId: string; roomToken: string; now?: number }): { ticket: string; expiresAt: number } {
    const roomId = requiredText(input.roomId, "roomId");
    const roomToken = requiredText(input.roomToken, "roomToken");
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    this.tokens.verify({ roomId, token: roomToken, now });
    for (const [key, record] of this.records) if (record.expiresAt <= now) this.records.delete(key);
    let pending = 0;
    for (const record of this.records.values()) if (record.roomId === roomId) pending += 1;
    if (pending >= this.maxPendingPerRoom) {
      throw new CollabError("RESOURCE_LIMIT", "stream ticket pending limit reached", { roomId });
    }
    const ticket = requiredText(this.options.ticketFactory?.() ?? randomBytes(32).toString("base64url"), "ticket");
    const key = digest(ticket);
    if (this.records.has(key)) throw new CollabError("REQUEST_CONFLICT", "stream ticket already exists");
    const expiresAt = now + this.ttlMs;
    if (!Number.isSafeInteger(expiresAt)) throw invalidInput("stream ticket expiry exceeds safe integer range");
    this.records.set(key, { roomId, roomToken, expiresAt });
    return { ticket, expiresAt };
  }

  consume(input: { roomId: string; ticket: string; now?: number }): string {
    const roomId = requiredText(input.roomId, "roomId");
    const ticket = requiredText(input.ticket, "ticket");
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    const key = digest(ticket);
    const record = this.records.get(key);
    if (!record) throw new CollabError("AUTH_INVALID", "stream ticket is invalid");
    this.records.delete(key);
    if (record.expiresAt <= now) throw new CollabError("AUTH_INVALID", "stream ticket has expired");
    if (record.roomId !== roomId) throw new CollabError("TOKEN_SCOPE", "stream ticket is scoped to another room", { roomId });
    this.tokens.verify({ roomId, token: record.roomToken, now });
    return record.roomToken;
  }
}
