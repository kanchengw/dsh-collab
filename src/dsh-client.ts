import { createElement, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import { MarkdownText, MessageText } from "@deepseek-ai/dsh-client-ui-primitives";
import { composerKeyAction, composerTargetForGesture, composerTargetForText, insertAgentMention, shouldSuggestAgentMention, type ComposerTarget, type TimelineItem } from "./ui.js";
import { createDshBrowserCollabClient, GatewayConnectionError, GatewayRequestError, type DshBrowserCollabClient, type DshBrowserJoinInput, type JoinedRoomRef, type ParticipantPersistence, type ParticipantResumeState } from "./dsh-browser-client.js";
import { DshCollabSettingsCard } from "./collab-settings-card.js";
import { closeDshCollabRoom, DshCollabRoomsLauncher, DshCollabRoomsPanel, openDshCollabRoom, useDshCollabRoomSelection } from "./collab-rooms.js";
import { normalizeAdvertisedGatewayEndpoint, normalizeGatewayEndpoint } from "./endpoint-policy.js";
import { defaultCollabSettings, DSH_COLLAB_PARTICIPANT_NAMESPACE, migrateLegacyMaxQueue, type DshCollabParticipantSettings, type DshCollabSecuritySettings } from "./settings-shared.js";
import { COLLAB_LOCALE_NAMESPACE, defaultCollabTranslate, en, zh, type CollabLocaleKey, type CollabTranslate } from "./locales.js";
import type { AcceptedReviewPublication, ReviewFinding, ReviewFindingCreateInput, ReviewFindingPage, ReviewLifecycle, ReviewPoint, ReviewPointCreateInput, ReviewPointDiff, ReviewPointPage, ReviewPublication, ReviewPublicationCreateInput, ReviewPublicationPage, WorkspaceSharingState, WorkspaceSnapshotPackage } from "./collaboration-types.js";
import type { RepositoryDiff, RepositoryInspection } from "./repository-inspector.js";
import roomCss from "./collab-room.module.css";
import { DshCollabInspector, useCollabInspector } from "./collab-inspector.js";
import type { LocalSideTaskSnapshot, LocalSnapshotAccess, StartExplainTaskInput, StartReviewTaskInput } from "./local-sidecar.js";
import type { AgentQueueItem } from "./types.js";
import { MAX_CONTEXT_REFS } from "./messages.js";
import { resolveBetterSidebarHost, type BetterSidebarServicePort } from "./better-sidebar-host.js";

export interface DshCollabClientSnapshot {
  roomId: string;
  gatewayEndpoint?: string;
  memberId?: string;
  roomTitle: string;
  hostDisplayName: string;
  role: "host" | "participant";
  connection: "connecting" | "online" | "offline";
  onlineCount: number;
  canSteer: boolean;
  unavailableReason?: "host-stopped-sharing" | "host-unreachable" | "resource-limited";
  members?: readonly { memberId: string; displayName: string }[];
  timeline?: readonly TimelineItem[];
  agentQueue?: readonly AgentQueueItem[];
  workspaceSharing?: WorkspaceSharingState;
}

export interface DshCollabClientPort {
  getSnapshot(): DshCollabClientSnapshot;
  subscribe(listener: () => void): () => void;
  send(input: { text: string; target: ComposerTarget; contextRefs?: string[] }): Promise<void>;
  editAgentRequest?(requestId: string, text: string): Promise<void>;
  withdrawAgentRequest?(requestId: string): Promise<void>;
}

export interface DshCollabGatewaySnapshot {
  gatewayHost: string;
  gatewayPort: number;
  exposeMode: "loopback" | "network";
  advertisedEndpoint: string;
}

export type DshCollabGatewayRuntimeSnapshot =
  | { status: "stopped" }
  | { status: "starting" }
  | { status: "running"; port: number };

export interface DshCollabOwnedRoom {
  roomId: string;
  hostSessionId: string;
  title: string;
  sharing: boolean;
}

export type DshCollabSettingsSnapshot = DshCollabGatewaySnapshot & Partial<DshCollabSecuritySettings> & {
  appliedGateway?: DshCollabGatewaySnapshot;
  writable?: boolean;
};

export interface DshCollabSettingsPort {
  getSnapshot(): DshCollabSettingsSnapshot;
  getRoomSnapshot?(): Pick<DshCollabClientSnapshot, "roomId" | "gatewayEndpoint" | "memberId" | "roomTitle" | "hostDisplayName" | "role" | "connection">;
  subscribeRoom?(listener: () => void): () => void;
  subscribe?(listener: () => void): () => void;
  save(input: { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; advertisedEndpoint: string } & Partial<DshCollabSecuritySettings>): Promise<void>;
  bootstrap?(roomId?: string): Promise<void>;
  shareHostRoom?(input: { sessionId: string; title: string }): Promise<void>;
  stopSharing?(roomId: string): Promise<void>;
  join?(input: DshBrowserJoinInput, roomId?: string): Promise<void>;
  createInvite?(input: { inviteId?: string; expiresAt: number; gatewayEndpoint: string }, roomId?: string): Promise<{ invitation: string }>;
  listJoinedRooms?(): readonly ParticipantResumeState[];
  subscribeJoinedRooms?(listener: () => void): () => void;
  connectJoinedRoom?(ref: JoinedRoomRef): Promise<void>;
  disconnectJoinedRoom?(): void;
  forgetJoinedRoom?(ref: JoinedRoomRef): Promise<void>;
  configureGateway?(input: { gatewayHost: string; gatewayPort: number }): void;
  getGatewaySnapshot?(): DshCollabGatewayRuntimeSnapshot;
  subscribeGateway?(listener: () => void): () => void;
  refreshGateway?(): Promise<DshCollabGatewayRuntimeSnapshot>;
  startGateway?(): Promise<DshCollabGatewayRuntimeSnapshot>;
  stopGateway?(): Promise<DshCollabGatewayRuntimeSnapshot>;
  getOwnedRooms?(): readonly DshCollabOwnedRoom[];
  subscribeOwnedRooms?(listener: () => void): () => void;
  refreshOwnedRooms?(): Promise<readonly DshCollabOwnedRoom[]>;
  getWorkspaceSharing?(roomId: string): Promise<WorkspaceSharingState>;
  setWorkspaceSharing?(roomId: string, enabled: boolean): Promise<WorkspaceSharingState>;
  requestWorkspaceSnapshot?(roomId: string): Promise<WorkspaceSnapshotPackage>;
  createReviewPoint?(roomId: string, input: ReviewPointCreateInput): Promise<ReviewPoint>;
  listReviewPoints?(roomId: string, after?: string, limit?: number): Promise<ReviewPointPage>;
  refreshReviewPoints?(roomId: string): Promise<string>;
  loadReviewPointDiff?(roomId: string, reviewPointId: string, fileIndex: number): Promise<ReviewPointDiff>;
  createReviewFinding?(roomId: string, reviewPointId: string, input: ReviewFindingCreateInput): Promise<ReviewFinding>;
  listReviewFindings?(roomId: string, reviewPointId: string, after?: string, limit?: number): Promise<ReviewFindingPage>;
  setReviewers?(roomId: string, reviewPointId: string, reviewerIds: string[]): Promise<ReviewPoint>;
  setReviewLifecycle?(roomId: string, reviewPointId: string, lifecycle: ReviewLifecycle): Promise<ReviewPoint>;
  setReviewFindingState?(roomId: string, reviewPointId: string, findingId: string, state: "accepted" | "dismissed"): Promise<ReviewFinding>;
  publishReviewPublication?(roomId: string, reviewPointId: string, input: ReviewPublicationCreateInput): Promise<ReviewPublication>;
  listReviewPublications?(roomId: string, reviewPointId: string): Promise<ReviewPublicationPage>;
  acceptReviewPublication?(roomId: string, reviewPointId: string, publicationId: string): Promise<AcceptedReviewPublication>;
  inspectRepository?(roomId: string): Promise<RepositoryInspection>;
  inspectRepositoryDiff?(roomId: string, path: string, layer: "staged" | "unstaged"): Promise<RepositoryDiff>;
  startLocalExplain?(input: StartExplainTaskInput): Promise<LocalSideTaskSnapshot>;
  getLocalSideTask?(roomId: string): Promise<LocalSideTaskSnapshot | undefined>;
  cancelLocalSideTask?(roomId: string, taskId: string): Promise<LocalSideTaskSnapshot>;
  startLocalReview?(input: StartReviewTaskInput): Promise<LocalSideTaskSnapshot>;
  publishLocalReview?(roomId: string, taskId: string, findingIndexes: number[]): Promise<LocalSideTaskSnapshot>;
  getLocalSnapshotAccess?(roomId: string): LocalSnapshotAccess;
}

interface DshClientConnectionRpc {
  call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>;
}

export interface DshClientSlots {
  inject(name: string, register: () => unknown): unknown;
  register(options: Record<string, unknown>, component: (props: Record<string, unknown>) => ReactNode): () => void;
}

export interface DshCollabClientContext {
  slots: DshClientSlots;
  locale?: DshCollabLocaleService;
  get?<T = unknown>(name: string): T;
  provide?<T = unknown>(name: string, value: T): unknown;
  effect?(callback: () => void | (() => void), label?: string): unknown;
  inject?(services: string[], callback: (context: DshCollabClientContext) => void): unknown;
}

/** DSH client runner service required by this browser contribution. */
export const inject = ["slots", "settingsScope", "connection", "locale"];

interface DshCollabLocaleService {
  register(namespace: string, dictionaries: { zh: typeof zh; en: typeof en }): () => void;
  bind(namespace: string): CollabTranslate;
}

interface DshSettingsScope<T> {
  getSnapshot(): { status: "loading" | "ready" | "unavailable"; value?: T; writable: boolean };
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<void>;
  unset(field: string): Promise<void>;
}

interface DshSettingsScopeBinder {
  bind<T>(spec: { namespace: string; decode?: (value: unknown) => T | undefined }): DshSettingsScope<T>;
}

interface PersistedCollabSettings {
  gateway: DshCollabGatewaySnapshot;
  appliedGateway?: DshCollabGatewaySnapshot;
  security?: DshCollabSecuritySettings;
}

function decodeGateway(value: unknown): PersistedCollabSettings["gateway"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if ((candidate.gatewayHost !== "127.0.0.1" && candidate.gatewayHost !== "0.0.0.0")
    || !Number.isSafeInteger(candidate.gatewayPort) || (candidate.gatewayPort as number) < 1 || (candidate.gatewayPort as number) > 65535
    || (candidate.exposeMode !== "loopback" && candidate.exposeMode !== "network")) return undefined;
  const advertisedEndpoint = typeof candidate.advertisedEndpoint === "string" ? candidate.advertisedEndpoint : "";
  return { ...candidate as Omit<PersistedCollabSettings["gateway"], "advertisedEndpoint">, advertisedEndpoint };
}

function decodeParticipant(value: unknown): ParticipantResumeState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if ([candidate.gatewayEndpoint, candidate.roomId, candidate.memberId, candidate.credential].some((field) => typeof field !== "string" || field.trim() === "")) return undefined;
  try { normalizeGatewayEndpoint(candidate.gatewayEndpoint as string); } catch { return undefined; }
  return {
    gatewayEndpoint: candidate.gatewayEndpoint as string,
    roomId: candidate.roomId as string,
    memberId: candidate.memberId as string,
    credential: candidate.credential as string,
    ...(typeof candidate.roomTitle === "string" && candidate.roomTitle.trim() !== "" ? { roomTitle: candidate.roomTitle } : {}),
    ...(typeof candidate.hostDisplayName === "string" && candidate.hostDisplayName.trim() !== "" ? { hostDisplayName: candidate.hostDisplayName } : {}),
  };
}

