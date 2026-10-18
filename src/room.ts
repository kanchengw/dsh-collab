import { CollabError, invalidInput } from "./errors.js";
import type {
  AddMemberInput,
  CollabAction,
  CreateRoomInput,
  AuthorizationOptions,
  MemberRole,
  MemberStatus,
  Room,
  RoomMember,
  RoomStoreSnapshot,
  RoomState,
} from "./types.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput(field + " must not be blank", { field });
  }
  return value.trim();
}

type RoomRecord = {
  room: Room;
  members: Map<string, RoomMember>;
};

export function migrateRoomStoreSnapshot(snapshot: RoomStoreSnapshot): RoomStoreSnapshot {
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.rooms)) {
    throw new CollabError("SNAPSHOT_INVALID", "unsupported room snapshot");
  }
  const migrated = copy(snapshot);
  for (const entry of migrated.rooms) {
    if (!entry || !entry.room || !Array.isArray(entry.members)) {
      throw new CollabError("SNAPSHOT_INVALID", "invalid room snapshot entry");
    }
    const host = entry.members.find((member) => member.principalId === entry.room.hostId);
    if (host) host.role = "host";
  }
  return migrated;
}

export class RoomStore {
  private readonly rooms = new Map<string, RoomRecord>();
  private readonly listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  createRoom(input: CreateRoomInput): Room {
    const roomId = requiredText(input.roomId, "roomId");
    if (this.rooms.has(roomId)) {
      throw new CollabError("ROOM_EXISTS", "room " + roomId + " already exists", { roomId });
    }

    const hostId = requiredText(input.hostId, "hostId");
    const room: Room = {
      roomId,
      hostId,
      hostSessionId: requiredText(input.hostSessionId, "hostSessionId"),
      title: requiredText(input.title, "title"),
      state: "open",
      revision: 1,
      createdAt: input.now ?? Date.now(),
    };
    const host: RoomMember = {
      memberId: "member-host",
      principalId: hostId,
      displayName: requiredText(input.hostDisplayName, "hostDisplayName"),
      role: "host",
      status: "active",
      joinedAt: room.createdAt,
    };
    this.rooms.set(roomId, { room, members: new Map([[host.memberId, host]]) });
    this.emit();
    return copy(room);
  }

  removeRoom(roomId: string): void {
    const normalizedRoomId = requiredText(roomId, "roomId");
    if (!this.rooms.delete(normalizedRoomId)) return;
    this.emit();
  }

  ensureHostRoom(input: CreateRoomInput): Room {
    const roomId = requiredText(input.roomId, "roomId");
    const existing = this.rooms.get(roomId);
    if (!existing) return this.createRoom(input);
    const hostId = requiredText(input.hostId, "hostId");
    const hostSessionId = requiredText(input.hostSessionId, "hostSessionId");
    if (existing.room.hostId !== hostId || existing.room.hostSessionId !== hostSessionId) {
      throw new CollabError("ACTION_FORBIDDEN", "room is bound to a different Host session", { roomId });
    }
    const title = requiredText(input.title, "title");
    if (existing.room.title !== title) {
      existing.room.title = title;
      existing.room.revision += 1;
      this.emit();
    }
    return copy(existing.room);
  }

  getRoom(roomId: string): Room {
    return copy(this.record(roomId).room);
  }

  rebindHostSession(input: {
    roomId: string;
    hostId: string;
    fromSessionId: string;
    toSessionId: string;
  }): Room {
    const record = this.record(input.roomId);
    const hostId = requiredText(input.hostId, "hostId");
    const fromSessionId = requiredText(input.fromSessionId, "fromSessionId");
    const toSessionId = requiredText(input.toSessionId, "toSessionId");
    if (record.room.hostId !== hostId) {
      throw new CollabError("ACTION_FORBIDDEN", "only the room Host can rebind its Session", { roomId: record.room.roomId });
    }
    if (record.room.hostSessionId === toSessionId) return copy(record.room);
    if (record.room.hostSessionId !== fromSessionId) {
      throw new CollabError("REQUEST_CONFLICT", "room is no longer bound to the expected Host Session", {
        roomId: record.room.roomId,
      });
    }
    record.room.hostSessionId = toSessionId;
    record.room.revision += 1;
    this.emit();
    return copy(record.room);
  }

