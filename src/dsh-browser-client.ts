import type { ComposerTarget } from "./ui.js";
import { projectAgentQueue, projectTimeline } from "./ui.js";
import { gatewayHttpUrl } from "./endpoint-policy.js";
import { decodeCollabInvitation, encodeCollabInvitation, type CollabInvitationNetwork } from "./invitation.js";
import type { EasyTierInvitationNetwork } from "./easytier-invitation.js";
import { CHANGE_SET_CAPABILITY, COLLAB_CAPABILITY_HEADER, COLLAB_PROTOCOL, SIDECAR_REVIEW_CAPABILITY, decodeServerStreamFrame, encodeClientStreamFrame, type DecodedServerStreamFrame } from "./protocol.js";
import type { AgentOutputFrame, AgentQueueItem, RoomEvent } from "./types.js";
import type { DshCollabClientPort, DshCollabClientSnapshot, DshCollabSettingsPort } from "./dsh-client.js";
import type { LocalSnapshotAccess } from "./local-sidecar.js";
import type { AcceptedReviewPublication, ReviewFinding, ReviewFindingCreateInput, ReviewFindingLocation, ReviewFindingPage, ReviewLifecycle, ReviewPoint, ReviewPointCreateInput, ReviewPointDiff, ReviewPointFile, ReviewPointPage, ReviewPointProjection, ReviewPublication, ReviewPublicationCreateInput, ReviewPublicationPage, WorkspaceSharingState, WorkspaceSnapshotPackage } from "./collaboration-types.js";

export interface BrowserRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface BrowserResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type BrowserFetch = (url: string, init?: BrowserRequestInit) => Promise<BrowserResponse>;