function decodePersistedSettings(value: unknown): PersistedCollabSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const gateway = decodeGateway((value as { gateway?: unknown }).gateway);
  if (!gateway) return undefined;
  const appliedGateway = decodeGateway((value as { appliedGateway?: unknown }).appliedGateway);
  const securityValue = (value as { security?: unknown }).security;
  const security = securityValue && typeof securityValue === "object" && !Array.isArray(securityValue)
    ? securityValue as Partial<DshCollabSecuritySettings>
    : {};
  const normalized: DshCollabSecuritySettings = {
    tokenTtlMs: security.tokenTtlMs === undefined ? defaultCollabSettings.tokenTtlMs : security.tokenTtlMs,
    approvalPolicy: security.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
    maxMembers: security.maxMembers ?? defaultCollabSettings.maxMembers,
    maxMessageBytes: security.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
    maxQueue: migrateLegacyMaxQueue(security.maxQueue) ?? defaultCollabSettings.maxQueue,
  };
  return { gateway, ...(appliedGateway ? { appliedGateway } : {}), security: normalized };
}

export function decodeDshParticipantSettings(value: unknown): DshCollabParticipantSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const decodedRooms = Array.isArray((value as { joinedRooms?: unknown }).joinedRooms)
    ? (value as { joinedRooms: unknown[] }).joinedRooms.map(decodeParticipant).filter((room): room is ParticipantResumeState => room !== undefined)
    : [];
  const resume = decodeParticipant((value as { resume?: unknown }).resume);
  if (resume) decodedRooms.push(resume);
  const joinedRooms = [...new Map(decodedRooms.map((room) => [room.roomId, room])).values()];
  return joinedRooms.length > 0 ? { joinedRooms } : {};
}

export function createDshParticipantPersistence(scope: DshSettingsScope<DshCollabParticipantSettings>): ParticipantPersistence {
  const list = (): ParticipantResumeState[] => [...(scope.getSnapshot().value?.joinedRooms ?? [])];
  const sameRoom = (room: JoinedRoomRef, other: JoinedRoomRef): boolean => room.gatewayEndpoint === other.gatewayEndpoint && room.roomId === other.roomId;
  return {
    load: (ref) => ref ? list().find((room) => sameRoom(room, ref)) : list()[0],
    list,
    subscribe: (listener) => scope.subscribe(listener),
    save: async (state) => {
      const current = scope.getSnapshot();
      if (current.status !== "ready" || !current.writable) throw new Error("DSH settings are not writable");
      const rooms = list().filter((room) => room.roomId !== state.roomId);
      rooms.push(state);
      if (current.value?.resume) await scope.unset("resume");
      await scope.set("joinedRooms", rooms);
      const saved = list().find((room) => sameRoom(room, state));
      if (!saved || saved.credential !== state.credential || saved.memberId !== state.memberId) {
        throw new Error("Participant resume credential was not persisted by DSH");
      }
    },
    remove: async (ref) => {
      const current = scope.getSnapshot();
      if (current.status !== "ready" || !current.writable) throw new Error("DSH settings are not writable");
      const rooms = list().filter((room) => !sameRoom(room, ref));
      if (current.value?.resume) await scope.unset("resume");
      if (rooms.length > 0) await scope.set("joinedRooms", rooms); else await scope.unset("joinedRooms");
    },
  };
}

function decodeGatewayRuntimeResult(result: unknown): DshCollabGatewayRuntimeSnapshot {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid Host Gateway response");
  const envelope = result as { ok?: unknown; value?: unknown; error?: { message?: unknown } };
  if (envelope.ok !== true) throw new Error(typeof envelope.error?.message === "string" ? envelope.error.message : "Host Gateway control failed");
  if (!envelope.value || typeof envelope.value !== "object" || Array.isArray(envelope.value)) throw new Error("Invalid Host Gateway state");
  const value = envelope.value as { status?: unknown; port?: unknown };
  if (value.status === "stopped" || value.status === "starting") return { status: value.status };
  if (value.status === "running" && Number.isSafeInteger(value.port) && (value.port as number) >= 1 && (value.port as number) <= 65535) {
    return { status: "running", port: value.port as number };
  }
  throw new Error("Invalid Host Gateway state");
}

function decodeOwnedRoomsResult(result: unknown): DshCollabOwnedRoom[] {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid Owned rooms response");
  const envelope = result as { ok?: unknown; value?: { rooms?: unknown }; error?: { message?: unknown } };
  if (envelope.ok !== true) throw new Error(typeof envelope.error?.message === "string" ? envelope.error.message : "Unable to list Owned rooms");
  if (!Array.isArray(envelope.value?.rooms)) throw new Error("Invalid Owned rooms response");
  return envelope.value.rooms.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Owned room");
    const room = value as Record<string, unknown>;
    if ([room.roomId, room.hostSessionId, room.title].some((field) => typeof field !== "string" || field.trim() === "") || typeof room.sharing !== "boolean") throw new Error("Invalid Owned room");
    return { roomId: room.roomId as string, hostSessionId: room.hostSessionId as string, title: room.title as string, sharing: room.sharing };
  });
}

function decodeRepositoryInspectionResult(result: unknown): RepositoryInspection {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid repository inspection response");
  const envelope = result as { ok?: unknown; value?: { inspection?: unknown }; error?: { message?: unknown } };
  if (envelope.ok !== true) throw new Error(typeof envelope.error?.message === "string" ? envelope.error.message : "Unable to inspect repository");
  const inspection = envelope.value?.inspection;
  if (!inspection || typeof inspection !== "object" || Array.isArray(inspection)) throw new Error("Invalid repository inspection response");
  if ((inspection as { kind?: unknown }).kind === "not-git") return { kind: "not-git" };
  const repository = inspection as Partial<Extract<RepositoryInspection, { kind: "repository" }>>;
  if (repository.kind !== "repository" || typeof repository.root !== "string" || !Array.isArray(repository.files)
    || !repository.summary || !Number.isSafeInteger(repository.summary.stagedFiles) || !Number.isSafeInteger(repository.summary.unstagedFiles)
    || !Number.isSafeInteger(repository.summary.additions) || !Number.isSafeInteger(repository.summary.deletions) || !Number.isSafeInteger(repository.summary.binaryFiles)) {
    throw new Error("Invalid repository inspection response");
  }
  return repository as Extract<RepositoryInspection, { kind: "repository" }>;
}