  snapshot(): RoomStoreSnapshot {
    return {
      version: 1,
      rooms: [...this.rooms.values()].map((record) => ({
        room: copy(record.room),
        members: [...record.members.values()].map(copy),
      })),
    };
  }

  static fromSnapshot(snapshot: RoomStoreSnapshot): RoomStore {
    const migrated = migrateRoomStoreSnapshot(snapshot);
    const store = new RoomStore();
    for (const entry of migrated.rooms) {
      if (!entry || !entry.room || !Array.isArray(entry.members)) {
        throw new CollabError("SNAPSHOT_INVALID", "invalid room snapshot entry");
      }
      const room = copy(entry.room);
      if (!isRoomState(room.state) || !Number.isSafeInteger(room.revision) || room.revision < 1) {
        throw new CollabError("SNAPSHOT_INVALID", "invalid room metadata", { roomId: room.roomId });
      }
      const members = new Map<string, RoomMember>();
      const principals = new Set<string>();
      for (const member of entry.members) {
        if (!isMemberRole(member.role) || !isMemberStatus(member.status) || members.has(member.memberId) || principals.has(member.principalId)) {
          throw new CollabError("SNAPSHOT_INVALID", "invalid or duplicate room member", { roomId: room.roomId });
        }
        members.set(member.memberId, copy(member));
        principals.add(member.principalId);
      }
      const hosts = [...members.values()].filter((member) => member.role === "host" && member.principalId === room.hostId);
      if (hosts.length !== 1 || store.rooms.has(room.roomId)) {
        throw new CollabError("SNAPSHOT_INVALID", "room snapshot must have one unique host", { roomId: room.roomId });
      }
      store.rooms.set(room.roomId, { room, members });
    }
    return store;
  }

  listMembers(roomId: string): RoomMember[] {
    return [...this.record(roomId).members.values()].map(copy);
  }

  setMemberRole(roomId: string, memberId: string, role: MemberRole): RoomMember {
    const record = this.record(roomId);
    const member = this.member(record, memberId);
    if (role === "host" && member.role !== "host") {
      throw new CollabError("ACTION_FORBIDDEN", "only the room owner can be the host");
    }
    if (member.role === "host" && role !== "host") {
      throw new CollabError("ACTION_FORBIDDEN", "the room host cannot be demoted");
    }
    if (!isMemberRole(role)) {
      throw invalidInput("invalid member role", { role });
    }
    if (member.role !== role) {
      member.role = role;
      record.room.revision += 1;
      this.emit();
    }
    return copy(member);
  }

  setMemberStatus(roomId: string, memberId: string, status: MemberStatus, now = Date.now()): RoomMember {
    const record = this.record(roomId);
    const member = this.member(record, memberId);
    if (member.role === "host" && status !== "active") {
      throw new CollabError("ACTION_FORBIDDEN", "the room host cannot be suspended or removed");
    }
    if (!isMemberStatus(status)) {
      throw invalidInput("invalid member status", { status });
    }
    if (member.status !== status) {
      member.status = status;
      member.revokedAt = status === "removed" ? now : undefined;
      record.room.revision += 1;
      this.emit();
    }
    return copy(member);
  }

  setRoomState(roomId: string, state: RoomState): Room {
    if (!isRoomState(state)) throw invalidInput("invalid room state", { state });
    const record = this.record(roomId);
    if (record.room.state !== state) {
      record.room.state = state;
      record.room.revision += 1;
      this.emit();
    }
    return copy(record.room);
  }

