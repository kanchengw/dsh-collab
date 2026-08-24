export type RoomState = "open" | "paused" | "closed";
export type MemberRole = "host" | "lead" | "participant" | "observer";
export type MemberStatus = "active" | "suspended" | "removed";

export type CollabAction =
  | "read"
  | "humanMessage"
  | "agentRequest"
  | "steer"
  | "cancel"
  | "approval"
  | "manageMembers";

export interface Room {
  roomId: string;
  hostId: string;
  hostSessionId: string;
  title: string;
  state: RoomState;
  revision: number;
  createdAt: number;
}

export interface RoomMember {
  memberId: string;
  principalId: string;
  displayName: string;
  role: MemberRole;
  status: MemberStatus;
  joinedAt: number;
  revokedAt?: number;
}

export interface CreateRoomInput {
  roomId: string;
  hostId: string;
  hostSessionId: string;
  title: string;
  hostDisplayName: string;
  now?: number;
}

export interface AddMemberInput {
  memberId: string;
  principalId: string;
  displayName: string;
  now?: number;
}

export interface AuthorizationOptions {
  allowLeadControl?: boolean;
}

export type RoomEventType =
  | "room.created"
  | "member.joined"
  | "member.suspended"
  | "member.removed"
  | "human.message"
  | "agent.request.created"
  | "agent.request.queued"
  | "agent.request.claimed"
  | "agent.request.rejected"
  | "agent.request.cancelled"
  | "agent.request.completed"
  | "agent.state.changed";

export interface RoomActor {
  memberId: string;
  principalId: string;
}

export interface RoomEvent {
  eventId: string;
  roomId: string;
  seq: number;
  type: RoomEventType;
  actor: RoomActor;
  createdAt: number;
  payload: unknown;
}

export interface AppendEventInput {
  eventId: string;
  roomId: string;
  type: RoomEventType;
  actor: RoomActor;
  createdAt?: number;
  payload: unknown;
}

export interface LedgerSnapshot {
  version: 1;
  rooms: Array<{ roomId: string; events: RoomEvent[] }>;
}