function decodeRepositoryDiffResult(result: unknown): RepositoryDiff {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid repository diff response");
  const envelope = result as { ok?: unknown; value?: { diff?: unknown }; error?: { message?: unknown } };
  if (envelope.ok !== true) throw new Error(typeof envelope.error?.message === "string" ? envelope.error.message : "Unable to load repository diff");
  const diff = envelope.value?.diff;
  if (!diff || typeof diff !== "object" || Array.isArray(diff)) throw new Error("Invalid repository diff response");
  const value = diff as Record<string, unknown>;
  if (typeof value.path !== "string" || (value.layer !== "staged" && value.layer !== "unstaged") || typeof value.patch !== "string") {
    throw new Error("Invalid repository diff response");
  }
  return { path: value.path, layer: value.layer, patch: value.patch };
}

function safeSnapshotPath(path: string): boolean {
  const segments = path.split("/");
  return path !== "" && !path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path) && !path.includes("\\")
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function decodeLocalSideTaskResult(
  result: unknown,
  required: boolean,
  expected: { roomId: string; taskId?: string; requestedBy?: string },
): LocalSideTaskSnapshot | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid local SideTask response");
  const envelope = result as { ok?: unknown; value?: { sideTask?: unknown }; error?: { message?: unknown } };
  if (envelope.ok !== true) throw new Error(typeof envelope.error?.message === "string" ? envelope.error.message : "Local SideTask request failed");
  const value = envelope.value?.sideTask;
  if (value === null && !required) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local SideTask response");
  const snapshot = value as Partial<LocalSideTaskSnapshot>;
  const task = snapshot.task;
  const revision = snapshot.revision;
  if (["remote", "gatewayEndpoint", "roomToken", "credential", "source"].some((field) => field in (value as object))
    || !task || typeof task !== "object" || ["remote", "gatewayEndpoint", "roomToken", "credential", "source"].some((field) => field in task)
    || typeof task.taskId !== "string" || task.taskId.trim() === ""
    || typeof task.roomId !== "string" || task.roomId !== expected.roomId || task.roomId.trim() === ""
    || (expected.taskId !== undefined && task.taskId !== expected.taskId)
    || (task.type !== "explain" && task.type !== "review") || task.executor !== "requester-local"
    || typeof task.localPrompt !== "string" || task.localPrompt.trim() === "" || typeof task.requestedBy !== "string" || task.requestedBy.trim() === ""
    || (expected.requestedBy !== undefined && task.requestedBy !== expected.requestedBy)
    || !Number.isSafeInteger(task.createdAt) || task.createdAt < 0
    || !task.context || ["remote", "gatewayEndpoint", "roomToken", "credential", "source"].some((field) => field in task.context)
    || !Number.isSafeInteger(task.context.roomEventSeq) || task.context.roomEventSeq < 0
    || !Array.isArray(task.context.selectedRoomEventIds) || (task.type === "explain" && task.context.selectedRoomEventIds.length < 1)
    || task.context.selectedRoomEventIds.some((eventId) => typeof eventId !== "string" || eventId.trim() === "")
    || !task.state || !["queued", "running", "completed", "failed", "cancelled"].includes(task.state.status)
    || (task.state.status === "failed" && (typeof task.state.error !== "string" || task.state.error.trim() === ""))
    || (task.type === "review" && (typeof task.context.reviewPointId !== "string" || !/^[a-f0-9]{64}$/.test(task.context.reviewPointId)
      || typeof task.context.workspaceSnapshotId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(task.context.workspaceSnapshotId)))
    || (task.type === "explain" && task.context.workspaceSnapshotId !== undefined
      && (typeof task.context.workspaceSnapshotId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(task.context.workspaceSnapshotId)))
    || !task.publication || (task.publication.status !== "private" && (task.publication.status !== "published"
      || typeof task.publication.publicationId !== "string" || !/^[a-f0-9]{64}$/.test(task.publication.publicationId)
      || !Number.isSafeInteger(task.publication.publishedAt) || task.publication.publishedAt < 0))
    || (task.publication.status === "published" && (task.type !== "review" || task.state.status !== "completed" || !Array.isArray(snapshot.findings) || snapshot.findings.length < 1))
    || typeof snapshot.output !== "string" || !Number.isSafeInteger(revision) || typeof revision !== "number" || revision < 1) {
    throw new Error("Invalid local SideTask response");
  }
  if (task.type === "review" && task.state.status === "completed" && !Array.isArray(snapshot.findings)) throw new Error("Invalid local SideTask response");
  if (snapshot.findings !== undefined) {
    if (task.type !== "review" || !Array.isArray(snapshot.findings) || snapshot.findings.length > 100) throw new Error("Invalid local SideTask response");
    for (const finding of snapshot.findings) {
      if (!finding || !["critical", "high", "medium", "low", "note"].includes(finding.severity)
        || typeof finding.body !== "string" || finding.body.trim() === "" || finding.body.length > 4_000
        || !finding.location || !["general", "file", "line"].includes(finding.location.kind)
        || (finding.location.kind !== "general" && (typeof finding.location.path !== "string" || !safeSnapshotPath(finding.location.path)))
        || (finding.location.kind === "line" && (!Number.isSafeInteger(finding.location.line) || finding.location.line < 1))) {
        throw new Error("Invalid local SideTask response");
      }
    }
  }
  return value as LocalSideTaskSnapshot;
}

export function createDshGatewayControlPort(base: DshCollabSettingsPort, rpc: DshClientConnectionRpc): DshCollabSettingsPort {
  let gateway: DshCollabGatewayRuntimeSnapshot = { status: "stopped" };
  let ownedRooms: DshCollabOwnedRoom[] = [];
  const listeners = new Set<() => void>();
  const roomListeners = new Set<() => void>();
  const publish = (next: DshCollabGatewayRuntimeSnapshot): DshCollabGatewayRuntimeSnapshot => {
    gateway = next;
    for (const listener of listeners) listener();
    return next;
  };
  const call = async (endpoint: string): Promise<DshCollabGatewayRuntimeSnapshot> => {
    return publish(decodeGatewayRuntimeResult(await rpc.call("/dsh-collab", endpoint, {})));
  };
  const refreshOwnedRooms = async (): Promise<readonly DshCollabOwnedRoom[]> => {
    ownedRooms = decodeOwnedRoomsResult(await rpc.call("/dsh-collab", "rooms/list", {}));
    for (const listener of roomListeners) listener();
    return ownedRooms;
  };
  const transientSnapshotAccess = (roomId: string): LocalSnapshotAccess | undefined => {
    const room = base.getRoomSnapshot?.();
    if (room?.role !== "participant" || room.roomId !== roomId || room.connection === "offline") return undefined;
    if (!base.getLocalSnapshotAccess) throw new Error("Participant snapshot access is unavailable");
    return base.getLocalSnapshotAccess(roomId);
  };
  return Object.assign(base, {
    getGatewaySnapshot: () => gateway,
    subscribeGateway: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshGateway: () => call("gateway/status"),
    startGateway: async () => { publish({ status: "starting" }); const result = await call("gateway/start"); await refreshOwnedRooms(); return result; },
    stopGateway: async () => { const result = await call("gateway/stop"); await refreshOwnedRooms(); return result; },
    getOwnedRooms: () => ownedRooms,
    subscribeOwnedRooms: (listener: () => void) => { roomListeners.add(listener); return () => { roomListeners.delete(listener); }; },
    refreshOwnedRooms,
    inspectRepository: async (roomId: string) => decodeRepositoryInspectionResult(await rpc.call("/dsh-collab", "repository/inspect", { roomId })),
    inspectRepositoryDiff: async (roomId: string, path: string, layer: "staged" | "unstaged") => decodeRepositoryDiffResult(await rpc.call("/dsh-collab", "repository/diff", { roomId, path, layer })),
    startLocalExplain: async (input: StartExplainTaskInput) => {
      const remote = input.includeWorkspace ? transientSnapshotAccess(input.roomId) : undefined;
      return decodeLocalSideTaskResult(
        await rpc.call("/dsh-collab", "sidecar/start", { ...input, ...(remote ? { remote } : {}) }),
        true,
        { roomId: input.roomId, requestedBy: input.requestedBy },
      )!;
    },
    startLocalReview: async (input: StartReviewTaskInput) => {
      const remote = transientSnapshotAccess(input.roomId);
      return decodeLocalSideTaskResult(
        await rpc.call("/dsh-collab", "sidecar/start-review", { ...input, ...(remote ? { remote } : {}) }),
        true,
        { roomId: input.roomId, requestedBy: input.requestedBy },
      )!;
    },
    publishLocalReview: async (roomId: string, taskId: string, findingIndexes: number[]) => {
      const room = base.getRoomSnapshot?.();
      if (!room || room.roomId !== roomId || room.connection === "offline" || !room.memberId) throw new Error("Connect to this collaboration room before publishing");
      const sideTask = decodeLocalSideTaskResult(
        await rpc.call("/dsh-collab", "sidecar/get", { roomId }), true, { roomId, taskId, requestedBy: room.memberId },
      )!;
      if (sideTask.task.type !== "review" || sideTask.task.state.status !== "completed" || sideTask.task.publication.status !== "private"
        || !sideTask.findings || !sideTask.task.context.reviewPointId || !sideTask.task.context.workspaceSnapshotId) {
        throw new Error("Only a completed private local Review can be published");
      }
      if (!Array.isArray(findingIndexes) || findingIndexes.length < 1 || findingIndexes.length > sideTask.findings.length
        || new Set(findingIndexes).size !== findingIndexes.length
        || findingIndexes.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= sideTask.findings!.length)) {
        throw new Error("Select at least one valid local Review finding");
      }
      if (!base.publishReviewPublication) throw new Error("Review publication is unavailable");
      const existing = base.listReviewPublications
        ? (await base.listReviewPublications(roomId, sideTask.task.context.reviewPointId)).publications
          .find((publication) => publication.taskId === taskId && publication.publishedBy === room.memberId)
        : undefined;
      if (existing && existing.workspaceSnapshotId !== sideTask.task.context.workspaceSnapshotId) {
        throw new Error("Local Review conflicts with its existing publication");
      }
      const publication = existing ?? await base.publishReviewPublication(roomId, sideTask.task.context.reviewPointId, {
        taskId,
        workspaceSnapshotId: sideTask.task.context.workspaceSnapshotId,
        summary: sideTask.output,
        findings: [...findingIndexes].sort((left, right) => left - right).map((index) => sideTask.findings![index]!),
      });
      return decodeLocalSideTaskResult(await rpc.call("/dsh-collab", "sidecar/mark-published", {
        roomId,
        taskId,
        publicationId: publication.publicationId,
        publishedAt: publication.createdAt,
      }), true, { roomId, taskId, requestedBy: room.memberId })!;
    },
    getLocalSideTask: async (roomId: string) => decodeLocalSideTaskResult(
      await rpc.call("/dsh-collab", "sidecar/get", { roomId }), false, { roomId },
    ),
    cancelLocalSideTask: async (roomId: string, taskId: string) => decodeLocalSideTaskResult(
      await rpc.call("/dsh-collab", "sidecar/cancel", { roomId, taskId }), true, { roomId, taskId },
    )!,
  });
}

