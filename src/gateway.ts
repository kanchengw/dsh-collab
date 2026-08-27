import { CollabError, invalidInput } from "./errors.js";
import { ApprovalStore } from "./approvals.js";
import { AgentDispatcher } from "./dispatcher.js";
import { EventLedger } from "./events.js";
import { InviteStore } from "./invites.js";
import { ResourceLimiter } from "./limits.js";
import { classifyMessage } from "./messages.js";
import { RoomStore } from "./room.js";
import { RoomTokenStore } from "./tokens.js";
import { ResumeCredentialStore } from "./resume-credentials.js";
import { ActiveRoomRegistry } from "./active-rooms.js";
import { COLLAB_CAPABILITY_HEADER, SIDECAR_REVIEW_CAPABILITY, decodeCollaborationCapabilities } from "./protocol.js";
import type { WorkspaceService } from "./workspace-service.js";
import type {
  GatewayRequest,
  GatewayResponse,
  HostAgentPort,
  MessageTarget,
  RoomTokenClaims,
} from "./types.js";

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

interface SubmissionRecord {
  fingerprint: string;
  response: GatewayResponse;
}

interface GatewayOptions {
  rooms: RoomStore;
  ledger: EventLedger;
  invites: InviteStore;
  agent: HostAgentPort;
  now?: () => number;
  tokenTtlMs?: number;
  tokenFactory?: () => string;
  limits?: ResourceLimiter;
  maxMessageBytes?: number;
  approvals?: ApprovalStore;
  approvalPolicy?: "host-only" | "disabled";
  resumes?: ResumeCredentialStore;
  hostPrincipalId?: string;
  hostDisplayName?: string;
  ownsHostSession?: (sessionId: string) => boolean | Promise<boolean>;
  activeRooms?: ActiveRoomRegistry;
  workspace?: WorkspaceService;
}

const MAX_ROOM_TITLE_LENGTH = 80;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw invalidInput(field + " must not be blank", { field });
  }
  return value.trim();
}

function objectBody(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalidInput("request body must be an object");
  }
  return body as Record<string, unknown>;
}

function numberField(body: Record<string, unknown>, field: string): number {
  const value = body[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw invalidInput(field + " must be a safe integer", { field });
  }
  return value;
}

function booleanField(body: Record<string, unknown>, field: string): boolean {
  const value = body[field];
  if (typeof value !== "boolean") throw invalidInput(field + " must be a boolean", { field });
  return value;
}

function getHeader(request: GatewayRequest, name: string): string | undefined {
  const headers = request.headers ?? {};
  const target = name.toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === target);
  return key ? headers[key] : undefined;
}

function authPrincipal(request: GatewayRequest): string {
  if (typeof request.auth?.principalId !== "string" || request.auth.principalId.trim() === "") {
    throw new CollabError("AUTH_REQUIRED", "authenticated principal is required");
  }
  return request.auth.principalId.trim();
}

function statusFor(error: CollabError): number {
  if (error.code === "AUTH_REQUIRED" || error.code === "AUTH_INVALID") return 401;
  if (error.code === "ACTION_FORBIDDEN" || error.code === "TOKEN_SCOPE" || error.code === "MEMBER_INACTIVE" || error.code === "MEMBER_NOT_FOUND") return 403;
  if (error.code === "ROOM_NOT_FOUND" || error.code === "INVITE_NOT_FOUND") return 404;
  if (error.code === "ROOM_INACTIVE" || error.code === "INVITE_EXISTS" || error.code === "EVENT_CONFLICT" || error.code === "REQUEST_CONFLICT" || error.code === "INVITE_USED" || error.code === "WORKSPACE_SHARING_DISABLED") return 409;
  if (error.code === "RESOURCE_LIMIT") return 429;
  return 422;
}

