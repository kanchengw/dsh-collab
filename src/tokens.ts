import { createHash, randomBytes } from "node:crypto";
import { CollabError, invalidInput } from "./errors.js";
import { RoomStore } from "./room.js";
import type {
  IssuedRoomToken,
  RoomMember,
  RoomTokenClaims,
  RoomTokenStoreOptions,
} from "./types.js";

const DEFAULT_TTL_MS = 60 * 60 * 1000;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput(field + " must not be blank", { field });
  }
  return value.trim();
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function digest(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

interface TokenRecord {
  claims: RoomTokenClaims;
  revokedAt?: number;
}

export class RoomTokenStore {
  private readonly tokens = new Map<string, TokenRecord>();

  constructor(
    private readonly rooms: RoomStore,
    private readonly options: RoomTokenStoreOptions = {},
  ) {}

  issue(input: { roomId: string; member: RoomMember; deviceId?: string; now?: number }): IssuedRoomToken {
    const roomId = requiredText(input.roomId, "roomId");
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    const ttlMs = this.options.ttlMs ?? DEFAULT_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw invalidInput("ttlMs must be a positive integer", { ttlMs });
    const authorized = this.rooms.authorize(roomId, input.member.principalId, "read");
    if (authorized.memberId !== input.member.memberId) {
      throw new CollabError("AUTH_INVALID", "token member does not match room membership");
    }
    const token = requiredText(
      this.options.tokenFactory?.() ?? randomBytes(32).toString("base64url"),
      "token",
    );
    const expiresAt = now + ttlMs;
    if (!Number.isSafeInteger(expiresAt)) throw invalidInput("token expiry exceeds safe integer range", { expiresAt });
    const claims: RoomTokenClaims = {
      roomId,
      memberId: authorized.memberId,
      principalId: authorized.principalId,
      role: authorized.role,
      expiresAt,
    };
    if (input.deviceId !== undefined) claims.deviceId = requiredText(input.deviceId, "deviceId");
    this.tokens.set(digest(token), { claims });
    return { token, expiresAt };
  }

  verify(input: { roomId: string; token: string; now?: number }): RoomTokenClaims {
    const roomId = requiredText(input.roomId, "roomId");
    const token = requiredText(input.token, "token");
    const record = this.tokens.get(digest(token));
    if (!record) throw new CollabError("AUTH_INVALID", "room token is invalid");
    if (record.revokedAt !== undefined) throw new CollabError("AUTH_INVALID", "room token has been revoked");
    if (record.claims.roomId !== roomId) {
      throw new CollabError("TOKEN_SCOPE", "room token is scoped to another room", { roomId });
    }
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    if (now >= record.claims.expiresAt) throw new CollabError("AUTH_INVALID", "room token has expired");
    const member = this.rooms.authorize(roomId, record.claims.principalId, "read");
    if (member.memberId !== record.claims.memberId || member.role !== record.claims.role) {
      throw new CollabError("AUTH_INVALID", "room token membership binding is invalid");
    }
    return copy(record.claims);
  }

  revokeToken(token: string, now = Date.now()): boolean {
    const normalized = requiredText(token, "token");
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    const record = this.tokens.get(digest(normalized));
    if (!record || record.revokedAt !== undefined) return false;
    record.revokedAt = now;
    return true;
  }

  revokeMember(roomId: string, memberId: string, now = Date.now()): number {
    const normalizedRoomId = requiredText(roomId, "roomId");
    const normalizedMemberId = requiredText(memberId, "memberId");
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    let count = 0;
    for (const record of this.tokens.values()) {
      if (record.claims.roomId === normalizedRoomId && record.claims.memberId === normalizedMemberId && record.revokedAt === undefined) {
        record.revokedAt = now;
        count += 1;
      }
    }
    return count;
  }

  revokeRoom(roomId: string, now = Date.now()): number {
    const normalizedRoomId = requiredText(roomId, "roomId");
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    let count = 0;
    for (const record of this.tokens.values()) {
      if (record.claims.roomId === normalizedRoomId && record.revokedAt === undefined) {
        record.revokedAt = now;
        count += 1;
      }
    }
    return count;
  }

  revokeDevice(deviceId: string, now = Date.now()): number {
    const normalizedDeviceId = requiredText(deviceId, "deviceId");
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    let count = 0;
    for (const record of this.tokens.values()) {
      if (record.claims.deviceId === normalizedDeviceId && record.revokedAt === undefined) {
        record.revokedAt = now;
        count += 1;
      }
    }
    return count;
  }
}
