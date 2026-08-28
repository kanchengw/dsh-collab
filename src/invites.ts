import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { CollabError, invalidInput } from "./errors.js";
import { RoomStore } from "./room.js";
import type {
  AcceptInviteInput,
  CreateInviteInput,
  CreatedInvite,
  InviteState,
  InviteStoreOptions,
  InviteView,
  RevokeInviteInput,
  RoomMember,
} from "./types.js";

type InviteRecord = InviteView & { tokenDigest: Buffer };

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput(field + " must not be blank", { field });
  }
  return value.trim();
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function sameToken(token: string, digest: Buffer): boolean {
  const candidate = tokenDigest(token);
  return candidate.length === digest.length && timingSafeEqual(candidate, digest);
}

function validState(value: string): value is InviteState {
  return value === "active" || value === "accepted" || value === "revoked" || value === "expired";
}

export class InviteStore {
  private readonly invites = new Map<string, InviteRecord>();

  constructor(
    private readonly rooms: RoomStore,
    private readonly options: InviteStoreOptions = {},
  ) {}

  createInvite(input: CreateInviteInput): CreatedInvite {
    const roomId = requiredText(input.roomId, "roomId");
    const inviteId = requiredText(input.inviteId, "inviteId");
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= now) {
      throw invalidInput("expiresAt must be later than now", { expiresAt: input.expiresAt, now });
    }

    const member = this.rooms.authorize(roomId, input.principalId, "manageMembers");
    const room = this.rooms.getRoom(roomId);
    if (member.principalId !== room.hostId) {
      throw new CollabError("ACTION_FORBIDDEN", "only the room Host can create invites", { roomId });
    }
    if (this.invites.has(inviteId)) {
      throw new CollabError("INVITE_EXISTS", "invite " + inviteId + " already exists", { inviteId });
    }

    const token = requiredText(
      this.options.tokenFactory?.() ?? randomBytes(32).toString("base64url"),
      "token",
    );
    const record: InviteRecord = {
      inviteId,
      roomId,
      hostId: room.hostId,
      state: "active",
      createdAt: now,
      expiresAt: input.expiresAt,
      tokenDigest: tokenDigest(token),
    };
    this.invites.set(inviteId, record);
    return { invite: this.view(record), token };
  }

  getInvite(inviteId: string): InviteView | undefined {
    const record = this.invites.get(requiredText(inviteId, "inviteId"));
    return record ? this.view(record) : undefined;
  }

  acceptInvite(input: AcceptInviteInput): RoomMember {
    const roomId = requiredText(input.roomId, "roomId");
    const inviteId = requiredText(input.inviteId, "inviteId");
    const token = requiredText(input.token, "token");
    const principalId = requiredText(input.principalId, "principalId");
    const memberId = requiredText(input.memberId, "memberId");
    const displayName = requiredText(input.displayName, "displayName");
    const room = this.rooms.getRoom(roomId);
    const record = this.recordForRoom(inviteId, roomId);
    if (record.hostId !== room.hostId) {
      throw new CollabError("INVITE_INVALID", "invite is not issued by this room Host");
    }

    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    this.refreshExpiry(record, now);
    if (record.state === "accepted") {
      if (!sameToken(token, record.tokenDigest)) throw new CollabError("INVITE_INVALID", "invite token is invalid");
      const member = this.rooms.listMembers(roomId).find((candidate) => candidate.memberId === record.acceptedMemberId);
      if (!member || record.acceptedPrincipalId !== principalId || member.memberId !== memberId
        || member.principalId !== principalId || member.displayName !== displayName) {
        throw new CollabError("INVITE_USED", "invite has already been accepted", { inviteId });
      }
      return member;
    }
    if (record.state === "expired") throw new CollabError("INVITE_EXPIRED", "invite has expired", { inviteId });
    if (record.state === "revoked") throw new CollabError("INVITE_REVOKED", "invite has been revoked", { inviteId });
    if (!sameToken(token, record.tokenDigest)) {
      throw new CollabError("INVITE_INVALID", "invite token is invalid");
    }

    const member = this.rooms.addMember(roomId, {
      memberId,
      principalId,
      displayName,
      now,
    });
    record.state = "accepted";
    record.acceptedAt = now;
    record.acceptedPrincipalId = principalId;
    record.acceptedMemberId = member.memberId;
    return member;
  }

  revokeInvite(input: RevokeInviteInput): InviteView {
    const roomId = requiredText(input.roomId, "roomId");
    const record = this.recordForRoom(input.inviteId, roomId);
    const member = this.rooms.authorize(roomId, input.principalId, "manageMembers");
    const room = this.rooms.getRoom(roomId);
    if (member.principalId !== room.hostId) {
      throw new CollabError("ACTION_FORBIDDEN", "only the room Host can revoke invites", { roomId });
    }
    const now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    this.refreshExpiry(record, now);
    if (record.state === "expired") throw new CollabError("INVITE_EXPIRED", "invite has expired", { inviteId: record.inviteId });
    if (record.state === "accepted") throw new CollabError("INVITE_USED", "invite has already been accepted", { inviteId: record.inviteId });
    if (record.state === "revoked") return this.view(record);
    if (!validState(record.state)) throw new CollabError("INVITE_STATE", "invite has an invalid state", { inviteId: record.inviteId });
    record.state = "revoked";
    record.revokedAt = now;
    return this.view(record);
  }

  private recordForRoom(inviteId: string, roomId: string): InviteRecord {
    const normalizedInviteId = requiredText(inviteId, "inviteId");
    const record = this.invites.get(normalizedInviteId);
    if (!record) throw new CollabError("INVITE_NOT_FOUND", "invite does not exist", { inviteId: normalizedInviteId });
    if (record.roomId !== roomId) throw new CollabError("INVITE_INVALID", "invite is not valid for this room");
    return record;
  }

  private refreshExpiry(record: InviteRecord, now: number): void {
    if (record.state === "active" && now >= record.expiresAt) record.state = "expired";
  }

  private view(record: InviteRecord): InviteView {
    const { tokenDigest: _tokenDigest, ...view } = record;
    return copy(view);
  }
}
