import { createHash, randomBytes } from "node:crypto";
import { CollabError, invalidInput } from "./errors.js";
import { RoomStore } from "./room.js";

export interface ResumeCredentialRecord {
  digest: string;
  roomId: string;
  memberId: string;
  principalId: string;
  createdAt: number;
  revokedAt?: number;
}

export interface ResumeCredentialStoreSnapshot {
  version: 1;
  records: ResumeCredentialRecord[];
}

export interface IssuedResumeCredential {
  credential: string;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(field + " must not be blank", { field });
  return value.trim();
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function validTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export class ResumeCredentialStore {
  private readonly records = new Map<string, ResumeCredentialRecord>();

  constructor(
    private readonly rooms: RoomStore,
    private readonly options: { credentialFactory?: () => string } = {},
  ) {}

  issue(input: { roomId: string; memberId: string; principalId: string; now?: number }): IssuedResumeCredential {
    const roomId = requiredText(input.roomId, "roomId");
    const memberId = requiredText(input.memberId, "memberId");
    const principalId = requiredText(input.principalId, "principalId");
    const member = this.rooms.authorize(roomId, principalId, "read");
    if (member.memberId !== memberId) throw new CollabError("AUTH_INVALID", "resume credential member binding is invalid");
    const now = input.now ?? Date.now();
    if (!validTime(now)) throw invalidInput("now must be a non-negative integer", { now });
    const credential = requiredText(this.options.credentialFactory?.() ?? randomBytes(32).toString("base64url"), "credential");
    const record = { digest: digest(credential), roomId, memberId, principalId, createdAt: now };
    this.records.set(record.digest, record);
    return { credential };
  }

  issueForJoin(input: { roomId: string; memberId: string; principalId: string; credential: string; now?: number }): IssuedResumeCredential {
    const roomId = requiredText(input.roomId, "roomId");
    const memberId = requiredText(input.memberId, "memberId");
    const principalId = requiredText(input.principalId, "principalId");
    const credential = requiredText(input.credential, "credential");
    const member = this.rooms.authorize(roomId, principalId, "read");
    if (member.memberId !== memberId) throw new CollabError("AUTH_INVALID", "resume credential member binding is invalid");
    const now = input.now ?? Date.now();
    if (!validTime(now)) throw invalidInput("now must be a non-negative integer", { now });
    const credentialDigest = digest(credential);
    const existing = this.records.get(credentialDigest);
    if (existing) {
      if (existing.revokedAt !== undefined || existing.roomId !== roomId || existing.memberId !== memberId || existing.principalId !== principalId) {
        throw new CollabError("REQUEST_CONFLICT", "Join resume credential conflicts with an existing credential");
      }
      return { credential };
    }
    if ([...this.records.values()].some((record) => record.revokedAt === undefined
      && record.roomId === roomId && record.memberId === memberId && record.principalId === principalId)) {
      throw new CollabError("REQUEST_CONFLICT", "Join resume credential conflicts with an existing credential");
    }
    this.records.set(credentialDigest, { digest: credentialDigest, roomId, memberId, principalId, createdAt: now });
    return { credential };
  }

  verify(input: { roomId: string; credential: string }): Omit<ResumeCredentialRecord, "digest"> {
    const roomId = requiredText(input.roomId, "roomId");
    const record = this.records.get(digest(requiredText(input.credential, "credential")));
    if (!record) throw new CollabError("AUTH_INVALID", "resume credential is invalid");
    if (record.revokedAt !== undefined) throw new CollabError("AUTH_INVALID", "resume credential has been revoked");
    if (record.roomId !== roomId) throw new CollabError("TOKEN_SCOPE", "resume credential is scoped to another room", { roomId });
    const member = this.rooms.authorize(roomId, record.principalId, "read");
    if (member.memberId !== record.memberId) throw new CollabError("AUTH_INVALID", "resume credential membership binding is invalid");
    const { digest: _digest, ...binding } = record;
    return structuredClone(binding);
  }

  revokeMember(roomId: string, memberId: string, now = Date.now()): number {
    const normalizedRoomId = requiredText(roomId, "roomId");
    const normalizedMemberId = requiredText(memberId, "memberId");
    if (!validTime(now)) throw invalidInput("now must be a non-negative integer", { now });
    let count = 0;
    for (const record of this.records.values()) {
      if (record.roomId === normalizedRoomId && record.memberId === normalizedMemberId && record.revokedAt === undefined) {
        record.revokedAt = now;
        count += 1;
      }
    }
    return count;
  }

  snapshot(): ResumeCredentialStoreSnapshot {
    return { version: 1, records: [...this.records.values()].map((record) => structuredClone(record)) };
  }

  static fromSnapshot(rooms: RoomStore, snapshot: ResumeCredentialStoreSnapshot): ResumeCredentialStore {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.records)) {
      throw new CollabError("SNAPSHOT_INVALID", "unsupported resume credential snapshot");
    }
    const store = new ResumeCredentialStore(rooms);
    for (const record of snapshot.records) {
      const member = rooms.listMembers(record.roomId).find((candidate) => candidate.memberId === record.memberId);
      if (!/^[a-f0-9]{64}$/.test(record.digest)
        || !member || member.principalId !== record.principalId
        || !validTime(record.createdAt)
        || (record.revokedAt !== undefined && !validTime(record.revokedAt))
        || store.records.has(record.digest)) {
        throw new CollabError("SNAPSHOT_INVALID", "invalid resume credential snapshot");
      }
      store.records.set(record.digest, structuredClone(record));
    }
    return store;
  }
}