export function createDshSettingsPort(scope: DshSettingsScope<PersistedCollabSettings>, actions: DshCollabSettingsPort): DshCollabSettingsPort {
  const syncGateway = (): void => {
    const persisted = scope.getSnapshot().value;
    const gateway = persisted?.appliedGateway ?? persisted?.gateway;
    if (gateway) actions.configureGateway?.(gateway);
  };
  syncGateway();
  return {
    getSnapshot: () => {
      syncGateway();
      const scopeSnapshot = scope.getSnapshot();
      const persisted = scopeSnapshot.value;
      if (persisted) return {
        ...persisted.gateway,
        ...(persisted.appliedGateway ? { appliedGateway: persisted.appliedGateway } : {}),
        writable: scopeSnapshot.writable,
        tokenTtlMs: persisted.security?.tokenTtlMs === undefined ? defaultCollabSettings.tokenTtlMs : persisted.security.tokenTtlMs,
        approvalPolicy: persisted.security?.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
        maxMembers: persisted.security?.maxMembers ?? defaultCollabSettings.maxMembers,
        maxMessageBytes: persisted.security?.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
        maxQueue: migrateLegacyMaxQueue(persisted.security?.maxQueue) ?? defaultCollabSettings.maxQueue,
      };
      const fallback = actions.getSnapshot();
      return {
        ...fallback,
        writable: scopeSnapshot.writable,
        tokenTtlMs: fallback.tokenTtlMs === undefined ? defaultCollabSettings.tokenTtlMs : fallback.tokenTtlMs,
        approvalPolicy: fallback.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
        maxMembers: fallback.maxMembers ?? defaultCollabSettings.maxMembers,
        maxMessageBytes: fallback.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
        maxQueue: migrateLegacyMaxQueue(fallback.maxQueue) ?? defaultCollabSettings.maxQueue,
      };
    },
    subscribe: (listener) => scope.subscribe(() => { syncGateway(); listener(); }),
    async save(input) {
      const current = scope.getSnapshot();
      if (current.status !== "ready" || !current.writable) throw new Error("DSH settings are not writable");
      if (!Number.isSafeInteger(input.gatewayPort) || input.gatewayPort < 1 || input.gatewayPort > 65535) throw new Error("gatewayPort must be between 1 and 65535");
      if (input.exposeMode === "loopback" && input.gatewayHost !== "127.0.0.1") throw new Error("loopback mode requires 127.0.0.1");
      if (input.exposeMode === "network" && input.gatewayHost !== "0.0.0.0") throw new Error("network mode requires 0.0.0.0");
      const advertisedEndpoint = input.exposeMode === "network" ? "" : input.advertisedEndpoint === "" ? "" : normalizeAdvertisedGatewayEndpoint(input.advertisedEndpoint, input.exposeMode);
      const security = {
        tokenTtlMs: input.tokenTtlMs === undefined ? defaultCollabSettings.tokenTtlMs : input.tokenTtlMs,
        approvalPolicy: input.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
        maxMembers: input.maxMembers ?? defaultCollabSettings.maxMembers,
        maxMessageBytes: input.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
        maxQueue: input.maxQueue ?? defaultCollabSettings.maxQueue,
      };
      if (security.tokenTtlMs !== null && (!Number.isSafeInteger(security.tokenTtlMs) || security.tokenTtlMs < 1)) throw new Error("tokenTtlMs must be positive or null");
      if (!Number.isSafeInteger(security.maxMembers) || security.maxMembers < 1) throw new Error("maxMembers must be positive");
      if (!Number.isSafeInteger(security.maxMessageBytes) || security.maxMessageBytes < 1) throw new Error("maxMessageBytes must be positive");
      if (!Number.isSafeInteger(security.maxQueue) || security.maxQueue < 0) throw new Error("maxQueue must be non-negative");
      await scope.set("gateway", { gatewayHost: input.gatewayHost, gatewayPort: input.gatewayPort, exposeMode: input.exposeMode, advertisedEndpoint });
      await scope.set("security", security);
      const committed = scope.getSnapshot().value;
      if (!committed
        || committed.gateway.gatewayHost !== input.gatewayHost
        || committed.gateway.gatewayPort !== input.gatewayPort
        || committed.gateway.exposeMode !== input.exposeMode
        || committed.gateway.advertisedEndpoint !== advertisedEndpoint
        || committed.security?.tokenTtlMs !== security.tokenTtlMs
        || committed.security.approvalPolicy !== security.approvalPolicy
        || committed.security.maxMembers !== security.maxMembers
        || committed.security.maxMessageBytes !== security.maxMessageBytes
        || committed.security.maxQueue !== security.maxQueue) {
        throw new Error("Collaboration settings were not persisted by DSH");
      }
      syncGateway();
    },
    bootstrap: actions.bootstrap?.bind(actions),
    shareHostRoom: actions.shareHostRoom ? async (input) => { await actions.shareHostRoom?.(input); await actions.refreshOwnedRooms?.(); } : undefined,
    stopSharing: actions.stopSharing ? async (roomId) => { await actions.stopSharing?.(roomId); await actions.refreshOwnedRooms?.(); } : undefined,
    join: actions.join?.bind(actions),
    createInvite: actions.createInvite?.bind(actions),
    listJoinedRooms: actions.listJoinedRooms?.bind(actions),
    subscribeJoinedRooms: actions.subscribeJoinedRooms?.bind(actions),
    connectJoinedRoom: actions.connectJoinedRoom?.bind(actions),
    disconnectJoinedRoom: actions.disconnectJoinedRoom?.bind(actions),
    forgetJoinedRoom: actions.forgetJoinedRoom?.bind(actions),
    configureGateway: actions.configureGateway?.bind(actions),
    getRoomSnapshot: actions.getRoomSnapshot?.bind(actions),
    subscribeRoom: actions.subscribeRoom?.bind(actions),
    getGatewaySnapshot: actions.getGatewaySnapshot?.bind(actions),
    subscribeGateway: actions.subscribeGateway?.bind(actions),
    refreshGateway: actions.refreshGateway?.bind(actions),
    startGateway: actions.startGateway?.bind(actions),
    stopGateway: actions.stopGateway?.bind(actions),
    getOwnedRooms: actions.getOwnedRooms?.bind(actions),
    subscribeOwnedRooms: actions.subscribeOwnedRooms?.bind(actions),
    refreshOwnedRooms: actions.refreshOwnedRooms?.bind(actions),
    getWorkspaceSharing: actions.getWorkspaceSharing?.bind(actions),
    setWorkspaceSharing: actions.setWorkspaceSharing?.bind(actions),
    requestWorkspaceSnapshot: actions.requestWorkspaceSnapshot?.bind(actions),
    createReviewPoint: actions.createReviewPoint?.bind(actions),
    listReviewPoints: actions.listReviewPoints?.bind(actions),
    refreshReviewPoints: actions.refreshReviewPoints?.bind(actions),
    loadReviewPointDiff: actions.loadReviewPointDiff?.bind(actions),
    createReviewFinding: actions.createReviewFinding?.bind(actions),
    listReviewFindings: actions.listReviewFindings?.bind(actions),
    setReviewers: actions.setReviewers?.bind(actions),
    setReviewLifecycle: actions.setReviewLifecycle?.bind(actions),
    setReviewFindingState: actions.setReviewFindingState?.bind(actions),
    publishReviewPublication: actions.publishReviewPublication?.bind(actions),
    listReviewPublications: actions.listReviewPublications?.bind(actions),
    acceptReviewPublication: actions.acceptReviewPublication?.bind(actions),
    inspectRepository: actions.inspectRepository?.bind(actions),
    inspectRepositoryDiff: actions.inspectRepositoryDiff?.bind(actions),
    startLocalExplain: actions.startLocalExplain?.bind(actions),
    startLocalReview: actions.startLocalReview?.bind(actions),
    publishLocalReview: actions.publishLocalReview?.bind(actions),
    getLocalSideTask: actions.getLocalSideTask?.bind(actions),
    cancelLocalSideTask: actions.cancelLocalSideTask?.bind(actions),
  };
}

