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

export interface RoomStoreSnapshot {
  version: 1;
  rooms: Array<{ room: Room; members: RoomMember[] }>;
}

export type InviteState = "active" | "accepted" | "revoked" | "expired";

export interface InviteView {
  inviteId: string;
  roomId: string;
  hostId: string;
  state: InviteState;
  createdAt: number;
  expiresAt: number;
  acceptedAt?: number;
  acceptedPrincipalId?: string;
  acceptedMemberId?: string;
  revokedAt?: number;
}

export interface CreatedInvite {
  invite: InviteView;
  token: string;
}

export interface CreateInviteInput {
  roomId: string;
  principalId: string;
  inviteId: string;
  expiresAt: number;
  now?: number;
}

export interface AcceptInviteInput {
  roomId: string;
  inviteId: string;
  token: string;
  principalId: string;
  memberId: string;
  displayName: string;
  now?: number;
}

export interface RevokeInviteInput {
  roomId: string;
  principalId: string;
  inviteId: string;
  now?: number;
}

export interface InviteStoreOptions {
  tokenFactory?: () => string;
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

export type MessageTarget = "room" | "dsh" | "dsh-steer";

export interface MessageInput {
  messageId: string;
  roomId: string;
  authorMemberId: string;
  text: string;
  target?: MessageTarget;
  sourceMessageId?: string;
  contextRefs?: string[];
}

export interface HumanMessage {
  kind: "human";
  messageId: string;
  roomId: string;
  authorMemberId: string;
  text: string;
  visibility: "room";
}

export interface AgentRequest {
  kind: "agent-request";
  messageId: string;
  roomId: string;
  authorMemberId: string;
  text: string;
  target: "dsh";
  deliveryMode: "followup" | "steer";
  sourceMessageId?: string;
  contextRefs?: string[];
}

export type ClassifiedMessage = HumanMessage | AgentRequest;

export interface AgentDelivery {
  requestId: string;
  roomId: string;
  hostSessionId: string;
  authorMemberId: string;
  text: string;
  contextRefs?: string[];
}

export interface HostAgentPort {
  followup(input: AgentDelivery): Promise<void> | void;
  steer(input: AgentDelivery): Promise<void> | void;
  cancel(input: { requestId: string; roomId: string; hostSessionId: string; keepInbox: boolean }): Promise<void> | void;
}

export type QueueStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface QueueRecord {
  requestId: string;
  roomId: string;
  hostSessionId: string;
  authorMemberId: string;
  deliveryMode: "followup" | "steer";
  status: QueueStatus;
  queueSeq: number;
  message: AgentRequest;
  error?: string;
}

export interface DispatcherSnapshot {
  version: 1;
  records: QueueRecord[];
  queue: string[];
  activeRequestId?: string;
  nextQueueSeq: number;
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
  | "agent.request.failed"
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
