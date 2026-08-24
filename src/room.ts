import { CollabError, invalidInput } from "./errors.js";
import type {
  AddMemberInput,
  CollabAction,
  CreateRoomInput,
  MemberStatus,
  Room,
  RoomMember,
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
}

export function isMemberActive(member: RoomMember): boolean {
  return member.status === "active";
}

export function isActionAllowed(role: RoomMember["role"], action: CollabAction): boolean {
  if (role === "host") return true;
  if (role === "lead") return action !== "approval" && action !== "manageMembers";
  if (role === "participant") return action === "read" || action === "humanMessage" || action === "agentRequest";
  return action === "read";
}

export function isMemberStatus(value: string): value is MemberStatus {
  return value === "active" || value === "suspended" || value === "removed";
}