function snapshotOf(port: DshCollabClientPort | undefined, fallback: DshCollabClientSnapshot): DshCollabClientSnapshot {
  return port?.getSnapshot() ?? fallback;
}

function usePortSnapshot(port: DshCollabClientPort | undefined, fallback: DshCollabClientSnapshot): DshCollabClientSnapshot {
  const [snapshot, setSnapshot] = useState(() => snapshotOf(port, fallback));
  useEffect(() => {
    if (!port) return;
    const update = (): void => setSnapshot(port.getSnapshot());
    update();
    return port.subscribe(update);
  }, [port]);
  return snapshot;
}

const fallbackSnapshot: DshCollabClientSnapshot = {
  roomId: "",
  roomTitle: "No collaboration room",
  hostDisplayName: "",
  role: "participant",
  connection: "offline",
  onlineCount: 0,
  canSteer: false,
};

function agentStatusLabel(status: string, t: CollabTranslate): string {
  const key = ({
    accepted: "agent.accepted",
    queued: "agent.queued",
    running: "agent.running",
    completed: "agent.completed",
    failed: "agent.failed",
    cancelled: "agent.cancelled",
    output: "agent.output",
    updated: "agent.updated",
  } as Partial<Record<string, CollabLocaleKey>>)[status];
  return key ? t(key) : status;
}

function connectionLabel(connection: DshCollabClientSnapshot["connection"], t: CollabTranslate): string {
  const key: Record<DshCollabClientSnapshot["connection"], CollabLocaleKey> = {
    connecting: "connection.connecting",
    online: "connection.online",
    offline: "connection.offline",
  };
  return t(key[connection]);
}

function actionErrorText(cause: unknown, t: CollabTranslate): string {
  if (cause instanceof GatewayRequestError) {
    if (cause.code === "ROOM_INACTIVE") return t("room.hostStoppedSharing");
    if (cause.code === "RESOURCE_LIMIT") return t("room.resourceLimited");
  }
  if (cause instanceof GatewayConnectionError) return t("room.hostUnreachable");
  return cause instanceof Error ? cause.message : t("rooms.actionError");
}

function timelineLabel(item: TimelineItem, t: CollabTranslate): string {
  if (item.text) return item.text;
  if (item.kind === "agent-request") return t("room.agentRequest", { status: agentStatusLabel(item.status ?? "updated", t) });
  if (item.kind === "agent") return t("room.hostAgent");
  return t("room.message");
}

function DshCollabTimeline(props: {
  items: readonly TimelineItem[];
  members: readonly { memberId: string; displayName: string }[];
  referencedEventIds: ReadonlySet<string>;
  onContextMenu: (item: TimelineItem, event: ReactMouseEvent<HTMLElement>) => void;
  t: CollabTranslate;
}): ReactNode {
  if (props.items.length === 0) return createElement("p", { className: roomCss.empty }, props.t("room.noMessages"));
  return createElement("div", { className: roomCss.timeline, "data-collab-timeline": true, "aria-live": "polite" },
    props.items.map((item) => {
      const status = item.status ?? (item.kind === "agent" && item.state === "failed" ? item.state : undefined);
      const author = item.kind === "agent"
        ? props.t("room.hostAgent")
        : props.members.find((member) => member.memberId === item.authorMemberId)?.displayName ?? item.authorMemberId;
      return createElement("article", {
        key: item.eventId,
        className: roomCss.message,
        "data-kind": item.kind,
        "data-status": item.status,
        "data-state": item.state,
        "data-streaming": item.streaming ? "true" : undefined,
        "data-context-event-id": item.contextEventId,
        "data-referenced": item.contextEventId && props.referencedEventIds.has(item.contextEventId) ? "true" : undefined,
        onContextMenu: item.contextEventId && item.text ? (event: ReactMouseEvent<HTMLElement>) => { props.onContextMenu(item, event); } : undefined,
      },
      createElement("small", { className: roomCss.author }, author),
      createElement("div", { className: roomCss.text }, item.kind === "agent"
        ? createElement(MarkdownText, { text: timelineLabel(item, props.t), streaming: item.streaming === true })
        : createElement(MessageText, { text: timelineLabel(item, props.t) })),
      status ? createElement("span", { className: roomCss.status }, agentStatusLabel(status, props.t)) : null);
    }),
  );
}

function DshAgentQueueTable(props: {
  items: readonly AgentQueueItem[];
  members: readonly { memberId: string; displayName: string }[];
  memberId?: string;
  role: DshCollabClientSnapshot["role"];
  port?: DshCollabClientPort;
  t: CollabTranslate;
}): ReactNode {
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [busyId, setBusyId] = useState<string>();
  const [error, setError] = useState<string>();
  const nameFor = (memberId: string): string => props.members.find((member) => member.memberId === memberId)?.displayName ?? memberId;
  const beginEdit = (item: AgentQueueItem): void => { setEditingId(item.requestId); setDraft(item.text); setError(undefined); };
  const saveEdit = async (requestId: string): Promise<void> => {
    if (!props.port?.editAgentRequest || draft.trim() === "") return;
    setBusyId(requestId);
    setError(undefined);
    try {
      await props.port.editAgentRequest(requestId, draft.trim());
      setEditingId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : props.t("queue.editError"));
    } finally {
      setBusyId(undefined);
    }
  };
  const withdraw = async (requestId: string): Promise<void> => {
    if (!props.port?.withdrawAgentRequest) return;
    setBusyId(requestId);
    setError(undefined);
    try {
      await props.port.withdrawAgentRequest(requestId);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : props.t("queue.withdrawError"));
    } finally {
      setBusyId(undefined);
    }
  };
  return createElement("section", { className: roomCss.queue, "data-collab-agent-queue": true, "aria-labelledby": "collab-agent-queue-title" },
    createElement("div", { className: roomCss.queueHeader }, createElement("h3", { id: "collab-agent-queue-title" }, props.t("queue.title"))),
    props.items.length === 0
      ? createElement("p", { className: roomCss.queueEmpty }, props.t("queue.empty"))
      : createElement("div", { className: roomCss.queueScroller }, createElement("table", { className: roomCss.queueTable },
        createElement("thead", null, createElement("tr", null,
          createElement("th", { scope: "col" }, props.t("queue.position")),
          createElement("th", { scope: "col" }, props.t("queue.author")),
          createElement("th", { scope: "col" }, props.t("queue.message")),
          createElement("th", { scope: "col" }, props.t("queue.status")),
          createElement("th", { scope: "col" }, props.t("queue.priority")),
          createElement("th", { scope: "col" }, ""),
        )),
        createElement("tbody", null, props.items.map((item) => {
          const canManage = item.status === "queued" && (props.role === "host" || item.authorMemberId === props.memberId);
          const editing = editingId === item.requestId;
          return createElement("tr", { key: item.requestId, "data-request-id": item.requestId, "data-status": item.status },
            createElement("td", { className: roomCss.queuePosition }, String(item.position)),
            createElement("td", null, nameFor(item.authorMemberId)),
            createElement("td", { className: roomCss.queueMessage }, editing
              ? createElement("textarea", { className: roomCss.queueEditor, value: draft, rows: 2, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value) })
              : item.text),
            createElement("td", null, agentStatusLabel(item.status, props.t)),
            createElement("td", null, props.t(item.priority === "host" ? "queue.hostPriority" : "queue.participantPriority")),
            createElement("td", { className: roomCss.queueActions }, canManage && (editing
              ? [
                createElement("button", { key: "save", type: "button", className: roomCss.queueAction, disabled: busyId !== undefined || draft.trim() === "", onClick: () => { void saveEdit(item.requestId); } }, props.t("queue.save")),
                createElement("button", { key: "cancel", type: "button", className: roomCss.queueAction, disabled: busyId !== undefined, onClick: () => { setEditingId(undefined); setError(undefined); } }, props.t("queue.cancelEdit")),
              ]
              : [
                createElement("button", { key: "edit", type: "button", className: roomCss.queueAction, disabled: busyId !== undefined, "aria-label": props.t("queue.editAria"), onClick: () => { beginEdit(item); } }, props.t("queue.edit")),
                createElement("button", { key: "withdraw", type: "button", className: roomCss.queueAction, disabled: busyId !== undefined, "aria-label": props.t("queue.withdrawAria"), onClick: () => { void withdraw(item.requestId); } }, props.t("queue.withdraw")),
              ])),
          );
        })),
      )),
    error ? createElement("p", { className: roomCss.error, role: "alert" }, error) : null,
  );
}