export interface BrowserSocket {
  readonly readyState: number;
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface DshBrowserCollabOptions {
  gatewayUrl: string;
  roomId: string;
  role?: "host" | "participant";
  principalId?: string;
  token?: string;
  fetch?: BrowserFetch;
  WebSocket?: new (url: string) => BrowserSocket;
  connectionIdFactory?: () => string;
  participantPersistence?: ParticipantPersistence;
  easyTierTransport?: DshBrowserEasyTierTransport;
}

export interface DshBrowserEasyTierTransport {
  startParticipant(input: {
    roomId: string;
    gatewayPort: number;
    network: EasyTierInvitationNetwork;
    localVirtualAddress?: string;
  }): Promise<{ gatewayEndpoint: string; localVirtualAddress: string }>;
  stop(): Promise<void>;
}

export interface ParticipantResumeState {
  gatewayEndpoint: string;
  roomId: string;
  memberId: string;
  credential: string;
  roomTitle?: string;
  hostDisplayName?: string;
  easyTier?: { network: EasyTierInvitationNetwork; localVirtualAddress: string };
}

export interface JoinedRoomRef { gatewayEndpoint: string; roomId: string }

export interface ParticipantPersistence {
  prepare?(): Promise<void>;
  load(ref?: JoinedRoomRef): ParticipantResumeState | undefined;
  list?(): readonly ParticipantResumeState[];
  subscribe?(listener: () => void): () => void;
  save(state: ParticipantResumeState): Promise<void>;
  remove?(ref: JoinedRoomRef): Promise<void>;
  clear?(): Promise<void>;
}

export interface DshBrowserJoinInput {
  invitation: string;
  memberId?: string;
  displayName: string;
}

export interface DshBrowserInviteInput {
  inviteId?: string;
  expiresAt: number;
  gatewayEndpoint: string;
  network?: CollabInvitationNetwork;
}

export interface DshBrowserSettingsPort extends DshCollabSettingsPort {
  bootstrap(roomId?: string): Promise<void>;
  shareHostRoom(input: { roomId: string; hostSessionId: string; title: string }): Promise<void>;
  stopSharing(roomId: string): Promise<void>;
  join(input: DshBrowserJoinInput, roomId?: string): Promise<void>;
  createInvite(input: DshBrowserInviteInput, roomId?: string): Promise<{ invitation: string }>;
  listJoinedRooms(): readonly ParticipantResumeState[];
  subscribeJoinedRooms(listener: () => void): () => void;
  connectJoinedRoom(ref: JoinedRoomRef): Promise<void>;
  disconnectJoinedRoom(): Promise<void>;
  forgetJoinedRoom(ref: JoinedRoomRef): Promise<void>;
  configureGateway?(input: { gatewayHost: string; gatewayPort: number }): void;
  getLocalSnapshotAccess(roomId: string): LocalSnapshotAccess;
}

type RoomData = {
  room: { roomId: string; title: string; hostDisplayName?: string };
  member: { memberId: string; role: string; displayName?: string };
  roomToken: string;
  resumeCredential?: string;
};

type SnapshotData = {
  room: { roomId: string; title: string; hostDisplayName?: string };
  members: Array<{ memberId: string; role: string; displayName?: string; status?: string }>;
  lastEventSeq: number;
  agentQueue?: AgentQueueItem[];
};

type EventsData = { events: RoomEvent[]; nextSeq?: number };
type StreamTicketData = { ticket: string; expiresAt: number };

type Envelope = { ok: boolean; data?: unknown; error?: { code?: string; message?: string } };

const OPEN = 1;
const HEARTBEAT_INTERVAL_MS = 5_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 5_000;

function randomId(prefix: string): string {
  const crypto = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  return `${prefix}_${crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
}

function randomCredential(): string {
  const crypto = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
  if (!crypto?.randomUUID) throw new Error("Secure random generation is unavailable");
  return `resume_${crypto.randomUUID()}_${crypto.randomUUID()}`;
}

function defaultFetch(): BrowserFetch {
  const fetch = (globalThis as unknown as { fetch?: BrowserFetch }).fetch;
  if (!fetch) throw new Error("browser fetch is unavailable");
  return fetch.bind(globalThis);
}

function defaultWebSocket(): new (url: string) => BrowserSocket {
  const WebSocket = (globalThis as unknown as { WebSocket?: new (url: string) => BrowserSocket }).WebSocket;
  if (!WebSocket) throw new Error("browser WebSocket is unavailable");
  return WebSocket;
}

function normalizeBase(value: string): string {
  const base = value.trim().replace(/\/+$/, "");
  if (base === "") throw new Error("gatewayUrl must not be blank");
  return base;
}

function gatewayWebSocketUrl(base: string): string {
  const endpoint = new URL(normalizeBase(base));
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";
  return endpoint.toString();
}

function parseEnvelope(value: unknown): unknown {
  if (!value || typeof value !== "object") throw new Error("invalid Gateway response");
  const envelope = value as Envelope;
  if (!envelope.ok) throw new Error(envelope.error?.message ?? "Gateway request failed");
  return envelope.data;
}

function roomData(value: unknown, roomId?: string): RoomData {
  if (!value || typeof value !== "object") throw new Error("Gateway room response is invalid");
  const data = value as RoomData;
  if (!data.room || !data.member || typeof data.roomToken !== "string" || (roomId !== undefined && data.room.roomId !== roomId)) {
    throw new Error("Gateway room response is incomplete");
  }
  return data;
}

function snapshotData(value: unknown, roomId: string): SnapshotData {
  if (!value || typeof value !== "object") throw new Error("Gateway room snapshot is invalid");
  const data = value as SnapshotData;
  if (!data.room || data.room.roomId !== roomId || !Array.isArray(data.members)
    || !Number.isSafeInteger(data.lastEventSeq) || data.lastEventSeq < 0) {
    throw new Error("Gateway room snapshot is invalid");
  }
  if (data.agentQueue !== undefined) data.agentQueue = agentQueue(data.agentQueue, roomId);
  return data;
}

function streamTicketData(value: unknown): StreamTicketData {
  const data = record(value);
  if (!data || typeof data.ticket !== "string" || data.ticket === ""
    || !Number.isSafeInteger(data.expiresAt) || (data.expiresAt as number) < 0) {
    throw new Error("Gateway stream ticket response is invalid");
  }
  return data as unknown as StreamTicketData;
}

function agentQueue(value: unknown, roomId: string): AgentQueueItem[] {
  if (!Array.isArray(value)) throw new Error("Gateway Agent queue snapshot is invalid");
  return value.map((entry) => {
    const item = record(entry);
    if (!item || item.roomId !== roomId || typeof item.requestId !== "string" || typeof item.messageId !== "string"
      || typeof item.authorMemberId !== "string" || typeof item.text !== "string"
      || (item.deliveryMode !== "followup" && item.deliveryMode !== "steer")
      || (item.status !== "queued" && item.status !== "running")
      || !Number.isSafeInteger(item.queueSeq) || (item.queueSeq as number) < 1
      || !Number.isSafeInteger(item.position) || (item.position as number) < 1
      || (item.priority !== "host" && item.priority !== "participant")) {
      throw new Error("Gateway Agent queue item is invalid");
    }
    return item as unknown as AgentQueueItem;
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function workspaceSharingState(value: unknown, roomId: string): WorkspaceSharingState {
  const state = record(value);
  if (!state || state.roomId !== roomId || typeof state.enabled !== "boolean" || !Number.isSafeInteger(state.revision) || (state.revision as number) < 0) {
    throw new Error("Gateway Workspace Sharing response is invalid");
  }
  if (!state.enabled) return { roomId, enabled: false, revision: state.revision as number };
  if (typeof state.enabledBy !== "string" || state.enabledBy.trim() === "" || !Number.isSafeInteger(state.enabledAt) || (state.enabledAt as number) < 0) {
    throw new Error("Gateway Workspace Sharing response is incomplete");
  }
  return { roomId, enabled: true, enabledBy: state.enabledBy, enabledAt: state.enabledAt as number, revision: state.revision as number };
}

function workspaceSnapshot(value: unknown, roomId: string): WorkspaceSnapshotPackage {
  const snapshot = record(value);
  if (!snapshot || snapshot.roomId !== roomId || typeof snapshot.snapshotId !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.snapshotId)
    || typeof snapshot.hostSessionId !== "string" || !Number.isSafeInteger(snapshot.roomEventSeq) || (snapshot.roomEventSeq as number) < 0
    || typeof snapshot.manifestHash !== "string" || !/^[a-f0-9]{64}$/.test(snapshot.manifestHash)
    || !Array.isArray(snapshot.files) || snapshot.files.length > 10_000
    || !Number.isSafeInteger(snapshot.createdAt) || (snapshot.createdAt as number) < 0) {
    throw new Error("Gateway Workspace Snapshot response is invalid");
  }
  let totalBytes = 0;
  const files = snapshot.files.map((value) => {
    const file = record(value);
    if (!file || typeof file.path !== "string" || file.path === "" || typeof file.contentHash !== "string" || !/^[a-f0-9]{64}$/.test(file.contentHash)
      || !Number.isSafeInteger(file.size) || (file.size as number) < 0 || (file.source !== "tracked" && file.source !== "untracked")) {
      throw new Error("Gateway Workspace Snapshot file is invalid");
    }
    totalBytes += file.size as number;
    if (totalBytes > 256 * 1024 * 1024) throw new Error("Gateway Workspace Snapshot response is invalid");
    return { path: file.path, contentHash: file.contentHash, size: file.size as number, source: file.source as "tracked" | "untracked" };
  });
  return {
    snapshotId: snapshot.snapshotId,
    roomId,
    hostSessionId: snapshot.hostSessionId,
    roomEventSeq: snapshot.roomEventSeq as number,
    ...(typeof snapshot.headOid === "string" ? { headOid: snapshot.headOid } : {}),
    manifestHash: snapshot.manifestHash,
    files,
    createdAt: snapshot.createdAt as number,
  };
}

function safeSnapshotPath(path: string): boolean {
  const segments = path.split("/");
  return path !== "" && !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path) && !path.includes("\\")
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function reviewPointFile(value: unknown, paths: Set<string>): ReviewPointFile {
  const file = record(value);
  if (!file || typeof file.path !== "string" || !safeSnapshotPath(file.path) || paths.has(file.path)
    || (file.previousPath !== undefined && (typeof file.previousPath !== "string" || !safeSnapshotPath(file.previousPath)))
    || !["added", "modified", "deleted", "renamed"].includes(String(file.status))
    || !Number.isSafeInteger(file.additions) || (file.additions as number) < 0
    || !Number.isSafeInteger(file.deletions) || (file.deletions as number) < 0
    || (file.baseBlobOid !== undefined && (typeof file.baseBlobOid !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(file.baseBlobOid)))
    || (file.snapshotContentHash !== undefined && (typeof file.snapshotContentHash !== "string" || !/^[a-f0-9]{64}$/.test(file.snapshotContentHash)))
    || (file.status === "deleted" ? file.snapshotContentHash !== undefined : file.snapshotContentHash === undefined)) {
    throw new Error("Gateway Review Point file is invalid");
  }
  paths.add(file.path);
  return {
    path: file.path,
    ...(typeof file.previousPath === "string" ? { previousPath: file.previousPath } : {}),
    status: file.status as ReviewPointFile["status"],
    ...(typeof file.baseBlobOid === "string" ? { baseBlobOid: file.baseBlobOid } : {}),
    ...(typeof file.snapshotContentHash === "string" ? { snapshotContentHash: file.snapshotContentHash } : {}),
    additions: file.additions as number,
    deletions: file.deletions as number,
  };
}

function reviewPoint(value: unknown, roomId: string): ReviewPoint {
  const point = record(value);
  if (!point || !/^[a-f0-9]{64}$/.test(String(point.reviewPointId)) || point.roomId !== roomId
    || typeof point.title !== "string" || point.title.trim() === "" || point.title.length > 120
    || (point.focus !== undefined && (typeof point.focus !== "string" || point.focus.length > 2_000))
    || typeof point.createdBy !== "string" || point.createdBy.trim() === ""
    || !Array.isArray(point.reviewerIds) || point.reviewerIds.some((id) => typeof id !== "string" || id.trim() === "")
    || new Set(point.reviewerIds).size !== point.reviewerIds.length
    || !["open", "changes-requested", "approved", "closed"].includes(String(point.lifecycle))
    || !Number.isSafeInteger(point.roomEventSeq) || (point.roomEventSeq as number) < 0
    || typeof point.mainAgentSessionId !== "string" || point.mainAgentSessionId.trim() === ""
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(String(point.workspaceSnapshotId))
    || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(String(point.headOid))
    || !Array.isArray(point.files) || point.files.length === 0 || point.files.length > 10_000
    || !Number.isSafeInteger(point.createdAt) || (point.createdAt as number) < 0) {
    throw new Error("Gateway Review Point response is invalid");
  }
  const paths = new Set<string>();
  return {
    reviewPointId: point.reviewPointId as string,
    roomId,
    title: point.title,
    ...(typeof point.focus === "string" ? { focus: point.focus } : {}),
    createdBy: point.createdBy,
    reviewerIds: [...point.reviewerIds] as string[],
    lifecycle: point.lifecycle as ReviewPoint["lifecycle"],
    roomEventSeq: point.roomEventSeq as number,
    mainAgentSessionId: point.mainAgentSessionId,
    workspaceSnapshotId: point.workspaceSnapshotId as string,
    headOid: point.headOid as string,
    files: point.files.map((file) => reviewPointFile(file, paths)),
    createdAt: point.createdAt as number,
  };
}

function reviewPointProjection(value: unknown, roomId: string): ReviewPointProjection {
  const projection = record(value);
  const progress = record(projection?.progress);
  if (!projection || (projection.freshness !== "current" && projection.freshness !== "stale") || !progress
    || !Number.isSafeInteger(progress.roomEventDelta) || (progress.roomEventDelta as number) < 0
    || !Number.isSafeInteger(progress.workspaceChangedFileCount) || (progress.workspaceChangedFileCount as number) < 0) {
    throw new Error("Gateway Review Point projection is invalid");
  }
  return {
    reviewPoint: reviewPoint(projection.reviewPoint, roomId),
    freshness: projection.freshness,
    progress: {
      roomEventDelta: progress.roomEventDelta as number,
      workspaceChangedFileCount: progress.workspaceChangedFileCount as number,
    },
  };
}

function reviewPointPage(value: unknown, roomId: string): ReviewPointPage {
  const page = record(value);
  if (!page || !Array.isArray(page.reviewPoints) || page.reviewPoints.length > 100
    || (page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || !/^[a-f0-9]{64}$/.test(page.nextCursor)))) {
    throw new Error("Gateway Review Point page is invalid");
  }
  return {
    reviewPoints: page.reviewPoints.map((projection) => reviewPointProjection(projection, roomId)),
    ...(typeof page.nextCursor === "string" ? { nextCursor: page.nextCursor } : {}),
  };
}

function reviewFindingLocation(value: unknown): ReviewFindingLocation {
  const location = record(value);
  if (!location || !["general", "file", "line"].includes(String(location.kind))) throw new Error("Gateway Review finding location is invalid");
  if (location.kind === "general") return { kind: "general" };
  if (typeof location.path !== "string" || !safeSnapshotPath(location.path)) throw new Error("Gateway Review finding path is invalid");
  if (location.kind === "file") return { kind: "file", path: location.path };
  if (!Number.isSafeInteger(location.line) || (location.line as number) < 1) throw new Error("Gateway Review finding line is invalid");
  return { kind: "line", path: location.path, line: location.line as number };
}

function reviewFinding(value: unknown, roomId: string, reviewPointId: string): ReviewFinding {
  const finding = record(value);
  if (!finding || !/^[a-f0-9]{64}$/.test(String(finding.findingId)) || finding.roomId !== roomId || finding.reviewPointId !== reviewPointId
    || typeof finding.authorId !== "string" || finding.authorId.trim() === ""
    || !["critical", "high", "medium", "low", "note"].includes(String(finding.severity))
    || typeof finding.body !== "string" || finding.body.trim() === "" || finding.body.length > 4_000
    || !["open", "accepted", "dismissed", "resolved"].includes(String(finding.state))
    || !Number.isSafeInteger(finding.createdAt) || (finding.createdAt as number) < 0
    || (finding.state === "open" ? finding.decidedBy !== undefined || finding.decidedAt !== undefined
      : typeof finding.decidedBy !== "string" || !Number.isSafeInteger(finding.decidedAt) || (finding.decidedAt as number) < 0)) {
    throw new Error("Gateway Review finding response is invalid");
  }
  return {
    findingId: finding.findingId as string,
    roomId,
    reviewPointId,
    authorId: finding.authorId,
    severity: finding.severity as ReviewFinding["severity"],
    location: reviewFindingLocation(finding.location),
    body: finding.body,
    state: finding.state as ReviewFinding["state"],
    createdAt: finding.createdAt as number,
    ...(typeof finding.decidedBy === "string" ? { decidedBy: finding.decidedBy, decidedAt: finding.decidedAt as number } : {}),
  };
}

function reviewFindingPage(value: unknown, roomId: string, reviewPointId: string): ReviewFindingPage {
  const page = record(value);
  if (!page || !Array.isArray(page.findings) || page.findings.length > 100
    || (page.nextCursor !== undefined && (typeof page.nextCursor !== "string" || !/^[a-f0-9]{64}$/.test(page.nextCursor)))) {
    throw new Error("Gateway Review finding page is invalid");
  }
  return {
    findings: page.findings.map((finding) => reviewFinding(finding, roomId, reviewPointId)),
    ...(typeof page.nextCursor === "string" ? { nextCursor: page.nextCursor } : {}),
  };
}

function reviewPublication(value: unknown, roomId: string, reviewPointId: string): ReviewPublication {
  const publication = record(value);
  const accepted = publication?.state === "accepted";
  if (!publication || typeof publication.publicationId !== "string" || !/^[a-f0-9]{64}$/.test(publication.publicationId)
    || publication.roomId !== roomId || publication.reviewPointId !== reviewPointId
    || typeof publication.taskId !== "string" || publication.taskId.trim() === "" || publication.taskId.length > 128
    || typeof publication.workspaceSnapshotId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(publication.workspaceSnapshotId)
    || typeof publication.publishedBy !== "string" || publication.publishedBy.trim() === ""
    || typeof publication.summary !== "string" || publication.summary.trim() === "" || publication.summary.length > 8_000
    || !Array.isArray(publication.findingIds) || publication.findingIds.length < 1 || publication.findingIds.length > 100
    || publication.findingIds.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    || new Set(publication.findingIds).size !== publication.findingIds.length
    || (publication.state !== "published" && publication.state !== "accepted")
    || !Number.isSafeInteger(publication.createdAt) || (publication.createdAt as number) < 0
    || (accepted
      ? typeof publication.acceptedBy !== "string" || publication.acceptedBy.trim() === ""
        || !Number.isSafeInteger(publication.acceptedAt) || (publication.acceptedAt as number) < 0
        || typeof publication.integrationRequestId !== "string" || !/^internal:mainline:[a-f0-9]{64}$/.test(publication.integrationRequestId)
      : publication.acceptedBy !== undefined || publication.acceptedAt !== undefined || publication.integrationRequestId !== undefined)) {
    throw new Error("Gateway Review publication response is invalid");
  }
  return {
    publicationId: publication.publicationId,
    roomId,
    reviewPointId,
    taskId: publication.taskId,
    workspaceSnapshotId: publication.workspaceSnapshotId,
    publishedBy: publication.publishedBy,
    summary: publication.summary,
    findingIds: [...publication.findingIds] as string[],
    state: publication.state,
    createdAt: publication.createdAt as number,
    ...(accepted ? {
      acceptedBy: publication.acceptedBy as string,
      acceptedAt: publication.acceptedAt as number,
      integrationRequestId: publication.integrationRequestId as string,
    } : {}),
  };
}

function reviewPublicationPage(value: unknown, roomId: string, reviewPointId: string): ReviewPublicationPage {
  const page = record(value);
  if (!page || !Array.isArray(page.publications) || page.publications.length > 1_000) {
    throw new Error("Gateway Review publication page is invalid");
  }
  return { publications: page.publications.map((publication) => reviewPublication(publication, roomId, reviewPointId)) };
}

function acceptedReviewPublication(value: unknown, roomId: string, reviewPointId: string): AcceptedReviewPublication {
  const result = record(value);
  if (!result || !Array.isArray(result.findings) || result.findings.length < 1 || result.findings.length > 100) {
    throw new Error("Gateway accepted Review publication response is invalid");
  }
  const publication = reviewPublication(result.publication, roomId, reviewPointId);
  const findings = result.findings.map((finding) => reviewFinding(finding, roomId, reviewPointId));
  if (publication.state !== "accepted" || findings.some((finding) => finding.state !== "accepted")
    || findings.length !== publication.findingIds.length
    || findings.some((finding, index) => finding.findingId !== publication.findingIds[index])) {
    throw new Error("Gateway accepted Review publication response is invalid");
  }
  return { publication, findings };
}

function reviewPointDiff(value: unknown): ReviewPointDiff {
  const diff = record(value);
  if (!diff || typeof diff.path !== "string" || !safeSnapshotPath(diff.path)) throw new Error("Gateway Review Point diff response is invalid");
  if (diff.kind === "binary" || diff.kind === "unavailable") return { path: diff.path, kind: diff.kind };
  if (diff.kind !== "text" || (diff.oldText !== null && typeof diff.oldText !== "string") || (diff.newText !== null && typeof diff.newText !== "string")
    || (typeof diff.oldText === "string" && diff.oldText.length > 2 * 1024 * 1024)
    || (typeof diff.newText === "string" && diff.newText.length > 2 * 1024 * 1024)) {
    throw new Error("Gateway Review Point diff response is invalid");
  }
  return { path: diff.path, kind: "text", oldText: diff.oldText, newText: diff.newText };
}

export class DshBrowserCollabClient implements DshCollabClientPort {
  private hostBase: string;
  private base: string;
  private readonly fetcher: BrowserFetch;
  private readonly socketFactory: new (url: string) => BrowserSocket;
  private readonly connectionIdFactory: () => string;
  private roomId: string;
  private readonly listeners = new Set<() => void>();
  private socket: BrowserSocket | undefined;
  private token: string | undefined;
  private lastEventSeq = 0;
  private readonly events = new Map<string, RoomEvent>();
  private readonly activeAgentOutputs = new Map<string, AgentOutputFrame>();
  private snapshot: DshCollabClientSnapshot;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatAcknowledged = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
  private disposed = false;
  private manuallyDisconnected = false;
  private participantRef: JoinedRoomRef | undefined;
  private readonly pendingCommandIds = new Map<string, string>();
  private readonly pendingJoins = new Map<string, { memberId: string; credential: string }>();
  private readonly pendingMessageIds = new Map<string, string>();

  constructor(private readonly options: DshBrowserCollabOptions) {
    this.hostBase = normalizeBase(options.gatewayUrl);
    this.base = this.hostBase;
    this.roomId = options.roomId;
    this.fetcher = options.fetch ?? defaultFetch();
    this.socketFactory = options.WebSocket ?? defaultWebSocket();
    this.connectionIdFactory = options.connectionIdFactory ?? (() => randomId("conn"));
    this.token = options.token;
    this.snapshot = {
      roomId: options.roomId,
      roomTitle: "Collaboration room",
      hostDisplayName: "",
      role: options.role ?? "participant",
      connection: options.token ? "connecting" : "offline",
      onlineCount: 0,
      canSteer: options.role === "host",
      members: [],
      timeline: [],
      agentQueue: [],
      roomEvents: [],
    };
  }

  getSnapshot(): DshCollabClientSnapshot { return { ...this.snapshot }; }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  getSettingsSnapshot(): { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; advertisedEndpoint: string } {
    const url = new URL(this.hostBase);
    const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
    return { gatewayHost: url.hostname, gatewayPort: port, exposeMode: url.hostname === "127.0.0.1" ? "loopback" : "network", advertisedEndpoint: "" };
  }

  configureGateway(input: { gatewayHost: string; gatewayPort: number }): void {
    const hostname = input.gatewayHost === "0.0.0.0" ? "127.0.0.1" : input.gatewayHost;
    this.hostBase = normalizeBase(`http://${hostname}:${String(input.gatewayPort)}/collab`);
  }