  authorize(roomId: string, principalId: string, action: CollabAction, options: AuthorizationOptions = {}): RoomMember {
    const record = this.record(roomId);
    const normalizedPrincipalId = requiredText(principalId, "principalId");
    const member = [...record.members.values()].find((candidate) => candidate.principalId === normalizedPrincipalId);
    if (!member) {
      throw new CollabError("MEMBER_NOT_FOUND", "principal is not a member of this room", { principalId: normalizedPrincipalId });
    }
    if (!isMemberActive(member)) {
      throw new CollabError("MEMBER_INACTIVE", "member is inactive", { memberId: member.memberId });
    }
    if (record.room.state !== "open" && action !== "read") {
      throw new CollabError("ACTION_FORBIDDEN", "room is not open for writes", { roomId, action });
    }
    if (!isActionAllowed(member.role, action, options)) {
      throw new CollabError("ACTION_FORBIDDEN", "member is not allowed to perform this action", { memberId: member.memberId, action });
    }
    return copy(member);
  }

  addMember(roomId: string, input: AddMemberInput): RoomMember {
    const record = this.record(roomId);
    const memberId = requiredText(input.memberId, "memberId");
    const principalId = requiredText(input.principalId, "principalId");
    const displayName = requiredText(input.displayName, "displayName");

    if ([...record.members.values()].some((member) => member.memberId === memberId)) {
      throw new CollabError("MEMBER_EXISTS", "member " + memberId + " already exists", { memberId });
    }
    if ([...record.members.values()].some((member) => member.principalId === principalId)) {
      throw new CollabError("MEMBER_EXISTS", "principal " + principalId + " already has a room member", { principalId });
    }
    if (record.room.state !== "open") {
      throw new CollabError("ACTION_FORBIDDEN", "room " + roomId + " is not open", { roomId });
    }

    const member: RoomMember = {
      memberId,
      principalId,
      displayName,
      role: "participant",
      status: "active",
      joinedAt: input.now ?? Date.now(),
    };
    record.members.set(memberId, member);
    record.room.revision += 1;
    this.emit();
    return copy(member);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private record(roomId: string): RoomRecord {
    const normalizedRoomId = requiredText(roomId, "roomId");
    const record = this.rooms.get(normalizedRoomId);
    if (!record) {
      throw new CollabError("ROOM_NOT_FOUND", "room " + normalizedRoomId + " does not exist", { roomId: normalizedRoomId });
    }
    return record;
  }

  private member(record: RoomRecord, memberId: string): RoomMember {
    const normalizedMemberId = requiredText(memberId, "memberId");
    const member = record.members.get(normalizedMemberId);
    if (!member) {
      throw new CollabError("MEMBER_NOT_FOUND", "member " + normalizedMemberId + " does not exist", { memberId: normalizedMemberId });
    }
    return member;
  }
}

export function isMemberActive(member: RoomMember): boolean {
  return member.status === "active";
}

export function isActionAllowed(role: RoomMember["role"], action: CollabAction, options: AuthorizationOptions = {}): boolean {
  if (role === "host") return true;
  if (role === "lead") {
    return action === "read"
      || action === "humanMessage"
      || action === "workUpdate"
      || action === "changeSet"
      || action === "agentRequest"
      || (options.allowLeadControl === true && (action === "steer" || action === "cancel"));
  }
  if (role === "participant") return action === "read" || action === "humanMessage" || action === "workUpdate" || action === "changeSet" || action === "agentRequest";
  return action === "read";
}

export function isMemberStatus(value: string): value is MemberStatus {
  return value === "active" || value === "suspended" || value === "removed";
}

export function isMemberRole(value: string): value is MemberRole {
  return value === "host" || value === "lead" || value === "participant" || value === "observer";
}

export function isRoomState(value: string): value is RoomState {
  return value === "open" || value === "paused" || value === "closed";
}