/** Shared timeline and composer rendered inside the Collab room surface. */
export function DshCollabDock(props: { port?: DshCollabClientPort; fallback?: DshCollabClientSnapshot; showHeader?: boolean; t?: CollabTranslate }): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const fallback = props.fallback ?? fallbackSnapshot;
  const snapshot = usePortSnapshot(props.port, fallback);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const [contextRefs, setContextRefs] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{ item: TimelineItem; x: number; y: number }>();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const timeline = snapshot.timeline ?? [];
  const referencedItems = contextRefs.map((eventId) => timeline.find((item) => item.contextEventId === eventId)).filter((item): item is TimelineItem => item !== undefined);
  const agentBusy = (snapshot.agentQueue ?? []).some((item) => item.status === "running") || timeline.some((item) => item.kind === "agent" && item.streaming === true);
  const addContextRef = (item: TimelineItem): void => {
    const eventId = item.contextEventId;
    setContextMenu(undefined);
    if (!eventId || contextRefs.includes(eventId)) return;
    if (contextRefs.length >= MAX_CONTEXT_REFS) {
      setError(t("composer.quoteLimit", { count: MAX_CONTEXT_REFS }));
      return;
    }
    setError(undefined);
    setContextRefs([...contextRefs, eventId]);
    textareaRef.current?.focus();
  };
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!props.port || draft.trim() === "") return;
    try {
      setError(undefined);
      const text = draft.trim();
      const target = composerTargetForText(text);
      await props.port.send({ text, target, ...(target === "dsh" && contextRefs.length > 0 ? { contextRefs: [...contextRefs] } : {}) });
      setDraft("");
      setContextRefs([]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("composer.sendError"));
    }
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    const action = composerKeyAction({
      key: event.key,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.nativeEvent.keyCode,
      repeat: event.repeat,
    });
    if (action === "native" && !(event.key === "Enter" && event.shiftKey && composerTargetForGesture(draft, agentBusy, true) === "dsh-steer")) return;
    event.preventDefault();
    if (action === "submit" || (event.key === "Enter" && event.shiftKey && composerTargetForGesture(draft, agentBusy, true) === "dsh-steer")) event.currentTarget.form?.requestSubmit();
  };
  return createElement("section", { className: roomCss.dock, "data-collab-room-ui": true, "data-collab-mode": snapshot.role, "data-connection": snapshot.connection, "aria-label": t("room.aria") },
    props.showHeader === false ? null : createElement("div", { className: roomCss.header },
      createElement("strong", { className: roomCss.title }, snapshot.roomTitle),
      createElement("span", { className: roomCss.badge }, t(snapshot.role === "host" ? "role.owner" : "role.participant")),
      snapshot.hostDisplayName ? createElement("span", { className: roomCss.host }, t("room.hostedBy", { name: snapshot.hostDisplayName })) : null,
      createElement("span", { className: roomCss.connection, role: "status" }, t("connection.summary", { connection: connectionLabel(snapshot.connection, t), count: snapshot.onlineCount })),
    ),
    createElement(DshCollabTimeline, {
      items: timeline,
      members: snapshot.members ?? [],
      referencedEventIds: new Set(contextRefs),
      onContextMenu: (item: TimelineItem, event: ReactMouseEvent<HTMLElement>) => {
        event.preventDefault();
        setContextMenu({ item, x: event.clientX, y: event.clientY });
      },
      t,
    }),
    contextMenu ? createElement("div", { className: roomCss.contextMenu, role: "menu", style: { left: contextMenu.x, top: contextMenu.y } },
      createElement("button", { type: "button", role: "menuitem", onClick: () => { addContextRef(contextMenu.item); } }, t("composer.quote")),
    ) : null,
    createElement(DshAgentQueueTable, { items: snapshot.agentQueue ?? [], members: snapshot.members ?? [], memberId: snapshot.memberId, role: snapshot.role, port: props.port, t }),
    createElement("form", { className: roomCss.composer, onSubmit: submit },
      referencedItems.length > 0 ? createElement("div", { className: roomCss.contextRefs, "aria-label": t("composer.quotedMessages") },
        referencedItems.map((item) => createElement("div", { className: roomCss.contextRef, key: item.contextEventId },
          createElement("span", null, timelineLabel(item, t)),
          createElement("button", {
            type: "button",
            "aria-label": t("composer.removeQuote"),
            onClick: () => { setContextRefs(contextRefs.filter((eventId) => eventId !== item.contextEventId)); },
          }, "×"),
        )),
      ) : null,
      createElement("div", { className: roomCss.composerInput },
        createElement("textarea", { ref: textareaRef, className: roomCss.textarea, value: draft, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value), onKeyDown: keyDown, name: "collab-text", "aria-label": t("composer.messageAria"), placeholder: t("composer.placeholder"), rows: 1 }),
        shouldSuggestAgentMention(draft) ? createElement("div", { className: roomCss.mentionMenu },
          createElement("button", { type: "button", className: roomCss.mentionSuggestion, "aria-label": t("composer.mentionAgent"), onClick: () => { setDraft(insertAgentMention(draft)); textareaRef.current?.focus(); } },
            createElement("strong", null, "@agent"),
            createElement("span", null, t("room.hostAgent")),
          ),
        ) : null,
      ),
      createElement("button", { className: roomCss.send, type: "submit", disabled: !props.port || draft.trim() === "" }, t("composer.send")),
    ),
    error ? createElement("p", { className: roomCss.error, role: "alert" }, error) : null,
  );
}

function useSettingsSnapshot(port: DshCollabSettingsPort | undefined): DshCollabSettingsSnapshot | undefined {
  const [snapshot, setSnapshot] = useState(() => port?.getSnapshot());
  useEffect(() => {
    setSnapshot(port?.getSnapshot());
    return port?.subscribe?.(() => { setSnapshot(port.getSnapshot()); });
  }, [port]);
  return snapshot;
}

function useGatewaySnapshot(port: DshCollabSettingsPort | undefined): DshCollabGatewayRuntimeSnapshot {
  const [snapshot, setSnapshot] = useState<DshCollabGatewayRuntimeSnapshot>(() => port?.getGatewaySnapshot?.() ?? { status: "stopped" });
  useEffect(() => {
    const update = (): void => { setSnapshot(port?.getGatewaySnapshot?.() ?? { status: "stopped" }); };
    update();
    return port?.subscribeGateway?.(update);
  }, [port]);
  return snapshot;
}

/** Small session-header action; the native conversation keeps its own single composer. */
export function DshCollabSessionAction(props: {
  sessionId: string;
  defaultRoomName: string;
  port?: DshCollabClientPort;
  fallback?: DshCollabClientSnapshot;
  t?: CollabTranslate;
}): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const snapshot = usePortSnapshot(props.port, props.fallback ?? fallbackSnapshot);
  const hosted = snapshot.role === "host" && snapshot.roomId === props.sessionId && snapshot.connection !== "offline";
  const roomTitle = hosted ? snapshot.roomTitle : props.defaultRoomName;
  return createElement("button", {
    type: "button",
    className: roomCss.sessionAction,
    "data-collab-session-action": true,
    onClick: () => { openDshCollabRoom({ kind: "owned", roomId: props.sessionId, hostSessionId: props.sessionId, roomTitle }); },
  }, t(hosted ? "share.openRoom" : "share.asRoom"));
}