function errorResponse(error: unknown): GatewayResponse {
  if (error instanceof CollabError) {
    const body: ErrorBody = { error: { code: error.code, message: error.message } };
    if (error.details) body.error.details = error.details;
    return { status: statusFor(error), body };
  }
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "internal error" } } satisfies ErrorBody };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export class CollabGateway {
  readonly dispatcher: AgentDispatcher;
  readonly tokens: RoomTokenStore;
  readonly resumes: ResumeCredentialStore;
  private readonly now: () => number;
  private readonly maxMessageBytes: number | undefined;
  private readonly approvals: ApprovalStore | undefined;
  private readonly approvalPolicy: "host-only" | "disabled";
  private readonly submissions = new Map<string, SubmissionRecord>();

  constructor(private readonly options: GatewayOptions) {
    this.now = options.now ?? (() => Date.now());
    if (options.maxMessageBytes !== undefined && (!Number.isSafeInteger(options.maxMessageBytes) || options.maxMessageBytes < 1)) {
      throw invalidInput("maxMessageBytes must be positive", { maxMessageBytes: options.maxMessageBytes });
    }
    this.maxMessageBytes = options.maxMessageBytes;
    this.approvals = options.approvals;
    this.approvalPolicy = options.approvalPolicy ?? "host-only";
    this.tokens = new RoomTokenStore(options.rooms, {
      tokenFactory: options.tokenFactory,
      ttlMs: options.tokenTtlMs,
    });
    this.resumes = options.resumes ?? new ResumeCredentialStore(options.rooms);
    this.dispatcher = new AgentDispatcher({ rooms: options.rooms, ledger: options.ledger, agent: options.agent });
  }

  async handle(request: GatewayRequest): Promise<GatewayResponse> {
    try {
      const url = new URL(request.path, "http://dsh-collab.local");
      const segments = url.pathname.split("/").filter(Boolean);
      if (segments.length !== 4 || segments[0] !== "v1" || segments[1] !== "rooms") {
        return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } satisfies ErrorBody };
      }
      const roomId = requiredText(segments[2], "roomId");
      const resource = segments[3];
      if (request.method === "POST" && resource === "host") return await this.shareHostRoom(roomId, request);
      if (request.method === "DELETE" && resource === "host") return this.stopSharing(roomId, request);
      if (resource === "workspace-sharing") {
        const capabilities = decodeCollaborationCapabilities(getHeader(request, COLLAB_CAPABILITY_HEADER));
        if (!this.options.workspace || !capabilities.includes(SIDECAR_REVIEW_CAPABILITY)) {
          return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } satisfies ErrorBody };
        }
      }
      this.options.rooms.getRoom(roomId);
      this.options.activeRooms?.requireActive(roomId);
      if (resource === "workspace-sharing") return this.workspaceSharing(roomId, request);
      if (request.method === "GET" && resource === "bootstrap") return this.bootstrap(roomId, request);
      if (request.method === "POST" && resource === "invites") return this.createInvite(roomId, request);
      if (request.method === "POST" && resource === "join") return this.join(roomId, request);
      if (request.method === "POST" && resource === "resume") return this.resume(roomId, request);
      if (request.method === "GET" && resource === "snapshot") return this.snapshot(roomId, request);
      if (request.method === "GET" && resource === "events") return this.events(roomId, url.searchParams, request);
      if (request.method === "GET" && resource === "approvals") return this.listApprovals(roomId, request);
      if (request.method === "POST" && resource === "approvals") return this.createApproval(roomId, request);
      if (request.method === "POST" && resource === "actions") return await this.action(roomId, request);
      if (request.method === "POST" && resource === "messages") return await this.message(roomId, request);
      return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } satisfies ErrorBody };
    } catch (error) {
      return errorResponse(error);
    }
  }

  private createInvite(roomId: string, request: GatewayRequest): GatewayResponse {
    const body = objectBody(request.body);
    const invite = this.options.invites.createInvite({
      roomId,
      principalId: authPrincipal(request),
      inviteId: requiredText(body.inviteId, "inviteId"),
      expiresAt: numberField(body, "expiresAt"),
      now: this.now(),
    });
    return { status: 201, body: invite };
  }

  private bootstrap(roomId: string, request: GatewayRequest): GatewayResponse {
    const member = this.options.rooms.authorize(roomId, authPrincipal(request), "read");
    const roomToken = this.tokens.issue({ roomId, member, now: this.now() });
    return {
      status: 200,
      body: {
        room: this.options.rooms.getRoom(roomId),
        member,
        roomToken: roomToken.token,
        expiresAt: roomToken.expiresAt,
      },
    };
  }

  private join(roomId: string, request: GatewayRequest): GatewayResponse {
    const body = objectBody(request.body);
    const inviteId = requiredText(body.inviteId, "inviteId");
    this.options.limits?.checkMembers(roomId, this.options.rooms.listMembers(roomId).length + 1);
    const member = this.options.invites.acceptInvite({
      roomId,
      inviteId,
      token: requiredText(body.token, "token"),
      principalId: `invite:${inviteId}`,
      memberId: requiredText(body.memberId, "memberId"),
      displayName: requiredText(body.displayName, "displayName"),
      now: this.now(),
    });
    const roomToken = this.tokens.issue({ roomId, member, now: this.now() });
    const resumeCredential = this.resumes.issue({ roomId, memberId: member.memberId, principalId: member.principalId, now: this.now() });
    const event = this.options.ledger.append({
      eventId: roomId + ":member.joined:" + member.memberId,
      roomId,
      type: "member.joined",
      actor: { memberId: member.memberId, principalId: member.principalId },
      createdAt: this.now(),
      payload: { memberId: member.memberId, principalId: member.principalId, displayName: member.displayName, role: member.role },
    });
    return { status: 201, body: { room: this.options.rooms.getRoom(roomId), member, roomToken: roomToken.token, expiresAt: roomToken.expiresAt, resumeCredential: resumeCredential.credential, event } };
  }

  private async shareHostRoom(roomId: string, request: GatewayRequest): Promise<GatewayResponse> {
    const principalId = authPrincipal(request);
    if (!this.options.hostPrincipalId || principalId !== this.options.hostPrincipalId) {
      throw new CollabError("ACTION_FORBIDDEN", "only the configured Host can share a DSH session");
    }
    const body = objectBody(request.body);
    const hostSessionId = requiredText(body.hostSessionId, "hostSessionId");
    if (roomId !== hostSessionId) throw invalidInput("roomId must match hostSessionId", { roomId, hostSessionId });
    const title = requiredText(body.title, "title");
    if (title.length > MAX_ROOM_TITLE_LENGTH) throw invalidInput(`title must be at most ${String(MAX_ROOM_TITLE_LENGTH)} characters`, { field: "title" });
    if (!this.options.ownsHostSession || !(await this.options.ownsHostSession(hostSessionId))) {
      throw new CollabError("ACTION_FORBIDDEN", "host session is not owned by this DSH runtime", { hostSessionId });
    }
    const room = this.options.rooms.ensureHostRoom({
      roomId,
      hostId: principalId,
      hostSessionId,
      title,
      hostDisplayName: this.options.hostDisplayName ?? "Host",
      now: this.now(),
    });
    this.options.activeRooms?.activate(roomId);
    const member = this.options.rooms.authorize(roomId, principalId, "read");
    const roomToken = this.tokens.issue({ roomId, member, now: this.now() });
    return { status: 200, body: { room, member, roomToken: roomToken.token, expiresAt: roomToken.expiresAt } };
  }

  private stopSharing(roomId: string, request: GatewayRequest): GatewayResponse {
    const principalId = authPrincipal(request);
    const room = this.options.rooms.getRoom(roomId);
    if (!this.options.hostPrincipalId || principalId !== this.options.hostPrincipalId || room.hostId !== principalId) {
      throw new CollabError("ACTION_FORBIDDEN", "only the room Host can stop sharing");
    }
    this.options.workspace?.clearRoom(roomId);
    this.options.activeRooms?.deactivate(roomId);
    this.tokens.revokeRoom(roomId, this.now());
    return { status: 200, body: { room, sharing: false } };
  }

  private workspaceSharing(roomId: string, request: GatewayRequest): GatewayResponse {
    const workspace = this.options.workspace!;
    const claims = this.claims(roomId, request);
    if (request.method === "GET") {
      return { status: 200, body: { state: workspace.getState({ roomId, principalId: claims.principalId }) } };
    }
    if (request.method === "POST") {
      const body = objectBody(request.body);
      const state = workspace.setSharing({
        roomId,
        principalId: claims.principalId,
        enabled: booleanField(body, "enabled"),
      });
      return { status: 200, body: { state } };
    }
    return { status: 404, body: { error: { code: "NOT_FOUND", message: "route not found" } } satisfies ErrorBody };
  }

  private resume(roomId: string, request: GatewayRequest): GatewayResponse {
    const binding = this.resumes.verify({ roomId, credential: requiredText(objectBody(request.body).credential, "credential") });
    const member = this.options.rooms.authorize(roomId, binding.principalId, "read");
    const roomToken = this.tokens.issue({ roomId, member, now: this.now() });
    return { status: 200, body: { room: this.options.rooms.getRoom(roomId), member, roomToken: roomToken.token, expiresAt: roomToken.expiresAt } };
  }

  private snapshot(roomId: string, request: GatewayRequest): GatewayResponse {
    this.claims(roomId, request);
    return {
      status: 200,
      body: {
        room: this.options.rooms.getRoom(roomId),
        members: this.options.rooms.listMembers(roomId),
        lastEventSeq: this.options.ledger.latestSeq(roomId),
      },
    };
  }

  private events(roomId: string, query: URLSearchParams, request: GatewayRequest): GatewayResponse {
    this.claims(roomId, request);
    const after = query.get("after") === null ? 0 : this.parseQueryInteger(query.get("after"), "after");
    const limit = query.get("limit") === null ? 100 : this.parseQueryInteger(query.get("limit"), "limit");
    const events = this.options.ledger.readAfter(roomId, after, limit);
    return { status: 200, body: { events, nextSeq: events.at(-1)?.seq ?? after } };
  }

  private async message(roomId: string, request: GatewayRequest): Promise<GatewayResponse> {
    const claims = this.claims(roomId, request);
    const body = objectBody(request.body);
    const hasClientMessageId = body.clientMessageId !== undefined;
    const clientMessageId = requiredText(body.clientMessageId ?? body.messageId, "clientMessageId");
    const messageId = hasClientMessageId
      ? "message:" + roomId + ":" + clientMessageId
      : requiredText(body.messageId, "messageId");
    const requestId = hasClientMessageId
      ? "request:" + roomId + ":" + clientMessageId
      : messageId;
    const message = classifyMessage({
      messageId,
      roomId,
      authorMemberId: claims.memberId,
      text: requiredText(body.text, "text"),
      target: body.target as MessageTarget | undefined,
      sourceMessageId: body.sourceMessageId as string | undefined,
      contextRefs: body.contextRefs as string[] | undefined,
    });
    if (this.maxMessageBytes !== undefined && Buffer.byteLength(message.text, "utf8") > this.maxMessageBytes) {
      throw invalidInput("message exceeds the configured byte limit", { maxMessageBytes: this.maxMessageBytes });
    }
    const key = roomId + ":" + clientMessageId;
    const fingerprint = JSON.stringify(message);
    const existing = this.submissions.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new CollabError("REQUEST_CONFLICT", "clientMessageId was already used for different data", { clientMessageId });
      }
      return copy(existing.response);
    }
    this.options.limits?.consumeMessage(roomId, claims.memberId, this.now());
    if (message.kind === "human") {
      this.options.rooms.authorize(roomId, claims.principalId, "humanMessage");
      const event = this.options.ledger.append({
        eventId: message.messageId + ":human",
        roomId,
        type: "human.message",
        actor: { memberId: claims.memberId, principalId: claims.principalId },
        createdAt: this.now(),
        payload: message,
      });
      const response = { status: 201, body: { message, event } };
      this.submissions.set(key, { fingerprint, response });
      return copy(response);
    }
    message.requestId = requestId;
    this.options.limits?.checkQueue(roomId, this.dispatcher.queued().length + 1);
    const record = await this.dispatcher.submit({ principalId: claims.principalId, message });
    const response = { status: 202, body: { request: record } };
    this.submissions.set(key, { fingerprint: JSON.stringify({ ...message, requestId: undefined }), response });
    void this.dispatcher.processQueue();
    return copy(response);
  }

  private listApprovals(roomId: string, request: GatewayRequest): GatewayResponse {
    if (!this.approvals || this.approvalPolicy === "disabled") throw new CollabError("ACTION_FORBIDDEN", "approvals are disabled");
    const claims = this.claims(roomId, request);
    this.options.rooms.authorize(roomId, claims.principalId, "approval");
    return { status: 200, body: { approvals: this.approvals.list(roomId, this.now()) } };
  }

  private createApproval(roomId: string, request: GatewayRequest): GatewayResponse {
    if (!this.approvals || this.approvalPolicy === "disabled") throw new CollabError("ACTION_FORBIDDEN", "approvals are disabled");
    const claims = this.claims(roomId, request);
    const body = objectBody(request.body);
    const approval = this.approvals.request({
      approvalId: requiredText(body.approvalId, "approvalId"),
      roomId,
      requesterPrincipalId: claims.principalId,
      toolName: requiredText(body.toolName, "toolName"),
      reason: requiredText(body.reason, "reason"),
      expiresAt: numberField(body, "expiresAt"),
      now: this.now(),
    });
    return { status: 201, body: { approval } };
  }

  private async action(roomId: string, request: GatewayRequest): Promise<GatewayResponse> {
    const claims = this.claims(roomId, request);
    const body = objectBody(request.body);
    const action = requiredText(body.action, "action");
    if (action === "cancel") {
      const record = await this.dispatcher.cancel({
        principalId: claims.principalId,
        requestId: requiredText(body.requestId, "requestId"),
        keepInbox: body.keepInbox === true,
      });
      return { status: 200, body: { request: record } };
    }
    if (action === "setMemberStatus") {
      const actor = this.options.rooms.authorize(roomId, claims.principalId, "manageMembers");
      const memberId = requiredText(body.memberId, "memberId");
      const status = requiredText(body.status, "status");
      if (status !== "suspended" && status !== "removed") throw invalidInput("member status action must suspend or remove a member", { status });
      const member = this.options.rooms.setMemberStatus(roomId, memberId, status, this.now());
      this.tokens.revokeMember(roomId, member.memberId, this.now());
      this.resumes.revokeMember(roomId, member.memberId, this.now());
      this.options.ledger.append({
        eventId: roomId + ":member.status:" + member.memberId + ":" + status + ":" + String(this.now()),
        roomId,
        type: status === "suspended" ? "member.suspended" : "member.removed",
        actor: { memberId: actor.memberId, principalId: actor.principalId },
        createdAt: this.now(),
        payload: { memberId: member.memberId, status },
      });
      return { status: 200, body: { member } };
    }
    if (action === "setMemberRole") {
      const actor = this.options.rooms.authorize(roomId, claims.principalId, "manageMembers");
      const member = this.options.rooms.setMemberRole(roomId, requiredText(body.memberId, "memberId"), requiredText(body.role, "role") as "lead" | "participant" | "observer");
      this.options.ledger.append({
        eventId: roomId + ":member.role:" + member.memberId + ":" + member.role + ":" + String(this.now()),
        roomId,
        type: "member.roleChanged",
        actor: { memberId: actor.memberId, principalId: actor.principalId },
        createdAt: this.now(),
        payload: { memberId: member.memberId, role: member.role },
      });
      return { status: 200, body: { member } };
    }
    if (action === "decideApproval") {
      if (!this.approvals || this.approvalPolicy === "disabled") throw new CollabError("ACTION_FORBIDDEN", "approvals are disabled");
      const approval = this.approvals.decide({
        approvalId: requiredText(body.approvalId, "approvalId"),
        principalId: claims.principalId,
        outcome: requiredText(body.outcome, "outcome") as "allowed-once" | "allowed-always" | "rejected" | "cancelled" | "unavailable",
        now: this.now(),
      });
      return { status: 200, body: { approval } };
    }
    throw invalidInput("action is not supported", { action });
  }

  private claims(roomId: string, request: GatewayRequest): RoomTokenClaims {
    const authorization = getHeader(request, "authorization");
    if (!authorization) throw new CollabError("AUTH_REQUIRED", "room token is required");
    const match = /^Bearer (.+)$/.exec(authorization);
    if (!match) throw new CollabError("AUTH_INVALID", "authorization must use Bearer token");
    return this.tokens.verify({ roomId, token: match[1]!, now: this.now() });
  }

  private parseQueryInteger(value: string | null, field: string): number {
    if (value === null || !/^\d+$/.test(value)) throw invalidInput(field + " must be a non-negative integer", { field });
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) throw invalidInput(field + " must be a safe integer", { field });
    return parsed;
  }
}