  settingsPort(): DshBrowserSettingsPort { return new DshBrowserCollabSettings(this); }

  getLocalSnapshotAccess(roomId: string): LocalSnapshotAccess {
    this.assertActiveRoom(roomId);
    return { gatewayEndpoint: gatewayWebSocketUrl(this.base), roomToken: this.token! };
  }

  async bootstrap(roomId?: string): Promise<void> {
    const nextRoomId = roomId?.trim() || this.roomId;
    this.assertCanActivateRoom(nextRoomId, "opening another room");
    const data = roomData(parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(nextRoomId)}/bootstrap`, undefined, false, this.hostBase)), nextRoomId);
    await this.connect({ base: this.hostBase, roomId: nextRoomId, data });
  }

  async shareHostRoom(input: { roomId: string; hostSessionId: string; title: string }): Promise<void> {
    const roomId = input.roomId.trim();
    this.assertCanActivateRoom(roomId, "sharing another room");
    const hostSessionId = input.hostSessionId.trim();
    const title = input.title.trim();
    if (roomId === "") throw new Error("roomId must not be blank");
    if (hostSessionId === "") throw new Error("hostSessionId must not be blank");
    if (title === "") throw new Error("Room name must not be blank");
    if (title.length > 80) throw new Error("Room name must be at most 80 characters");
    const data = roomData(parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(roomId)}/host`, { hostSessionId, title }, false, this.hostBase)), roomId);
    await this.connect({ base: this.hostBase, roomId, data });
  }

  async stopSharing(roomId: string): Promise<void> {
    const normalizedRoomId = roomId.trim();
    if (normalizedRoomId === "") throw new Error("roomId must not be blank");
    parseEnvelope(await this.request("DELETE", `/v1/rooms/${encodeURIComponent(normalizedRoomId)}/host`, undefined, false, this.hostBase));
    if (this.snapshot.role === "host" && this.roomId === normalizedRoomId) this.disconnect();
  }

  disconnect(): void {
    this.manuallyDisconnected = true;
    this.participantRef = undefined;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    this.token = undefined;
    this.activeAgentOutputs.clear();
    this.snapshot = { ...this.snapshot, unavailableReason: undefined, timeline: this.projectTimeline(), agentQueue: [] };
    socket?.close(1000, "client_disconnected");
    this.setConnection("offline");
  }

  async join(input: DshBrowserJoinInput, roomId?: string): Promise<void> {
    await this.options.participantPersistence?.prepare?.();
    const invitation = decodeCollabInvitation(input.invitation);
    let nextBase = normalizeBase(gatewayHttpUrl(invitation.gatewayEndpoint));
    const nextRoomId = invitation.roomId;
    this.assertCanActivateRoom(nextRoomId, "joining another room");
    const ref = { gatewayEndpoint: invitation.gatewayEndpoint, roomId: invitation.roomId };
    const pendingKey = JSON.stringify({ ...ref, inviteId: invitation.inviteId, memberId: input.memberId?.trim(), displayName: input.displayName.trim() });
    const saved = this.options.participantPersistence?.load(ref);
    let easyTier = saved?.easyTier;
    let easyTierAttempted = false;
    let temporaryCredentialSaved = false;
    const cleanupFailedJoin = async (): Promise<void> => {
      this.pendingJoins.delete(pendingKey);
      if (!saved && temporaryCredentialSaved) {
        if (this.options.participantPersistence?.remove) await this.options.participantPersistence.remove(ref);
        else await this.options.participantPersistence?.clear?.();
      }
      if (easyTierAttempted) await this.options.easyTierTransport?.stop().catch(() => undefined);
    };
    try {
      if (invitation.protocol === "dsh-collab.invitation.v2" && invitation.network.mode === "easytier") {
        if (!this.options.easyTierTransport) throw new Error("EasyTier transport is unavailable on this DSH client");
        const gateway = new URL(invitation.gatewayEndpoint);
        easyTierAttempted = true;
        const active = await this.options.easyTierTransport.startParticipant({
          roomId: nextRoomId,
          gatewayPort: Number(gateway.port || 80),
          network: invitation.network,
          ...(easyTier ? { localVirtualAddress: easyTier.localVirtualAddress } : {}),
        });
        nextBase = normalizeBase(gatewayHttpUrl(active.gatewayEndpoint));
        easyTier = { network: invitation.network, localVirtualAddress: active.localVirtualAddress };
      }
      const binding = saved ?? this.pendingJoins.get(pendingKey) ?? {
        memberId: input.memberId?.trim() || randomId("member"),
        credential: randomCredential(),
      };
      this.pendingJoins.set(pendingKey, binding);
      if (!saved && this.options.participantPersistence) {
        await this.options.participantPersistence.save({ ...ref, memberId: binding.memberId, credential: binding.credential, ...(easyTier ? { easyTier } : {}) });
        temporaryCredentialSaved = true;
      }
      const data = roomData(parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(nextRoomId)}/join`, {
        inviteId: invitation.inviteId,
        token: invitation.token,
        memberId: binding.memberId,
        displayName: input.displayName,
        resumeCredential: binding.credential,
      }, false, nextBase)), nextRoomId);
      if (this.options.participantPersistence) {
        if (typeof data.resumeCredential !== "string" || data.resumeCredential.trim() === "") throw new Error("Gateway join response is missing a resume credential");
        await this.options.participantPersistence.save({
          ...ref,
          memberId: data.member.memberId,
          credential: data.resumeCredential,
          roomTitle: data.room.title,
          ...(data.room.hostDisplayName ? { hostDisplayName: data.room.hostDisplayName } : {}),
          ...(easyTier ? { easyTier } : {}),
        });
      }
      this.pendingJoins.delete(pendingKey);
      await this.connect({
        base: nextBase,
        roomId: nextRoomId,
        participantRef: ref,
        data,
      });
    } catch (error) {
      await cleanupFailedJoin();
      throw error;
    }
  }

  async restoreParticipant(ref?: JoinedRoomRef): Promise<boolean> {
    await this.options.participantPersistence?.prepare?.();
    const state = this.options.participantPersistence?.load(ref);
    if (!state) return false;
    this.assertCanActivateRoom(state.roomId, "reconnecting another room");
    const nextRef = { gatewayEndpoint: state.gatewayEndpoint, roomId: state.roomId };
    let nextBase = normalizeBase(gatewayHttpUrl(state.gatewayEndpoint));
    const preserveCurrentRoom = this.socket?.readyState === OPEN && this.snapshot.connection === "online";
    let easyTierAttempted = false;
    try {
      if (state.easyTier) {
        if (!this.options.easyTierTransport) throw new EasyTierConnectionError("transport-failed", "EasyTier transport is unavailable on this DSH client");
        const gateway = new URL(state.gatewayEndpoint);
        easyTierAttempted = true;
        const active = await this.options.easyTierTransport.startParticipant({
          roomId: state.roomId,
          gatewayPort: Number(gateway.port || 80),
          network: state.easyTier.network,
          localVirtualAddress: state.easyTier.localVirtualAddress,
        });
        nextBase = normalizeBase(gatewayHttpUrl(active.gatewayEndpoint));
      }
      const data = roomData(parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(state.roomId)}/resume`, { credential: state.credential }, false, nextBase)), state.roomId);
      await this.connect({ base: nextBase, roomId: state.roomId, participantRef: nextRef, data });
      return true;
    } catch (error) {
      if (!preserveCurrentRoom) {
        this.base = nextBase;
        this.roomId = state.roomId;
        this.participantRef = nextRef;
        this.token = undefined;
        this.applyParticipantFailure(state, error);
      }
      if (error instanceof GatewayRequestError && (error.status === 401 || error.status === 403 || error.status === 404)) {
        if (this.options.participantPersistence?.remove) await this.options.participantPersistence.remove(state);
        else await this.options.participantPersistence?.clear?.();
      }
      if (easyTierAttempted && !preserveCurrentRoom) await this.options.easyTierTransport?.stop().catch(() => undefined);
      throw error;
    }
  }

  listJoinedRooms(): readonly ParticipantResumeState[] {
    return this.options.participantPersistence?.list?.() ?? [];
  }

  subscribeJoinedRooms(listener: () => void): () => void {
    return this.options.participantPersistence?.subscribe?.(listener) ?? (() => {});
  }

  async connectJoinedRoom(ref: JoinedRoomRef): Promise<void> {
    if (!(await this.restoreParticipant(ref))) throw new Error("Joined room is not saved");
  }

  async disconnectJoinedRoom(): Promise<void> {
    await this.options.participantPersistence?.prepare?.();
    const saved = this.participantRef ? this.options.participantPersistence?.load(this.participantRef) : undefined;
    if (saved?.easyTier) await this.options.easyTierTransport?.stop();
    this.disconnect();
  }

  async forgetJoinedRoom(ref: JoinedRoomRef): Promise<void> {
    await this.options.participantPersistence?.prepare?.();
    const saved = this.options.participantPersistence?.load(ref);
    if (!saved) return;
    if (this.snapshot.role === "participant" && this.participantRef?.roomId === ref.roomId && this.participantRef.gatewayEndpoint === ref.gatewayEndpoint) {
      this.disconnect();
      if (saved.easyTier) await this.options.easyTierTransport?.stop();
    }
    if (this.options.participantPersistence?.remove) await this.options.participantPersistence.remove(ref);
    else await this.options.participantPersistence?.clear?.();
  }

  async createInvite(input: DshBrowserInviteInput, roomId?: string): Promise<{ invitation: string }> {
    const inviteRoomId = roomId?.trim() || this.roomId;
    if (this.snapshot.connection === "offline" || this.snapshot.role !== "host" || inviteRoomId !== this.roomId) {
      throw new Error("create invitations are available only for the active Host room");
    }
    const inviteId = input.inviteId?.trim() || randomId("invite");
    const data = parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(inviteRoomId)}/invites`, { inviteId, expiresAt: input.expiresAt }, false, this.hostBase));
    const created = data as { invite?: { inviteId?: unknown; roomId?: unknown; expiresAt?: unknown }; token?: unknown };
    if (!created?.invite || typeof created.invite.inviteId !== "string" || typeof created.invite.roomId !== "string" || typeof created.invite.expiresAt !== "number" || typeof created.token !== "string") {
      throw new Error("Gateway invite response is invalid");
    }
    const common = {
      type: "invite",
      gatewayEndpoint: input.gatewayEndpoint,
      roomId: created.invite.roomId,
      inviteId: created.invite.inviteId,
      token: created.token,
      expiresAt: created.invite.expiresAt,
    } as const;
    const endpoint = new URL(input.gatewayEndpoint);
    const network = input.network ?? (endpoint.protocol === "wss:"
      ? { mode: "custom-wss" as const, version: 1 as const, endpoint: input.gatewayEndpoint }
      : { mode: "lan" as const, version: 1 as const, endpoint: input.gatewayEndpoint });
    return { invitation: encodeCollabInvitation({ protocol: "dsh-collab.invitation.v2", ...common, network }) };
  }

  async send(input: { text: string; target: ComposerTarget; contextRefs?: string[] }): Promise<void> {
    if (!this.token) throw new Error("join or bootstrap a collaboration room first");
    const pendingKey = JSON.stringify({ base: this.base, roomId: this.roomId, text: input.text, target: input.target, contextRefs: input.contextRefs });
    const clientMessageId = this.pendingMessageIds.get(pendingKey) ?? randomId("message");
    this.pendingMessageIds.set(pendingKey, clientMessageId);
    try {
      await this.request("POST", `/v1/rooms/${encodeURIComponent(this.roomId)}/messages`, {
        clientMessageId,
        text: input.text,
        target: input.target,
        ...(input.contextRefs && input.contextRefs.length > 0 ? { contextRefs: [...input.contextRefs] } : {}),
      }, true);
      this.pendingMessageIds.delete(pendingKey);
    } catch (error) {
      if (error instanceof GatewayRequestError && error.status >= 400 && error.status < 500) this.pendingMessageIds.delete(pendingKey);
      throw error;
    }
  }

  async editAgentRequest(requestId: string, text: string): Promise<void> {
    this.assertActiveRoom(this.roomId);
    await this.request("POST", `/v1/rooms/${encodeURIComponent(this.roomId)}/actions`, {
      action: "editAgentRequest",
      requestId,
      text,
    }, true);
  }

  async withdrawAgentRequest(requestId: string): Promise<void> {
    this.assertActiveRoom(this.roomId);
    await this.request("POST", `/v1/rooms/${encodeURIComponent(this.roomId)}/actions`, {
      action: "withdrawAgentRequest",
      requestId,
    }, true);
  }

  async getWorkspaceSharing(roomId: string): Promise<WorkspaceSharingState> {
    this.assertActiveRoom(roomId);
    const data = parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(roomId)}/workspace-sharing`, undefined, true)) as { state?: unknown };
    const state = workspaceSharingState(data?.state, roomId);
    this.applyWorkspaceSharing(state);
    return state;
  }

  async setWorkspaceSharing(roomId: string, enabled: boolean): Promise<WorkspaceSharingState> {
    this.assertActiveRoom(roomId);
    const data = parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(roomId)}/workspace-sharing`, { enabled }, true)) as { state?: unknown };
    const state = workspaceSharingState(data?.state, roomId);
    this.applyWorkspaceSharing(state);
    return state;
  }

  async requestWorkspaceSnapshot(roomId: string): Promise<WorkspaceSnapshotPackage> {
    this.assertActiveRoom(roomId);
    const data = parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(roomId)}/workspace-snapshots`, { clientRequestId: randomId("snapshot") }, true)) as { snapshot?: unknown };
    return workspaceSnapshot(data?.snapshot, roomId);
  }

  async createReviewPoint(roomId: string, input: ReviewPointCreateInput): Promise<ReviewPoint> {
    this.assertActiveRoom(roomId);
    const commandKey = JSON.stringify({ resource: "review-point", roomId, input });
    const clientRequestId = this.pendingCommandIds.get(commandKey) ?? randomId("review");
    this.pendingCommandIds.set(commandKey, clientRequestId);
    const data = parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(roomId)}/review-points`, {
      clientRequestId,
      ...input,
    }, true)) as { reviewPoint?: unknown };
    const point = reviewPoint(data?.reviewPoint, roomId);
    this.pendingCommandIds.delete(commandKey);
    return point;
  }

  async listReviewPoints(roomId: string, after?: string, limit = 50): Promise<ReviewPointPage> {
    this.assertActiveRoom(roomId);
    const query = new URLSearchParams({ limit: String(limit) });
    if (after !== undefined) query.set("after", after);
    const data = parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(roomId)}/review-points?${query.toString()}`, undefined, true));
    return reviewPointPage(data, roomId);
  }

  async refreshReviewPoints(roomId: string): Promise<string> {
    this.assertActiveRoom(roomId);
    const commandKey = JSON.stringify({ resource: "review-refresh", roomId });
    const clientRequestId = this.pendingCommandIds.get(commandKey) ?? randomId("review_refresh");
    this.pendingCommandIds.set(commandKey, clientRequestId);
    const data = record(parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(roomId)}/review-points/refresh`, {
      clientRequestId,
    }, true)));
    if (!data || typeof data.snapshotId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.snapshotId)) {
      throw new Error("Gateway Review Point refresh response is invalid");
    }
    this.pendingCommandIds.delete(commandKey);
    return data.snapshotId;
  }

  async loadReviewPointDiff(roomId: string, reviewPointId: string, fileIndex: number): Promise<ReviewPointDiff> {
    this.assertActiveRoom(roomId);
    if (!Number.isSafeInteger(fileIndex) || fileIndex < 0) throw new Error("Review Point diff file index is invalid");
    const data = record(parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(roomId)}/review-points/${encodeURIComponent(reviewPointId)}/diffs/${String(fileIndex)}`, undefined, true)));
    return reviewPointDiff(data?.diff);
  }

  async createReviewFinding(roomId: string, reviewPointId: string, input: ReviewFindingCreateInput): Promise<ReviewFinding> {
    this.assertActiveRoom(roomId);
    const commandKey = JSON.stringify({ resource: "review-finding", roomId, reviewPointId, input });
    const clientRequestId = this.pendingCommandIds.get(commandKey) ?? randomId("finding");
    this.pendingCommandIds.set(commandKey, clientRequestId);
    const data = record(parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(roomId)}/review-points/${encodeURIComponent(reviewPointId)}/findings`, {
      clientRequestId,
      ...input,
    }, true)));
    const finding = reviewFinding(data?.finding, roomId, reviewPointId);
    this.pendingCommandIds.delete(commandKey);
    return finding;
  }

  async listReviewFindings(roomId: string, reviewPointId: string, after?: string, limit = 50): Promise<ReviewFindingPage> {
    this.assertActiveRoom(roomId);
    const query = new URLSearchParams({ limit: String(limit) });
    if (after !== undefined) query.set("after", after);
    const data = parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(roomId)}/review-points/${encodeURIComponent(reviewPointId)}/findings?${query.toString()}`, undefined, true));
    return reviewFindingPage(data, roomId, reviewPointId);
  }

  async setReviewers(roomId: string, reviewPointId: string, reviewerIds: string[]): Promise<ReviewPoint> {
    this.assertActiveRoom(roomId);
    const data = record(parseEnvelope(await this.request("PUT", `/v1/rooms/${encodeURIComponent(roomId)}/review-points/${encodeURIComponent(reviewPointId)}/reviewers`, { reviewerIds }, true)));
    return reviewPoint(data?.reviewPoint, roomId);
  }

  async setReviewLifecycle(roomId: string, reviewPointId: string, lifecycle: ReviewLifecycle): Promise<ReviewPoint> {
    this.assertActiveRoom(roomId);
    const data = record(parseEnvelope(await this.request("PUT", `/v1/rooms/${encodeURIComponent(roomId)}/review-points/${encodeURIComponent(reviewPointId)}/lifecycle`, { lifecycle }, true)));
    return reviewPoint(data?.reviewPoint, roomId);
  }

  async setReviewFindingState(roomId: string, reviewPointId: string, findingId: string, state: "accepted" | "dismissed"): Promise<ReviewFinding> {
    this.assertActiveRoom(roomId);
    const data = record(parseEnvelope(await this.request("PUT", `/v1/rooms/${encodeURIComponent(roomId)}/review-points/${encodeURIComponent(reviewPointId)}/findings/${encodeURIComponent(findingId)}/state`, { state }, true)));
    return reviewFinding(data?.finding, roomId, reviewPointId);
  }

  async publishReviewPublication(roomId: string, reviewPointId: string, input: ReviewPublicationCreateInput): Promise<ReviewPublication> {
    this.assertActiveRoom(roomId);
    const data = record(parseEnvelope(await this.request("POST", `/v1/rooms/${encodeURIComponent(roomId)}/review-points/${encodeURIComponent(reviewPointId)}/publications`, input, true)));
    return reviewPublication(data?.publication, roomId, reviewPointId);
  }

  async listReviewPublications(roomId: string, reviewPointId: string): Promise<ReviewPublicationPage> {
    this.assertActiveRoom(roomId);
    return reviewPublicationPage(parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(roomId)}/review-points/${encodeURIComponent(reviewPointId)}/publications`, undefined, true)), roomId, reviewPointId);
  }

  async acceptReviewPublication(roomId: string, reviewPointId: string, publicationId: string): Promise<AcceptedReviewPublication> {
    this.assertActiveRoom(roomId);
    return acceptedReviewPublication(parseEnvelope(await this.request("PUT", `/v1/rooms/${encodeURIComponent(roomId)}/review-points/${encodeURIComponent(reviewPointId)}/publications/${encodeURIComponent(publicationId)}/state`, { state: "accepted" }, true)), roomId, reviewPointId);
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHeartbeat();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "client_closed");
    this.setConnection("offline");
    this.listeners.clear();
    const saved = this.participantRef ? this.options.participantPersistence?.load(this.participantRef) : undefined;
    if (saved?.easyTier) void this.options.easyTierTransport?.stop().catch(() => undefined);
  }

  private async connect(input: { base: string; roomId: string; participantRef?: JoinedRoomRef; data: RoomData }): Promise<void> {
    const snapshot = snapshotData(parseEnvelope(await this.request(
      "GET",
      `/v1/rooms/${encodeURIComponent(input.roomId)}/snapshot`,
      undefined,
      true,
      input.base,
      input.data.roomToken,
    )), input.roomId);
    const events = await this.recoverEvents(input.roomId, snapshot.lastEventSeq, input.base, input.data.roomToken);
    const lastEventSeq = Math.max(snapshot.lastEventSeq, ...[...events.values()].map((event) => event.seq));
    const streamTicket = streamTicketData(parseEnvelope(await this.request(
      "POST",
      `/v1/rooms/${encodeURIComponent(input.roomId)}/stream-tickets`,
      {},
      true,
      input.base,
      input.data.roomToken,
    )));
    const url = new URL(gatewayWebSocketUrl(input.base) + "/v1/stream");
    url.searchParams.set("roomId", input.roomId);
    url.searchParams.set("after", String(lastEventSeq));
    url.searchParams.set("connectionId", this.connectionIdFactory());
    url.searchParams.set("ticket", streamTicket.ticket);
    url.searchParams.append("feature", SIDECAR_REVIEW_CAPABILITY);
    url.searchParams.append("feature", CHANGE_SET_CAPABILITY);
    const bufferedFrames: string[] = [];
    const socket = await new Promise<BrowserSocket>((resolve, reject) => {
      const socket = new this.socketFactory(url.toString());
      let settled = false;
      socket.onopen = () => { if (!settled) { settled = true; resolve(socket); } };
      socket.onmessage = (event) => { bufferedFrames.push(event.data); };
      socket.onclose = () => { if (!settled) { settled = true; reject(new GatewayConnectionError()); } };
      socket.onerror = () => {
        if (!settled) {
          settled = true;
          socket.close(1000, "connection_failed");
          reject(new GatewayConnectionError());
        }
      };
    });
    if (this.disposed || socket.readyState !== OPEN) {
      socket.close(1000, "connection_abandoned");
      throw new GatewayConnectionError();
    }

    const previousSocket = this.socket;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.clearHeartbeat();
    this.socket = socket;
    this.base = input.base;
    this.roomId = input.roomId;
    this.participantRef = input.participantRef;
    this.token = input.data.roomToken;
    this.lastEventSeq = lastEventSeq;
    this.events.clear();
    for (const [eventId, event] of events) this.events.set(eventId, event);
    this.activeAgentOutputs.clear();
    this.snapshot = {
      roomId: input.roomId,
      gatewayEndpoint: input.participantRef?.gatewayEndpoint ?? gatewayWebSocketUrl(input.base),
      memberId: input.data.member.memberId,
      roomTitle: snapshot.room.title,
      hostDisplayName: snapshot.room.hostDisplayName ?? snapshot.members.find((member) => member.role === "host")?.displayName ?? input.data.room.hostDisplayName ?? "",
      role: input.data.member.role === "host" ? "host" : "participant",
      connection: "online",
      onlineCount: 0,
      canSteer: input.data.member.role === "host" || input.data.member.role === "lead",
      unavailableReason: undefined,
      members: snapshot.members.flatMap((member) => (member.status === undefined || member.status === "active") && typeof member.displayName === "string" && member.displayName.trim() !== ""
        ? [{ memberId: member.memberId, displayName: member.displayName }]
        : []),
      timeline: projectTimeline([...events.values()], []),
      agentQueue: projectAgentQueue([...events.values()]),
      roomEvents: [...events.values()],
    };
    this.manuallyDisconnected = false;
    this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    socket.onmessage = (event) => { if (this.socket !== socket) return; this.heartbeatAcknowledged = true; this.applyFrame(event.data); };
    socket.onclose = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.clearHeartbeat();
      this.setConnection("offline");
      this.scheduleReconnect();
    };
    socket.onerror = () => {
      if (this.socket !== socket) return;
      if (this.snapshot.role === "participant" && !this.snapshot.unavailableReason) this.setUnavailableReason("host-unreachable");
      this.setConnection("offline");
    };
    previousSocket?.close(1000, "reconnect");
    this.startHeartbeat(socket);
    this.emit();
    for (const frame of bufferedFrames) this.applyFrame(frame);
  }

  private startHeartbeat(socket: BrowserSocket): void {
    this.clearHeartbeat();
    this.heartbeatAcknowledged = true;
    this.heartbeatTimer = setInterval(() => {
      if (this.socket !== socket || socket.readyState !== OPEN) return;
      if (!this.heartbeatAcknowledged) {
        this.socket = undefined;
        this.clearHeartbeat();
        this.setConnection("offline");
        this.scheduleReconnect();
        socket.close(4000, "heartbeat_timeout");
        return;
      }
      this.heartbeatAcknowledged = false;
      socket.send(JSON.stringify(encodeClientStreamFrame({ protocol: COLLAB_PROTOCOL, type: "heartbeat" })));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.heartbeatAcknowledged = true;
  }

  private scheduleReconnect(): void {
    if (this.disposed || this.manuallyDisconnected || this.reconnectTimer) return;
    if (this.snapshot.role === "participant" && (!this.participantRef || !this.options.participantPersistence?.load(this.participantRef))) return;
    const delay = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.disposed) return;
      const reconnect = this.snapshot.role === "host" ? this.bootstrap() : this.restoreParticipant(this.participantRef);
      void reconnect.catch(() => {
        this.reconnectDelayMs = Math.min(delay * 2, MAX_RECONNECT_DELAY_MS);
        this.scheduleReconnect();
      });
    }, delay);
  }

  private async request(method: string, path: string, body: unknown, withToken: boolean, base = this.base, token = this.token): Promise<unknown> {
    const headers: Record<string, string> = {
      accept: "application/json",
      [COLLAB_CAPABILITY_HEADER]: `${SIDECAR_REVIEW_CAPABILITY},${CHANGE_SET_CAPABILITY}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (withToken && token) headers.authorization = `Bearer ${token}`;
    let response: BrowserResponse;
    try {
      response = await this.fetcher(base + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (cause) {
      throw new GatewayConnectionError(cause);
    }
    const envelope = await response.json() as Envelope;
    if (!response.ok) throw new GatewayRequestError(response.status, envelope.error?.code, envelope.error?.message);
    return envelope;
  }

  private applyFrame(raw: string): void {
    let frame: DecodedServerStreamFrame;
    try { frame = decodeServerStreamFrame(JSON.parse(raw) as unknown); } catch { return; }
    if (frame.kind === "closed" && frame.reason === "room_not_shared" && this.snapshot.role === "participant") {
      this.setUnavailableReason("host-stopped-sharing");
      this.setConnection("offline");
      return;
    }
    if (frame.kind === "presence" && frame.roomId === this.snapshot.roomId) {
      this.snapshot = { ...this.snapshot, onlineCount: frame.onlineMemberCount };
      this.emit();
      return;
    }
    if (frame.kind === "agent-output" && frame.roomId === this.snapshot.roomId) {
      if (frame.streaming) this.activeAgentOutputs.set(frame.requestId, frame);
      else this.activeAgentOutputs.delete(frame.requestId);
      this.snapshot = { ...this.snapshot, timeline: this.projectTimeline() };
      this.emit();
      return;
    }
    if (frame.kind === "event") {
      const event = frame.event;
      if (event.roomId !== this.roomId) return;
      if (this.events.has(event.eventId)) return;
      if (event.seq !== this.lastEventSeq + 1) {
        const socket = this.socket;
        this.socket = undefined;
        this.clearHeartbeat();
        this.setConnection("offline");
        this.scheduleReconnect();
        socket?.close(4001, "event_sequence_gap");
        return;
      }
      this.events.set(event.eventId, event);
      this.lastEventSeq = event.seq;
      if (event.type === "agent.state.changed" || event.type === "agent.request.completed" || event.type === "agent.request.failed" || event.type === "agent.request.rejected" || event.type === "agent.request.cancelled") {
        const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) ? event.payload as Record<string, unknown> : undefined;
        if (typeof payload?.requestId === "string") this.activeAgentOutputs.delete(payload.requestId);
      }
      let members = this.snapshot.members;
      if (event.type === "member.joined" && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
        const payload = event.payload as Record<string, unknown>;
        if (typeof payload.memberId === "string" && typeof payload.displayName === "string" && payload.displayName.trim() !== "") {
          members = [...(members ?? []).filter((member) => member.memberId !== payload.memberId), { memberId: payload.memberId, displayName: payload.displayName }];
        }
      }
      if ((event.type === "member.suspended" || event.type === "member.removed") && event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)) {
        const memberId = (event.payload as Record<string, unknown>).memberId;
        if (typeof memberId === "string") members = (members ?? []).filter((member) => member.memberId !== memberId);
      }
      let workspaceSharing = this.snapshot.workspaceSharing;
      if (event.type === "workspace-sharing.changed") {
        const state = workspaceSharingState(event.payload, event.roomId);
        if ((workspaceSharing?.revision ?? -1) <= state.revision) workspaceSharing = state;
      }
      this.snapshot = {
        ...this.snapshot,
        members,
        timeline: this.projectTimeline(),
        agentQueue: projectAgentQueue([...this.events.values()]),
        roomEvents: [...this.events.values()],
        ...(workspaceSharing ? { workspaceSharing } : {}),
      };
      this.emit();
    }
  }

  private projectTimeline(): DshCollabClientSnapshot["timeline"] {
    return projectTimeline([...this.events.values()], [...this.activeAgentOutputs.values()]);
  }

  private async recoverEvents(roomId: string, untilSeq: number, base: string, token: string): Promise<Map<string, RoomEvent>> {
    const events = new Map<string, RoomEvent>();
    let after = 0;
    while (after < untilSeq) {
      const data = parseEnvelope(await this.request("GET", `/v1/rooms/${encodeURIComponent(roomId)}/events?after=${String(after)}&limit=500`, undefined, true, base, token)) as EventsData;
      if (!Array.isArray(data.events) || data.events.length === 0) break;
      for (const event of data.events) {
        if (event.roomId !== roomId) throw new Error("Gateway room events do not match the requested room");
        if (event.seq !== after + 1) throw new Error(`Gateway event sequence is not contiguous: expected ${String(after + 1)}, received ${String(event.seq)}`);
        events.set(event.eventId, event);
        after = event.seq;
      }
      const next = data.nextSeq ?? after;
      if (next !== after) throw new Error(`Gateway event sequence cursor does not match the last event: expected ${String(after)}, received ${String(next)}`);
    }
    if (after < untilSeq) throw new Error(`Gateway event sequence stopped before snapshot cursor ${String(untilSeq)}`);
    return events;
  }

  private setConnection(connection: DshCollabClientSnapshot["connection"]): void {
    if (this.snapshot.connection === connection) return;
    this.snapshot = { ...this.snapshot, connection, ...(connection === "offline" ? { onlineCount: 0 } : {}) };
    this.emit();
  }

  private applyWorkspaceSharing(state: WorkspaceSharingState): void {
    if (state.roomId !== this.snapshot.roomId || (this.snapshot.workspaceSharing?.revision ?? -1) > state.revision) return;
    this.snapshot = { ...this.snapshot, workspaceSharing: state };
    this.emit();
  }

  private applyParticipantFailure(state: ParticipantResumeState, error: unknown): void {
    const unavailableReason = error instanceof GatewayRequestError
      ? error.code === "ROOM_INACTIVE"
        ? "host-stopped-sharing"
        : error.code === "RESOURCE_LIMIT"
          ? "resource-limited"
          : undefined
      : error instanceof GatewayConnectionError
        ? "host-unreachable"
        : error instanceof EasyTierConnectionError
          ? error.code
        : undefined;
    if (!unavailableReason) return;
    this.snapshot = {
      ...this.snapshot,
      roomId: state.roomId,
      memberId: state.memberId,
      roomTitle: state.roomTitle ?? this.snapshot.roomTitle,
      hostDisplayName: state.hostDisplayName ?? this.snapshot.hostDisplayName,
      role: "participant",
      connection: "offline",
      onlineCount: 0,
      unavailableReason,
    };
    this.emit();
  }

  private setUnavailableReason(unavailableReason: NonNullable<DshCollabClientSnapshot["unavailableReason"]>): void {
    if (this.snapshot.unavailableReason === unavailableReason) return;
    this.snapshot = { ...this.snapshot, unavailableReason };
    this.emit();
  }

  private assertCanActivateRoom(nextRoomId: string, action: string): void {
    if (this.snapshot.connection !== "offline" && this.roomId !== nextRoomId) {
      throw new Error(`another collaboration room is already active (${this.roomId}); disconnect it before ${action}`);
    }
  }

  private assertActiveRoom(roomId: string): void {
    if (roomId !== this.roomId || this.snapshot.roomId !== roomId || !this.token) throw new Error("connect to this collaboration room first");
  }

  private emit(): void { for (const listener of this.listeners) listener(); }
}