/** Full frame-wide room surface shared by Owner and Participant roles. */
export function DshCollabRoomSurface(props: { port?: DshCollabClientPort; settingsPort?: DshCollabSettingsPort; fallback?: DshCollabClientSnapshot; t?: CollabTranslate }): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const selection = useDshCollabRoomSelection();
  const snapshot = usePortSnapshot(props.port, props.fallback ?? fallbackSnapshot);
  const gateway = useGatewaySnapshot(props.settingsPort);
  const settings = useSettingsSnapshot(props.settingsPort);
  const [roomName, setRoomName] = useState(() => selection?.roomTitle ?? "");
  const [invitation, setInvitation] = useState("");
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string }>();
  const selectedRole = selection?.kind === "owned" ? "host" : "participant";
  const inspector = useCollabInspector({
    roomId: selection?.roomId ?? "",
    role: selectedRole,
    sharing: snapshot.workspaceSharing,
    port: props.settingsPort,
    memberId: snapshot.memberId,
    members: snapshot.members ?? [],
    timeline: snapshot.timeline ?? [],
  });
  useEffect(() => {
    setRoomName(selection?.roomTitle ?? "");
    setInvitation("");
    setNotice(undefined);
  }, [selection?.kind, selection?.roomId]);
  useEffect(() => {
    if (!notice) return;
    const timeout = setTimeout(() => { setNotice(undefined); }, notice.tone === "success" ? 3_000 : 6_000);
    return () => { clearTimeout(timeout); };
  }, [notice]);
  if (!selection) return null;

  const role = selectedRole;
  const selected = snapshot.roomId === selection.roomId && snapshot.role === role
    && (selection.kind === "owned" || snapshot.gatewayEndpoint === undefined || snapshot.gatewayEndpoint === selection.gatewayEndpoint);
  const active = selected && snapshot.connection !== "offline";
  const view: DshCollabClientSnapshot = selected ? snapshot : {
    ...fallbackSnapshot,
    roomId: selection.roomId,
    roomTitle: selection.roomTitle,
    hostDisplayName: selection.kind === "joined" ? selection.hostDisplayName ?? "" : "",
    role,
  };
  const appliedGateway = settings?.appliedGateway ?? settings;
  const gatewayEndpoint = appliedGateway?.advertisedEndpoint ?? "";
  const perform = async (key: string, action: () => Promise<void>, success?: string): Promise<void> => {
    setBusy(key);
    setNotice(undefined);
    try {
      await action();
      if (success) setNotice({ tone: "success", text: success });
    } catch (cause) {
      setNotice({ tone: "error", text: actionErrorText(cause, t) });
    } finally {
      setBusy(undefined);
    }
  };
  const startSharing = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (selection.kind !== "owned" || !props.settingsPort?.shareHostRoom || roomName.trim() === "") return;
    await perform("share", async () => {
      if (gateway.status !== "running") await props.settingsPort?.startGateway?.();
      await props.settingsPort!.shareHostRoom!({ sessionId: selection.hostSessionId, title: roomName.trim() });
    }, t("share.startedNotice"));
  };
  const connect = async (): Promise<void> => {
    if (selection.kind !== "joined" || !props.settingsPort?.connectJoinedRoom) return;
    await perform("connect", () => props.settingsPort!.connectJoinedRoom!({ gatewayEndpoint: selection.gatewayEndpoint, roomId: selection.roomId }));
  };
  const createInvitation = async (): Promise<void> => {
    if (selection.kind !== "owned" || !props.settingsPort?.createInvite || gatewayEndpoint === "") return;
    await perform("invite", async () => {
      const created = await props.settingsPort!.createInvite!({ expiresAt: Date.now() + 60 * 60 * 1000, gatewayEndpoint }, selection.roomId);
      setInvitation(created.invitation);
    }, t("share.invitationCreatedNotice"));
  };
  const copyInvitation = async (): Promise<void> => {
    await perform("copy", async () => { await navigator.clipboard.writeText(invitation); }, t("share.copiedNotice"));
  };
  const participantInactiveKey: CollabLocaleKey = view.unavailableReason === "host-stopped-sharing"
    ? "room.hostStoppedSharing"
    : view.unavailableReason === "host-unreachable"
      ? "room.hostUnreachable"
      : view.unavailableReason === "resource-limited"
        ? "room.resourceLimited"
        : "room.participantInactive";

  return createElement("main", { className: roomCss.surface, "data-collab-room-ui": true, "data-collab-surface": "room", "data-collab-mode": role, "aria-label": t("room.aria") },
    createElement("header", { className: roomCss.surfaceHeader },
      createElement("button", { type: "button", className: roomCss.backButton, onClick: closeDshCollabRoom }, t("rooms.backToDsh")),
      createElement("div", { className: roomCss.surfaceIdentity },
        createElement("strong", null, view.roomTitle),
        createElement("span", { className: roomCss.badge }, t(role === "host" ? "role.owner" : "role.participant")),
        view.hostDisplayName ? createElement("span", { className: roomCss.host }, t("room.hostedBy", { name: view.hostDisplayName })) : null,
      ),
      createElement("span", { className: roomCss.connection, role: "status" }, t("connection.summary", { connection: connectionLabel(view.connection, t), count: view.onlineCount })),
      createElement("div", { className: roomCss.surfaceActions },
        active ? createElement("button", { type: "button", className: roomCss.toolbarButton, "aria-expanded": inspector.open, onClick: inspector.show }, t("inspector.title")) : null,
        active && role === "host" ? createElement("button", { type: "button", className: roomCss.toolbarButton, disabled: busy !== undefined || !props.settingsPort?.createInvite || gatewayEndpoint === "", onClick: () => { void createInvitation(); } }, t(busy === "invite" ? "share.creating" : "share.createInvitation")) : null,
        active && role === "host" ? createElement("button", { type: "button", className: roomCss.toolbarButton, disabled: busy !== undefined || !props.settingsPort?.stopSharing, onClick: () => { void perform("stop", async () => { await props.settingsPort?.stopSharing?.(selection.roomId); }, t("share.stoppedNotice")); } }, t(busy === "stop" ? "share.stopping" : "share.stopSharing")) : null,
        active && role === "participant" ? createElement("button", { type: "button", className: roomCss.toolbarButton, disabled: busy !== undefined || !props.settingsPort?.disconnectJoinedRoom, onClick: () => { props.settingsPort?.disconnectJoinedRoom?.(); } }, t("joined.disconnect")) : null,
        createElement("button", { type: "button", className: roomCss.closeSurface, "aria-label": t("rooms.backToDsh"), onClick: closeDshCollabRoom }, "×"),
      ),
    ),
    createElement("div", { className: roomCss.content },
      active ? createElement(DshCollabDock, { port: props.port, fallback: view, showHeader: false, t }) : createElement("section", { className: roomCss.inactiveRoom },
        createElement("div", { className: roomCss.inactiveMark, "aria-hidden": true }, "@"),
        createElement("h2", null, view.roomTitle),
        createElement("p", null, t(role === "host" ? "room.ownerInactive" : participantInactiveKey)),
        role === "host" ? createElement("form", { className: roomCss.roomSetup, onSubmit: (event: FormEvent<HTMLFormElement>) => { void startSharing(event); } },
          createElement("label", { className: roomCss.shareField }, t("share.roomName"), createElement("input", { name: "roomName", className: roomCss.roomName, value: roomName, maxLength: 80, onChange: (event: ChangeEvent<HTMLInputElement>) => setRoomName(event.target.value) })),
          createElement("button", { type: "submit", className: roomCss.shareButton, disabled: busy !== undefined || !props.settingsPort?.shareHostRoom || roomName.trim() === "" }, t(busy === "share" ? "share.sharing" : "share.startAndShare")),
        ) : createElement("button", { type: "button", className: roomCss.shareButton, disabled: busy !== undefined || !props.settingsPort?.connectJoinedRoom, onClick: () => { void connect(); } }, t(busy === "connect" ? "joined.connecting" : "joined.connect")),
      ),
      createElement(DshCollabInspector, {
        open: inspector.open,
        roomId: selection.roomId,
        role,
        state: inspector.state,
        onClose: inspector.close,
        onRefresh: () => { void inspector.refresh(); },
        onSetSharing: (enabled: boolean) => { void inspector.setSharing(enabled); },
        onLoadSnapshot: () => { void inspector.loadSnapshot(); },
        onLoadDiff: (path: string, layer: "staged" | "unstaged") => { void inspector.loadDiff(path, layer); },
        activeTab: inspector.activeTab,
        onSelectTab: inspector.selectTab,
        onCreateReviewPoint: inspector.createReviewPoint,
        onReloadReviewPoints: () => { void inspector.reloadReviewPoints(); },
        onLoadMoreReviewPoints: () => { void inspector.loadMoreReviewPoints(); },
        onRefreshReviewPoints: () => { void inspector.refreshReviewPoints(); },
        members: view.members ?? [],
        onSelectReviewPoint: (reviewPointId: string) => { void inspector.selectReviewPoint(reviewPointId); },
        onCreateReviewFinding: inspector.createReviewFinding,
        onLoadMoreReviewFindings: (reviewPointId: string) => { void inspector.loadMoreReviewFindings(reviewPointId); },
        onSetReviewers: (reviewPointId: string, reviewerIds: string[]) => { void inspector.setReviewers(reviewPointId, reviewerIds); },
        onSetReviewLifecycle: (reviewPointId: string, lifecycle: ReviewLifecycle) => { void inspector.setReviewLifecycle(reviewPointId, lifecycle); },
        onSetReviewFindingState: (reviewPointId: string, findingId: string, state: "accepted" | "dismissed") => { void inspector.setReviewFindingState(reviewPointId, findingId, state); },
        onLoadReviewPointDiff: (reviewPointId: string, fileIndex: number) => { void inspector.loadReviewPointDiff(reviewPointId, fileIndex); },
        timeline: view.timeline ?? [],
        onStartLocalExplain: inspector.startLocalExplain,
        onStartLocalReview: inspector.startLocalReview,
        onPublishLocalReview: inspector.publishLocalReview,
        onAcceptReviewPublication: (reviewPointId: string, publicationId: string) => { void inspector.acceptReviewPublication(reviewPointId, publicationId); },
        onCancelLocalSideTask: () => { void inspector.cancelLocalSideTask(); },
        t,
      }),
    ),
    invitation ? createElement("section", { className: roomCss.invitationBar },
      createElement("input", { name: "hostInvitationOutput", type: "text", value: invitation, readOnly: true, "aria-label": t("share.invitationAria"), className: roomCss.invitationText }),
      createElement("button", { className: roomCss.toolbarButton, type: "button", onClick: () => { void copyInvitation(); }, disabled: busy !== undefined }, t(busy === "copy" ? "share.copying" : "share.copyInvitation")),
      createElement("button", { className: roomCss.toolbarButton, type: "button", onClick: () => { setInvitation(""); } }, t("share.hideInvitation")),
    ) : null,
    notice ? createElement("p", { className: notice.tone === "error" ? roomCss.surfaceError : roomCss.surfaceNotice, role: notice.tone === "error" ? "alert" : "status" }, notice.text) : null,
  );
}

