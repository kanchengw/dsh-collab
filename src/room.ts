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

export class RoomStore {
  private readonly rooms = new Map<string, RoomRecord>();

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
    return copy(room);
  }

  getRoom(roomId: string): Room {
    return copy(this.record(roomId).room);
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
    }
    return copy(member);
  }

  setRoomState(roomId: string, state: RoomState): Room {
    if (!isRoomState(state)) throw invalidInput("invalid room state", { state });
    const record = this.record(roomId);
    if (record.room.state !== state) {
      record.room.state = state;
      record.room.revision += 1;
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
    return copy(member);
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
      || action === "agentRequest"
      || (options.allowLeadControl === true && (action === "steer" || action === "cancel"));
  }
  if (role === "participant") return action === "read" || action === "humanMessage" || action === "agentRequest";
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