export class GatewayRequestError extends Error {
  constructor(readonly status: number, readonly code?: string, message?: string) {
    super(message ?? `Gateway request failed (${String(status)})`);
    this.name = "GatewayRequestError";
  }
}

export class GatewayConnectionError extends Error {
  readonly code = "GATEWAY_UNREACHABLE";

  constructor(cause?: unknown) {
    super("Gateway is unreachable", { cause });
    this.name = "GatewayConnectionError";
  }
}

export class EasyTierConnectionError extends Error {
  constructor(readonly code: "network-offline" | "transport-failed", message: string, cause?: unknown) {
    super(message, { cause });
    this.name = "EasyTierConnectionError";
  }
}

class DshBrowserCollabSettings implements DshBrowserSettingsPort {
  constructor(private readonly client: DshBrowserCollabClient) {
    this.stopSharing = this.stopSharing.bind(this);
    this.connectJoinedRoom = this.connectJoinedRoom.bind(this);
    this.forgetJoinedRoom = this.forgetJoinedRoom.bind(this);
  }
  getSnapshot(): { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; advertisedEndpoint: string } {
    return this.client.getSettingsSnapshot();
  }
  getRoomSnapshot(): Pick<DshCollabClientSnapshot, "roomId" | "gatewayEndpoint" | "memberId" | "roomTitle" | "hostDisplayName" | "role" | "connection"> { return this.client.getSnapshot(); }
  subscribeRoom(listener: () => void): () => void { return this.client.subscribe(listener); }
  async save(): Promise<void> {}
  bootstrap(roomId?: string): Promise<void> { return this.client.bootstrap(roomId); }
  shareHostRoom(input: { roomId: string; hostSessionId: string; title: string }): Promise<void> { return this.client.shareHostRoom(input); }
  stopSharing(roomId: string): Promise<void> { return this.client.stopSharing(roomId); }
  join(input: DshBrowserJoinInput, roomId?: string): Promise<void> { return this.client.join(input, roomId); }
  createInvite(input: DshBrowserInviteInput, roomId?: string): Promise<{ invitation: string }> { return this.client.createInvite(input, roomId); }
  listJoinedRooms(): readonly ParticipantResumeState[] { return this.client.listJoinedRooms(); }
  subscribeJoinedRooms(listener: () => void): () => void { return this.client.subscribeJoinedRooms(listener); }
  connectJoinedRoom(ref: JoinedRoomRef): Promise<void> { return this.client.connectJoinedRoom(ref); }
  disconnectJoinedRoom(): Promise<void> { return this.client.disconnectJoinedRoom(); }
  forgetJoinedRoom(ref: JoinedRoomRef): Promise<void> { return this.client.forgetJoinedRoom(ref); }
  configureGateway(input: { gatewayHost: string; gatewayPort: number }): void { this.client.configureGateway(input); }
  getLocalSnapshotAccess(roomId: string): LocalSnapshotAccess { return this.client.getLocalSnapshotAccess(roomId); }
  getWorkspaceSharing(roomId: string): Promise<WorkspaceSharingState> { return this.client.getWorkspaceSharing(roomId); }
  setWorkspaceSharing(roomId: string, enabled: boolean): Promise<WorkspaceSharingState> { return this.client.setWorkspaceSharing(roomId, enabled); }
  requestWorkspaceSnapshot(roomId: string): Promise<WorkspaceSnapshotPackage> { return this.client.requestWorkspaceSnapshot(roomId); }
  createReviewPoint(roomId: string, input: ReviewPointCreateInput): Promise<ReviewPoint> { return this.client.createReviewPoint(roomId, input); }
  listReviewPoints(roomId: string, after?: string, limit?: number): Promise<ReviewPointPage> { return this.client.listReviewPoints(roomId, after, limit); }
  refreshReviewPoints(roomId: string): Promise<string> { return this.client.refreshReviewPoints(roomId); }
  loadReviewPointDiff(roomId: string, reviewPointId: string, fileIndex: number): Promise<ReviewPointDiff> { return this.client.loadReviewPointDiff(roomId, reviewPointId, fileIndex); }
  createReviewFinding(roomId: string, reviewPointId: string, input: ReviewFindingCreateInput): Promise<ReviewFinding> { return this.client.createReviewFinding(roomId, reviewPointId, input); }
  listReviewFindings(roomId: string, reviewPointId: string, after?: string, limit?: number): Promise<ReviewFindingPage> { return this.client.listReviewFindings(roomId, reviewPointId, after, limit); }
  setReviewers(roomId: string, reviewPointId: string, reviewerIds: string[]): Promise<ReviewPoint> { return this.client.setReviewers(roomId, reviewPointId, reviewerIds); }
  setReviewLifecycle(roomId: string, reviewPointId: string, lifecycle: ReviewLifecycle): Promise<ReviewPoint> { return this.client.setReviewLifecycle(roomId, reviewPointId, lifecycle); }
  setReviewFindingState(roomId: string, reviewPointId: string, findingId: string, state: "accepted" | "dismissed"): Promise<ReviewFinding> { return this.client.setReviewFindingState(roomId, reviewPointId, findingId, state); }
  publishReviewPublication(roomId: string, reviewPointId: string, input: ReviewPublicationCreateInput): Promise<ReviewPublication> { return this.client.publishReviewPublication(roomId, reviewPointId, input); }
  listReviewPublications(roomId: string, reviewPointId: string): Promise<ReviewPublicationPage> { return this.client.listReviewPublications(roomId, reviewPointId); }
  acceptReviewPublication(roomId: string, reviewPointId: string, publicationId: string): Promise<AcceptedReviewPublication> { return this.client.acceptReviewPublication(roomId, reviewPointId, publicationId); }
}

export function createDshBrowserCollabClient(options: DshBrowserCollabOptions): DshBrowserCollabClient {
  return new DshBrowserCollabClient(options);
}