function optionalService<T>(context: DshCollabClientContext, name: string): T | undefined {
  try { return context.get?.<T>(name); } catch { return undefined; }
}

function provideOptionalCollabPanelHost(context: DshCollabClientContext): void {
  const provide = (providerContext: DshCollabClientContext): void => {
    const resolution = resolveBetterSidebarHost(optionalService<BetterSidebarServicePort>(providerContext, "betterSidebar"));
    if (resolution.kind === "ready") providerContext.provide?.("collabPanelHost", resolution.host);
  };
  if (context.inject) context.inject(["betterSidebar"], provide);
  else provide(context);
}

function browserConfig(): { gatewayUrl: string; roomId: string; role?: "host" | "participant"; token?: string; principalId?: string } {
  return { gatewayUrl: `http://127.0.0.1:${String(defaultCollabSettings.gatewayPort)}/collab`, roomId: "dsh-room" };
}

/** Register additive conversation and settings contributions through real DSH slots. */
export function applyDshCollabClient(context: DshCollabClientContext): void {
  provideOptionalCollabPanelHost(context);
  const locale = context.locale ?? optionalService<DshCollabLocaleService>(context, "locale");
  if (locale) {
    if (context.effect) context.effect(() => locale.register(COLLAB_LOCALE_NAMESPACE, { zh, en }), "dsh-collab: locale dictionaries");
    else locale.register(COLLAB_LOCALE_NAMESPACE, { zh, en });
  }
  const fallbackT = locale?.bind(COLLAB_LOCALE_NAMESPACE) ?? defaultCollabTranslate;
  const translationFor = (props: Record<string, unknown>): CollabTranslate => typeof props.t === "function" ? props.t as CollabTranslate : fallbackT;
  const existing = optionalService<DshCollabClientPort>(context, "collabClient");
  const settingsScope = optionalService<DshSettingsScopeBinder>(context, "settingsScope")?.bind<PersistedCollabSettings>({ namespace: "dsh-collab", decode: decodePersistedSettings });
  const participantScope = optionalService<DshSettingsScopeBinder>(context, "settingsScope")?.bind<DshCollabParticipantSettings>({ namespace: DSH_COLLAB_PARTICIPANT_NAMESPACE, decode: decodeDshParticipantSettings });
  const browserClient = existing ? undefined : createDshBrowserCollabClient({ ...browserConfig(), ...(participantScope ? { participantPersistence: createDshParticipantPersistence(participantScope) } : {}) });
  const client = existing ?? browserClient;
  const rawBrowserSettings = optionalService<DshCollabSettingsPort>(context, "collabSettings") ?? browserClient?.settingsPort();
  const connection = optionalService<{ rpc: DshClientConnectionRpc }>(context, "connection");
  const browserSettings = rawBrowserSettings && connection ? createDshGatewayControlPort(rawBrowserSettings, connection.rpc) : rawBrowserSettings;
  const settings = settingsScope && browserSettings ? createDshSettingsPort(settingsScope, browserSettings) : browserSettings;
  if (browserClient) context.provide?.("collabClient", browserClient);
  if (settings) context.provide?.("collabSettings", settings);
  context.slots.inject("conversation.session.header.actions", () => context.slots.register({
    name: "conversation.session.header.actions",
    id: "dsh-collab",
    order: 30,
    locale: COLLAB_LOCALE_NAMESPACE,
  }, (props) => {
    const sessionId = String(props.sessionId ?? "");
    const useSessions = props.useSessions as undefined | (<T>(selector: (state: { byId: Record<string, { displayTitle: string }> }) => T) => T);
    const defaultRoomName = useSessions ? useSessions((state) => state.byId[sessionId]?.displayTitle ?? sessionId) : sessionId;
    return createElement(DshCollabSessionAction, { key: sessionId, sessionId, defaultRoomName, port: client, t: translationFor(props) });
  }));
  context.slots.inject("sidebar.footer.action", () => context.slots.register({ name: "sidebar.footer.action", id: "dsh-collab", order: 20, locale: COLLAB_LOCALE_NAMESPACE }, (props) => createElement(DshCollabRoomsLauncher, { wide: props.wide === true, t: translationFor(props) })));
  context.slots.inject("shell.overlay", () => context.slots.register({ name: "shell.overlay", id: "dsh-collab-rooms", order: 10, locale: COLLAB_LOCALE_NAMESPACE }, (props) => createElement(DshCollabRoomsPanel, {
    port: settings,
    panelHost: resolveBetterSidebarHost(optionalService<BetterSidebarServicePort>(context, "betterSidebar")),
    t: translationFor(props),
  })));
  context.slots.inject("shell.overlay", () => context.slots.register({ name: "shell.overlay", id: "dsh-collab-room", order: 20, locale: COLLAB_LOCALE_NAMESPACE }, (props) => createElement(DshCollabRoomSurface, { port: client, settingsPort: settings, t: translationFor(props) })));
  context.slots.inject("settings.plugin.item", () => context.slots.register({ name: "settings.plugin.item", key: "dsh-collab", locale: COLLAB_LOCALE_NAMESPACE }, (props) => createElement(DshCollabSettingsCard, { port: settings, t: translationFor(props) })));
}

/** DSH client runner entry expected by every `dsh.client` bundle. */
export { applyDshCollabClient as apply };
export { DshCollabSettingsCard } from "./collab-settings-card.js";
export { CollabActivity, projectCollabActivity } from "./collab-activity.js";
export { CollabChanges, validateCollabChangesSnapshot } from "./collab-changes.js";
export type { CollabChangesPort, CollabChangesSnapshot, CollabChangesWorkspaceSnapshot } from "./collab-changes.js";
export { CollabReviews, validateCollabReviewsSnapshot } from "./collab-reviews.js";
export type { CollabReviewItem, CollabReviewMember, CollabReviewsPort, CollabReviewsSnapshot } from "./collab-reviews.js";
export { closeDshCollabRoom, DshCollabRoomsLauncher, DshCollabRoomsPanel, openDshCollabRoom, setDshCollabRoomsOpen } from "./collab-rooms.js";
