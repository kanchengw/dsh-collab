import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { MarkdownText, projectUserText, type MarkdownLabels } from "@deepseek-ai/dsh-client-ui-primitives";
import { type ComposerTarget, type TimelineItem } from "./ui.js";
import { createDshBrowserCollabClient, EasyTierConnectionError, type DshBrowserCollabClient, type DshBrowserEasyTierTransport, type DshBrowserJoinInput, type JoinedRoomRef, type ParticipantPersistence, type ParticipantResumeState } from "./dsh-browser-client.js";
import { DshCollabSettingsCard } from "./collab-settings-card.js";
import { DshCollabRoomsLauncher, DshCollabRoomsPanel, openDshCollabRoom, setDshCollabRoomsOpen, shareDshCollabOwnedRoom, useDshCollabRoomSelection, type DshCollabRoomSelection } from "./collab-rooms.js";
import { normalizeAdvertisedGatewayEndpoint, normalizeGatewayEndpoint } from "./endpoint-policy.js";
import { defaultCollabSettings, DSH_COLLAB_PARTICIPANT_NAMESPACE, type CollabConnectionMethod, type DshCollabJoinedRoom, type DshCollabParticipantSettings, type DshCollabSecuritySettings } from "./settings-shared.js";
import { COLLAB_LOCALE_NAMESPACE, defaultCollabTranslate, en, zh, type CollabLocaleKey, type CollabTranslate } from "./locales.js";
import type { AcceptedReviewPublication, ReviewFinding, ReviewFindingCreateInput, ReviewFindingPage, ReviewLifecycle, ReviewPoint, ReviewPointCreateInput, ReviewPointDiff, ReviewPointPage, ReviewPublication, ReviewPublicationCreateInput, ReviewPublicationPage, WorkspaceSharingState, WorkspaceSnapshotPackage } from "./collaboration-types.js";
import type { RepositoryDiff, RepositoryInspection } from "./repository-inspector.js";
import roomCss from "./collab-room.module.css";
import type { LocalSideTaskSnapshot, LocalSnapshotAccess, StartExplainTaskInput, StartReviewTaskInput } from "./local-sidecar.js";
import type { AgentQueueItem, RoomEvent } from "./types.js";
import { CollabBarView } from "./collab-bar.js";
import { projectCollabActivity, type CollabActivityItem } from "./collab-activity.js";
import { type CollabPanelHost, type CollabPanelOpenTarget, type CollabPanelRenderScope } from "./collab-panel-host.js";
import { collabPanelScopeFromTab, createOfficialCollabPanelHost, openOfficialCollabRooms, registerOfficialCollabSidebar, type DshLayoutPanelPort, type DshSidebarRightPort, type DshSidebarRightTabProps, type DshSidebarRightTabsPort } from "./dsh-sidebar-embedding.js";
import type { CollabChangesPort } from "./collab-changes.js";
import type { CollabReviewsPort } from "./collab-reviews.js";
import { assertEasyTierPrivateIpv4, decodeEasyTierInvitationNetwork } from "./easytier-invitation.js";
import type { CollabInvitationNetwork } from "./invitation.js";
import { DshCollabWorkspacePorts, type OpenParticipantRoomWorkspaceInput } from "./collab-workspace-client.js";
import { DshCollabComposer } from "./collab-composer.js";

interface DshClientWorkspaces {
  create(input: { path: string }): Promise<{ workspaceId: string }>;
}

interface DshClientWorkspaceNavigation {
  connectWorkspace(workspaceId: string): Promise<string>;
  openSession(sessionId: string): void;
  pickDirectory?(): Promise<string | null>;
}

interface DshClientSessions {
  list?: {
    getSnapshot(): {
      current?: string;
      byId: Readonly<Record<string, { cwd?: string }>>;
    };
  };
}

function comparableWorkspacePath(path: string): string {
  const trimmed = path.trim().replace(/[\\/]+$/, "");
  return /^[A-Za-z]:[\\/]/.test(trimmed) ? trimmed.replace(/\//g, "\\").toLowerCase() : trimmed;
}

function sessionForWorkspacePath(sessions: DshClientSessions, sourcePath: string): string | undefined {
  const snapshot = sessions.list?.getSnapshot();
  if (!snapshot) return undefined;
  const expected = comparableWorkspacePath(sourcePath);
  const matches = ([snapshot.current, ...Object.keys(snapshot.byId)] as Array<string | undefined>)
    .filter((sessionId, index, values): sessionId is string => typeof sessionId === "string" && values.indexOf(sessionId) === index)
    .find((sessionId) => {
      const cwd = snapshot.byId[sessionId]?.cwd;
      return typeof cwd === "string" && comparableWorkspacePath(cwd) === expected;
    });
  return matches;
}

export function createDshParticipantWorkspaceOpener(input: {
  workspaces: DshClientWorkspaces;
  workspaceNavigation: DshClientWorkspaceNavigation;
  sessions: DshClientSessions;
  panelHost(): CollabPanelHost | undefined;
}): (room: OpenParticipantRoomWorkspaceInput) => Promise<void> {
  return async (room) => {
    const panelHost = input.panelHost();
    if (!panelHost) throw new Error("Collab Bar is unavailable");
    const workspaceId = room.nativeWorkspaceId ?? (await input.workspaces.create({ path: room.path })).workspaceId;
    const sessionId = await input.workspaceNavigation.connectWorkspace(workspaceId);
    input.workspaceNavigation.openSession(sessionId);
    openDshCollabRoom({
      kind: "joined",
      roomId: room.roomId,
      gatewayEndpoint: room.gatewayEndpoint,
      roomTitle: room.roomTitle,
      ...(room.hostDisplayName ? { hostDisplayName: room.hostDisplayName } : {}),
    }, panelHost, { sessionId, cwd: room.path });
  };
}

export function createDshOwnedRoomCreator(input: {
  rpc: DshClientConnectionRpc;
  workspaces: DshClientWorkspaces;
  workspaceNavigation: DshClientWorkspaceNavigation;
  sessions: DshClientSessions;
  panelHost(): CollabPanelHost | undefined;
  refreshOwnedRooms?(): Promise<unknown>;
}): (roomTitle: string, sourcePath: string) => Promise<boolean> {
  return async (roomTitle, sourcePath) => {
    const title = roomTitle.trim();
    if (title === "") throw new Error("Room title must not be blank");
    const panelHost = input.panelHost();
    if (!panelHost) throw new Error("Collab Bar is unavailable");
    let sourceSessionId = sessionForWorkspacePath(input.sessions, sourcePath);
    if (!sourceSessionId) {
      const sourceWorkspace = await input.workspaces.create({ path: sourcePath });
      sourceSessionId = await input.workspaceNavigation.connectWorkspace(sourceWorkspace.workspaceId);
    }
    const prepared = controlValue(await input.rpc.call("/dsh-collab", "owner/room-project/prepare", {
      sourcePath,
      sourceSessionId,
      roomTitle: title,
    }), "Owner Room Project preparation failed");
    if (typeof prepared.roomId !== "string" || typeof prepared.workspacePath !== "string" || typeof prepared.nativeWorkspaceId !== "string") {
      throw new Error("Invalid Owner Room Project response");
    }
    const hostPrimarySessionId = await input.workspaceNavigation.connectWorkspace(prepared.nativeWorkspaceId);
    input.workspaceNavigation.openSession(hostPrimarySessionId);
    controlValue(await input.rpc.call("/dsh-collab", "owner/room-project/complete", {
      roomId: prepared.roomId,
      sourceSessionId,
      hostPrimarySessionId,
    }), "Owner Room Project completion failed");
    openDshCollabRoom({
      kind: "owned",
      roomId: prepared.roomId,
      hostSessionId: hostPrimarySessionId,
      roomTitle: title,
    }, panelHost, { sessionId: hostPrimarySessionId, cwd: prepared.workspacePath });
    await input.refreshOwnedRooms?.();
    return true;
  };
}

interface DshJoinedRoomOpenerSettings {
  connectJoinedRoom(ref: JoinedRoomRef): Promise<void>;
  getRoomSnapshot(): Pick<DshCollabClientSnapshot, "roomId" | "gatewayEndpoint" | "memberId" | "roomTitle" | "hostDisplayName" | "role" | "connection">;
  getLocalSnapshotAccess(roomId: string): LocalSnapshotAccess;
}

interface DshJoinedRoomProjectRecord {
  roomId: string;
  memberId: string;
  roomTitle: string;
  workspacePath: string;
  nativeWorkspaceId: string;
}

function joinedRoomProjectValue(value: unknown): DshJoinedRoomProjectRecord {
  const envelope = value as { ok?: unknown; value?: unknown; error?: { message?: unknown } };
  if (!envelope || envelope.ok !== true || !envelope.value || typeof envelope.value !== "object" || Array.isArray(envelope.value)) {
    throw new Error(typeof envelope?.error?.message === "string" ? envelope.error.message : "Participant Room Project join failed");
  }
  const project = envelope.value as Record<string, unknown>;
  if ([project.roomId, project.memberId, project.roomTitle, project.workspacePath, project.nativeWorkspaceId]
    .some((field) => typeof field !== "string" || field.trim() === "")) {
    throw new Error("Participant Room Project response is invalid");
  }
  return {
    roomId: project.roomId as string,
    memberId: project.memberId as string,
    roomTitle: project.roomTitle as string,
    workspacePath: project.workspacePath as string,
    nativeWorkspaceId: project.nativeWorkspaceId as string,
  };
}

export function createDshJoinedRoomOpener(input: {
  settings: DshJoinedRoomOpenerSettings;
  rpc: DshClientConnectionRpc;
  openWorkspace: (input: OpenParticipantRoomWorkspaceInput) => Promise<void>;
}): (room: { roomId: string; gatewayEndpoint: string; roomTitle: string; hostDisplayName?: string }) => Promise<void> {
  return async (room) => {
    const current = input.settings.getRoomSnapshot();
    if (current.roomId !== room.roomId || current.role !== "participant" || current.connection !== "online") {
      await input.settings.connectJoinedRoom({ gatewayEndpoint: room.gatewayEndpoint, roomId: room.roomId });
    }
    const connected = input.settings.getRoomSnapshot();
    if (connected.roomId !== room.roomId || connected.role !== "participant" || connected.connection !== "online" || !connected.memberId || !connected.gatewayEndpoint) {
      throw new Error("The selected Joined room is not connected");
    }
    const access = input.settings.getLocalSnapshotAccess(room.roomId);
    const project = joinedRoomProjectValue(await input.rpc.call("/dsh-collab", "participant/room-project/join", {
      roomId: room.roomId,
      memberId: connected.memberId,
      roomTitle: connected.roomTitle,
      gatewayEndpoint: connected.gatewayEndpoint,
      roomToken: access.roomToken,
    }));
    if (project.roomId !== room.roomId || project.memberId !== connected.memberId) throw new Error("Participant Room Project response does not match the selected room");
    await input.openWorkspace({
      roomId: project.roomId,
      path: project.workspacePath,
      nativeWorkspaceId: project.nativeWorkspaceId,
      gatewayEndpoint: connected.gatewayEndpoint,
      roomTitle: project.roomTitle,
      hostDisplayName: connected.hostDisplayName,
    });
  };
}

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
  unavailableReason?: "host-stopped-sharing" | "host-unreachable" | "resource-limited" | "network-offline" | "transport-failed";
  members?: readonly { memberId: string; displayName: string }[];
  timeline?: readonly TimelineItem[];
  agentQueue?: readonly AgentQueueItem[];
  roomEvents?: readonly RoomEvent[];
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
  connectionMethod?: CollabConnectionMethod;
  easyTierSharedNode?: string;
};

export interface DshCollabSettingsPort {
  getSnapshot(): DshCollabSettingsSnapshot;
  getRoomSnapshot?(): Pick<DshCollabClientSnapshot, "roomId" | "gatewayEndpoint" | "memberId" | "roomTitle" | "hostDisplayName" | "role" | "connection">;
  subscribeRoom?(listener: () => void): () => void;
  subscribe?(listener: () => void): () => void;
  save(input: { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; advertisedEndpoint: string; connectionMethod?: CollabConnectionMethod; easyTierSharedNode?: string } & Partial<DshCollabSecuritySettings>): Promise<void>;
  bootstrap?(roomId?: string): Promise<void>;
  shareHostRoom?(input: { roomId: string; hostSessionId: string; title: string }): Promise<void>;
  stopSharing?(roomId: string): Promise<void>;
  join?(input: DshBrowserJoinInput, roomId?: string): Promise<void>;
  createInvite?(input: { inviteId?: string; expiresAt: number; gatewayEndpoint: string; network?: CollabInvitationNetwork }, roomId?: string): Promise<{ invitation: string }>;
  listJoinedRooms?(): readonly ParticipantResumeState[];
  subscribeJoinedRooms?(listener: () => void): () => void;
  connectJoinedRoom?(ref: JoinedRoomRef): Promise<void>;
  disconnectJoinedRoom?(): Promise<void>;
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

export function resolveDshCollabRoomSelection(sessionId: string, settings: DshCollabSettingsPort | undefined, snapshot: DshCollabClientSnapshot): DshCollabRoomSelection | undefined {
  const owned = settings?.getOwnedRooms?.().find((room) => room.roomId === snapshot.roomId && room.hostSessionId === sessionId);
  if (owned) return { kind: "owned", roomId: owned.roomId, hostSessionId: owned.hostSessionId, roomTitle: owned.title };
  if (snapshot.role !== "participant" || snapshot.roomId === "dsh-room") return undefined;
  const joined = settings?.listJoinedRooms?.().find((room) => room.roomId === snapshot.roomId);
  const gatewayEndpoint = joined?.gatewayEndpoint ?? snapshot.gatewayEndpoint;
  if (!gatewayEndpoint) return undefined;
  return {
    kind: "joined",
    roomId: snapshot.roomId,
    gatewayEndpoint,
    roomTitle: joined?.roomTitle ?? snapshot.roomTitle,
    ...(joined?.hostDisplayName ?? snapshot.hostDisplayName ? { hostDisplayName: joined?.hostDisplayName ?? snapshot.hostDisplayName } : {}),
    localSessionId: sessionId,
  };
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
export const inject = ["slots", "connection", "locale", "workspaces", "uiWorkspace", "sessions", "layout", "sidebarRight", "sidebarRightTabs"];

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
  connectionMethod?: CollabConnectionMethod;
  easyTierSharedNode?: string;
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

export function decodeParticipantResumeState(value: unknown): ParticipantResumeState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if ([candidate.gatewayEndpoint, candidate.roomId, candidate.memberId, candidate.credential].some((field) => typeof field !== "string" || field.trim() === "")) return undefined;
  try { normalizeGatewayEndpoint(candidate.gatewayEndpoint as string); } catch { return undefined; }
  let easyTier: ParticipantResumeState["easyTier"];
  if (candidate.easyTier && typeof candidate.easyTier === "object" && !Array.isArray(candidate.easyTier)) {
    const input = candidate.easyTier as Record<string, unknown>;
    try {
      const network = decodeEasyTierInvitationNetwork(input.network);
      if (typeof input.localVirtualAddress !== "string") return undefined;
      assertEasyTierPrivateIpv4("localVirtualAddress", input.localVirtualAddress);
      easyTier = { network, localVirtualAddress: input.localVirtualAddress };
    } catch { return undefined; }
  }
  return {
    gatewayEndpoint: candidate.gatewayEndpoint as string,
    roomId: candidate.roomId as string,
    memberId: candidate.memberId as string,
    credential: candidate.credential as string,
    ...(typeof candidate.roomTitle === "string" && candidate.roomTitle.trim() !== "" ? { roomTitle: candidate.roomTitle } : {}),
    ...(typeof candidate.hostDisplayName === "string" && candidate.hostDisplayName.trim() !== "" ? { hostDisplayName: candidate.hostDisplayName } : {}),
    ...(easyTier ? { easyTier } : {}),
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
    maxQueue: security.maxQueue ?? defaultCollabSettings.maxQueue,
  };
  const configuredMethod = (value as { connectionMethod?: unknown }).connectionMethod;
  const fallbackMethod: CollabConnectionMethod = gateway.exposeMode === "network" ? "private-network" : gateway.advertisedEndpoint.startsWith("wss://") ? "custom-wss" : "unconfigured";
  const connectionMethod: CollabConnectionMethod = configuredMethod === "private-network" || configuredMethod === "easytier" || configuredMethod === "custom-wss"
    ? configuredMethod
    : fallbackMethod;
  const easyTierSharedNode = typeof (value as { easyTierSharedNode?: unknown }).easyTierSharedNode === "string"
    ? (value as { easyTierSharedNode: string }).easyTierSharedNode
    : defaultCollabSettings.easyTierSharedNode;
  return { gateway, ...(appliedGateway ? { appliedGateway } : {}), security: normalized, connectionMethod, easyTierSharedNode };
}

export function decodeDshParticipantSettings(value: unknown): DshCollabParticipantSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const decodedRooms = Array.isArray((value as { joinedRooms?: unknown }).joinedRooms)
    ? (value as { joinedRooms: unknown[] }).joinedRooms.map(decodeParticipantSetting).filter((room): room is DshCollabJoinedRoom => room !== undefined)
    : [];
  const joinedRooms = [...new Map(decodedRooms.map((room) => [room.roomId, room])).values()];
  return joinedRooms.length > 0 ? { joinedRooms } : {};
}

export interface DshParticipantSecretPort {
  save(state: ParticipantResumeState): Promise<string>;
  load(key: string): Promise<ParticipantResumeState>;
  remove(key: string): Promise<void>;
}

function participantMetadata(state: ParticipantResumeState, credentialKey: string): DshCollabJoinedRoom {
  return {
    gatewayEndpoint: state.gatewayEndpoint,
    roomId: state.roomId,
    memberId: state.memberId,
    credentialKey,
    ...(state.roomTitle ? { roomTitle: state.roomTitle } : {}),
    ...(state.hostDisplayName ? { hostDisplayName: state.hostDisplayName } : {}),
  };
}

function assertParticipantBinding(state: ParticipantResumeState, metadata: DshCollabJoinedRoom): void {
  if (state.gatewayEndpoint !== metadata.gatewayEndpoint || state.roomId !== metadata.roomId || state.memberId !== metadata.memberId) {
    throw new Error("Participant credential record does not match its Joined room");
  }
}

export function createDshParticipantPersistence(
  scope: DshSettingsScope<DshCollabParticipantSettings>,
  secrets: DshParticipantSecretPort,
): ParticipantPersistence {
  let cache: ParticipantResumeState[] = [];
  let prepared = false;
  let preparing: Promise<void> | undefined;
  const listeners = new Set<() => void>();
  const publish = (): void => { for (const listener of listeners) listener(); };
  const settingsRooms = (): DshCollabJoinedRoom[] => [...(scope.getSnapshot().value?.joinedRooms ?? [])];
  const list = (): ParticipantResumeState[] => structuredClone(cache);
  const sameRoom = (room: JoinedRoomRef, other: JoinedRoomRef): boolean => room.gatewayEndpoint === other.gatewayEndpoint && room.roomId === other.roomId;
  const prepare = async (): Promise<void> => {
    if (prepared) return;
    if (preparing) return await preparing;
    preparing = (async () => {
      const current = scope.getSnapshot();
      if (current.status !== "ready") throw new Error("DSH settings are not ready");
      const nextStates: ParticipantResumeState[] = [];
      for (const room of settingsRooms()) {
        const state = await secrets.load(room.credentialKey);
        assertParticipantBinding(state, room);
        nextStates.push(state);
      }
      cache = nextStates;
      prepared = true;
      publish();
    })();
    try { await preparing; } finally { preparing = undefined; }
  };
  return {
    prepare,
    load: (ref) => ref ? list().find((room) => sameRoom(room, ref)) : list()[0],
    list,
    subscribe: (listener) => {
      listeners.add(listener);
      const unsubscribe = scope.subscribe(listener);
      return () => { listeners.delete(listener); unsubscribe(); };
    },
    save: async (state) => {
      await prepare();
      const current = scope.getSnapshot();
      if (current.status !== "ready" || !current.writable) throw new Error("DSH settings are not writable");
      const previous = settingsRooms().find((room) => room.roomId === state.roomId);
      const key = await secrets.save(state);
      const rooms = settingsRooms().filter((room) => room.roomId !== state.roomId);
      rooms.push(participantMetadata(state, key));
      try {
        await scope.set("joinedRooms", rooms);
        const saved = settingsRooms().find((room) => room.roomId === state.roomId);
        if (saved?.credentialKey !== key || saved.memberId !== state.memberId || saved.gatewayEndpoint !== state.gatewayEndpoint) {
          throw new Error("Participant credential reference was not persisted by DSH");
        }
      } catch (error) {
        await secrets.remove(key).catch(() => undefined);
        throw error;
      }
      cache = [...cache.filter((room) => room.roomId !== state.roomId), structuredClone(state)];
      if (previous?.credentialKey) await secrets.remove(previous.credentialKey).catch(() => undefined);
      publish();
    },
    remove: async (ref) => {
      await prepare();
      const current = scope.getSnapshot();
      if (current.status !== "ready" || !current.writable) throw new Error("DSH settings are not writable");
      const removed = settingsRooms().find((room) => sameRoom(room, ref));
      const rooms = settingsRooms().filter((room) => !sameRoom(room, ref));
      if (rooms.length > 0) await scope.set("joinedRooms", rooms); else await scope.unset("joinedRooms");
      cache = cache.filter((room) => !sameRoom(room, ref));
      if (removed?.credentialKey) await secrets.remove(removed.credentialKey);
      publish();
    },
  };
}

/**
 * DSH 0.1.7 does not expose the legacy settings-scope binder to client bundles.
 * Keep the current Desktop process usable by retaining a Joined room in memory;
 * the room credential still lives only for this Desktop lifetime.
 */
export function createDshEphemeralParticipantPersistence(): ParticipantPersistence {
  let current: ParticipantResumeState | undefined;
  const listeners = new Set<() => void>();
  const sameRoom = (ref: JoinedRoomRef, state: ParticipantResumeState): boolean =>
    ref.gatewayEndpoint === state.gatewayEndpoint && ref.roomId === state.roomId;
  const publish = (): void => { for (const listener of listeners) listener(); };
  return {
    prepare: async () => {},
    load: (ref) => {
      if (!current) return undefined;
      return ref === undefined || sameRoom(ref, current) ? structuredClone(current) : undefined;
    },
    list: () => current ? [structuredClone(current)] : [],
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    save: async (state) => { current = structuredClone(state); publish(); },
    remove: async (ref) => {
      if (current && sameRoom(ref, current)) { current = undefined; publish(); }
    },
  };
}

export function createDshParticipantSecretPort(rpc: DshClientConnectionRpc): DshParticipantSecretPort {
  return {
    async save(state) {
      const value = controlValue(await rpc.call("/dsh-collab", "credentials/participant/save", { state }), "Unable to save Participant credential");
      if (typeof value.credentialKey !== "string" || !/^dsh-collab\/participant-[a-z0-9-]+$/.test(value.credentialKey)) throw new Error("Invalid Participant credential response");
      return value.credentialKey;
    },
    async load(key) {
      const value = controlValue(await rpc.call("/dsh-collab", "credentials/participant/load", { credentialKey: key }), "Unable to load Participant credential");
      const state = decodeParticipantResumeState(value.state);
      if (!state) throw new Error("Invalid Participant credential response");
      return state;
    },
    async remove(key) {
      controlValue(await rpc.call("/dsh-collab", "credentials/participant/delete", { credentialKey: key }), "Unable to delete Participant credential");
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

function controlValue(result: unknown, message: string): Record<string, unknown> {
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error(message);
  const envelope = result as { ok?: unknown; value?: unknown; error?: { message?: unknown } };
  if (envelope.ok !== true) throw new Error(typeof envelope.error?.message === "string" ? envelope.error.message : message);
  if (!envelope.value || typeof envelope.value !== "object" || Array.isArray(envelope.value)) throw new Error(message);
  return envelope.value as Record<string, unknown>;
}

export function createDshBrowserEasyTierTransport(rpc: DshClientConnectionRpc): DshBrowserEasyTierTransport {
  return {
    async startParticipant(input) {
      let value: Record<string, unknown>;
      try {
        value = controlValue(await rpc.call("/dsh-collab", "easytier/participant/start", input), "Invalid EasyTier Participant response");
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        throw new EasyTierConnectionError(message.includes("network is offline") ? "network-offline" : "transport-failed", message, cause);
      }
      if (value.role !== "participant" || value.roomId !== input.roomId || typeof value.gatewayEndpoint !== "string" || typeof value.localVirtualAddress !== "string") {
        throw new Error("Invalid EasyTier Participant response");
      }
      const endpoint = new URL(value.gatewayEndpoint);
      if (endpoint.protocol !== "ws:" || endpoint.hostname !== "127.0.0.1" || endpoint.pathname !== "/collab") throw new Error("Invalid EasyTier Participant bridge");
      assertEasyTierPrivateIpv4("localVirtualAddress", value.localVirtualAddress);
      return { gatewayEndpoint: value.gatewayEndpoint, localVirtualAddress: value.localVirtualAddress };
    },
    async stop() {
      const result = await rpc.call("/dsh-collab", "easytier/stop", {});
      if (!result || typeof result !== "object" || (result as { ok?: unknown }).ok !== true) throw new Error("Unable to stop EasyTier");
    },
  };
}

function decodeParticipantSetting(value: unknown): DshCollabJoinedRoom | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if ([candidate.gatewayEndpoint, candidate.roomId, candidate.memberId].some((field) => typeof field !== "string" || field.trim() === "")) return undefined;
  try { normalizeGatewayEndpoint(candidate.gatewayEndpoint as string); } catch { return undefined; }
  const credentialKey = typeof candidate.credentialKey === "string" && /^dsh-collab\/participant-[a-z0-9-]+$/.test(candidate.credentialKey)
    ? candidate.credentialKey
    : undefined;
  if (!credentialKey) return undefined;
  return {
    gatewayEndpoint: candidate.gatewayEndpoint as string,
    roomId: candidate.roomId as string,
    memberId: candidate.memberId as string,
    credentialKey,
    ...(typeof candidate.roomTitle === "string" && candidate.roomTitle.trim() !== "" ? { roomTitle: candidate.roomTitle } : {}),
    ...(typeof candidate.hostDisplayName === "string" && candidate.hostDisplayName.trim() !== "" ? { hostDisplayName: candidate.hostDisplayName } : {}),
  };
}

export function createDshGatewayControlPort(base: DshCollabSettingsPort, rpc: DshClientConnectionRpc): DshCollabSettingsPort {
  let gateway: DshCollabGatewayRuntimeSnapshot = { status: "stopped" };
  let ownedRooms: DshCollabOwnedRoom[] = [];
  const listeners = new Set<() => void>();
  const roomListeners = new Set<() => void>();
  const createInvite = base.createInvite?.bind(base);
  const stopSharing = base.stopSharing?.bind(base);
  const shareHostRoom = base.shareHostRoom?.bind(base);
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
  const startEasyTierOwner = async (roomId: string): Promise<{ gatewayEndpoint: string; network: ReturnType<typeof decodeEasyTierInvitationNetwork> }> => {
    if (gateway.status !== "running") throw new Error("Start the Host Gateway before sharing through EasyTier");
    const settings = base.getSnapshot();
    if ((settings.appliedGateway ?? settings).gatewayHost !== "0.0.0.0") throw new Error("Restart the Host Gateway before sharing through EasyTier");
    const value = controlValue(await rpc.call("/dsh-collab", "easytier/owner/start", { roomId, gatewayPort: gateway.port }), "Invalid EasyTier Owner response");
    if (value.role !== "owner" || value.roomId !== roomId || typeof value.gatewayEndpoint !== "string") throw new Error("Invalid EasyTier Owner response");
    return { gatewayEndpoint: value.gatewayEndpoint, network: decodeEasyTierInvitationNetwork(value.network) };
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
    createInvite: createInvite ? async (input: { inviteId?: string; expiresAt: number; gatewayEndpoint: string; network?: CollabInvitationNetwork }, roomId?: string) => {
      const settings = base.getSnapshot();
      if (settings.connectionMethod !== "easytier") return createInvite(input, roomId);
      if (!roomId || gateway.status !== "running") throw new Error("Start sharing this room before creating an EasyTier invitation");
      const active = await startEasyTierOwner(roomId);
      return createInvite({ ...input, gatewayEndpoint: active.gatewayEndpoint, network: active.network }, roomId);
    } : undefined,
    shareHostRoom: shareHostRoom ? async (input: { roomId: string; hostSessionId: string; title: string }) => {
      if (base.getSnapshot().connectionMethod === "easytier") {
        try {
          await startEasyTierOwner(input.roomId);
          await shareHostRoom(input);
        } catch (error) {
          await rpc.call("/dsh-collab", "easytier/stop", {}).catch(() => undefined);
          throw error;
        }
        return;
      }
      await shareHostRoom(input);
    } : undefined,
    stopSharing: stopSharing ? async (roomId: string) => {
      const transport = controlValue(await rpc.call("/dsh-collab", "easytier/status", {}), "Invalid EasyTier status response");
      try {
        await stopSharing(roomId);
      } finally {
        if (transport.active === true && transport.role === "owner" && transport.roomId === roomId) {
          await rpc.call("/dsh-collab", "easytier/stop", {});
        }
      }
    } : undefined,
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
        maxQueue: persisted.security?.maxQueue ?? defaultCollabSettings.maxQueue,
        connectionMethod: persisted.connectionMethod ?? defaultCollabSettings.connectionMethod,
        easyTierSharedNode: persisted.easyTierSharedNode ?? defaultCollabSettings.easyTierSharedNode,
      };
      const fallback = actions.getSnapshot();
      return {
        ...fallback,
        writable: scopeSnapshot.writable,
        tokenTtlMs: fallback.tokenTtlMs === undefined ? defaultCollabSettings.tokenTtlMs : fallback.tokenTtlMs,
        approvalPolicy: fallback.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
        maxMembers: fallback.maxMembers ?? defaultCollabSettings.maxMembers,
        maxMessageBytes: fallback.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
        maxQueue: fallback.maxQueue ?? defaultCollabSettings.maxQueue,
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
      const connectionMethod = input.connectionMethod ?? (input.exposeMode === "network" ? "private-network" : advertisedEndpoint.startsWith("wss://") ? "custom-wss" : "unconfigured");
      const easyTierSharedNode = input.easyTierSharedNode ?? defaultCollabSettings.easyTierSharedNode;
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
      if (input.connectionMethod !== undefined) await scope.set("connectionMethod", connectionMethod);
      if (input.easyTierSharedNode !== undefined) await scope.set("easyTierSharedNode", easyTierSharedNode);
      const committed = scope.getSnapshot().value;
      if (!committed
        || committed.gateway.gatewayHost !== input.gatewayHost
        || committed.gateway.gatewayPort !== input.gatewayPort
        || committed.gateway.exposeMode !== input.exposeMode
        || committed.gateway.advertisedEndpoint !== advertisedEndpoint
        || (input.connectionMethod !== undefined && committed.connectionMethod !== connectionMethod)
        || (input.easyTierSharedNode !== undefined && committed.easyTierSharedNode !== easyTierSharedNode)
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

function timelineLabel(item: TimelineItem, t: CollabTranslate): string {
  if (item.text) return item.text;
  if (item.kind === "agent-request") return t("room.agentRequest", { status: agentStatusLabel(item.status ?? "updated", t) });
  if (item.kind === "agent") return t("room.hostAgent");
  return t("room.message");
}

function markdownLabels(t: CollabTranslate): MarkdownLabels {
  return {
    code: { copyLabel: t("markdown.copy"), copiedLabel: t("markdown.copied") },
    footnotes: t("markdown.footnotes"),
  };
}

function DshCollabTimeline(props: {
  items: readonly TimelineItem[];
  workUpdates?: readonly CollabActivityItem[];
  members: readonly { memberId: string; displayName: string }[];
  currentMemberId?: string;
  t: CollabTranslate;
}): ReactNode {
  const rows = [
    ...props.items.map((item) => ({ kind: "timeline" as const, eventId: item.eventId, seq: item.seq, item })),
    ...(props.workUpdates ?? []).filter((item) => item.kind === "work-update").map((item) => ({ kind: "work-update" as const, eventId: item.eventId, seq: item.seq, item })),
  ].sort((left, right) => left.seq - right.seq || left.eventId.localeCompare(right.eventId));
  const authorName = (memberId: string): string => props.members.find((member) => member.memberId === memberId)?.displayName ?? memberId;
  const initials = (name: string): string => {
    const words = name.trim().split(/\s+/).filter(Boolean);
    return (words.length > 1 ? words.slice(0, 2).map((word) => Array.from(word)[0]).join("") : Array.from(words[0] ?? "?").slice(0, 2).join("")).toUpperCase();
  };
  if (rows.length === 0) return createElement("div", { className: roomCss.timeline, "data-collab-feed": true }, createElement("p", { className: roomCss.empty }, props.t("room.noMessages")));
  return createElement("div", { className: roomCss.timeline, "data-collab-timeline": true, "data-collab-feed": true, "aria-live": "polite" },
    rows.map((row) => {
      if (row.kind === "work-update") {
        const item = row.item;
        const author = authorName(item.authorId);
        return createElement("article", { key: item.eventId, className: roomCss.message, "data-kind": "work-update", "data-own": item.authorId === props.currentMemberId ? "true" : undefined },
          createElement("span", { className: roomCss.avatar, "aria-hidden": "true" }, initials(author)),
          createElement("div", { className: roomCss.messageContent },
            createElement("div", { className: roomCss.messageMeta }, createElement("strong", null, author), createElement("span", null, props.t("activity.workUpdate"))),
            createElement("p", { className: roomCss.updateSummary }, item.summary),
            item.filePaths.length === 0 ? null : createElement("ul", { className: roomCss.updateFiles, "aria-label": props.t("activity.files") }, item.filePaths.map((path) => createElement("li", { key: path }, createElement("code", null, path)))),
          ),
        );
      }
      const item = row.item;
      const status = item.status ?? (item.kind === "agent" && item.state === "failed" ? item.state : undefined);
      const author = item.kind === "agent"
        ? props.t("room.hostAgent")
        : authorName(item.authorMemberId);
      const own = item.kind !== "agent" && item.authorMemberId === props.currentMemberId;
      return createElement("article", {
        key: item.eventId,
        className: roomCss.message,
        "data-kind": item.kind,
        "data-own": own ? "true" : undefined,
        "data-status": item.status,
        "data-state": item.state,
        "data-streaming": item.streaming ? "true" : undefined,
        "data-context-event-id": item.contextEventId,
      },
      createElement("span", { className: roomCss.avatar, "aria-hidden": "true" }, item.kind === "agent" ? "AI" : initials(author)),
      createElement("div", { className: roomCss.messageContent },
        createElement("div", { className: roomCss.messageMeta }, createElement("strong", null, author), status ? createElement("span", { className: roomCss.status }, agentStatusLabel(status, props.t)) : null),
        createElement("div", { className: roomCss.text }, item.kind === "agent"
          ? createElement(MarkdownText, { text: timelineLabel(item, props.t), streaming: item.streaming === true, labels: markdownLabels(props.t) })
          : projectUserText(timelineLabel(item, props.t), [])),
      ));
    }),
  );
}

/** Read-only room timeline; the native DSH Session owns the composer and Agent queue. */
export function DshCollabDock(props: { port?: DshCollabClientPort; fallback?: DshCollabClientSnapshot; showHeader?: boolean; workUpdates?: readonly CollabActivityItem[]; t?: CollabTranslate }): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const fallback = props.fallback ?? fallbackSnapshot;
  const snapshot = usePortSnapshot(props.port, fallback);
  const timeline = snapshot.timeline ?? [];
  return createElement("section", { className: roomCss.dock, "data-collab-room-ui": true, "data-collab-mode": snapshot.role, "data-connection": snapshot.connection, "aria-label": t("room.aria") },
    props.showHeader === false ? null : createElement("div", { className: roomCss.header },
      createElement("strong", { className: roomCss.title }, snapshot.roomTitle),
      createElement("span", { className: roomCss.badge }, t(snapshot.role === "host" ? "role.owner" : "role.participant")),
      snapshot.hostDisplayName ? createElement("span", { className: roomCss.host }, t("room.hostedBy", { name: snapshot.hostDisplayName })) : null,
      createElement("span", { className: roomCss.connection, role: "status" }, t("connection.summary", { connection: connectionLabel(snapshot.connection, t), count: snapshot.onlineCount })),
    ),
    createElement(DshCollabTimeline, {
      items: timeline,
      workUpdates: props.workUpdates,
      members: snapshot.members ?? [],
      currentMemberId: snapshot.memberId,
      t,
    }),
    props.port ? createElement(DshCollabComposer, { port: props.port, snapshot, t }) : null,
  );
}

/** Render the Session-scoped Collab Bar inside the official right Sidebar. */
function optionalService<T>(context: DshCollabClientContext, name: string): T | undefined {
  try { return context.get?.<T>(name); } catch { return undefined; }
}

function DshCollabBarPanel(props: {
  scope: CollabPanelRenderScope;
  port?: DshCollabClientPort;
  workspacePorts?: DshCollabWorkspacePorts;
  changesPort?: CollabChangesPort;
  reviewsPort?: CollabReviewsPort;
  settings?: DshCollabSettingsPort;
  panelHost?: CollabPanelHost;
  openJoinedRoom?: (room: { roomId: string; gatewayEndpoint: string; roomTitle: string; hostDisplayName?: string }) => void | Promise<void>;
  openRooms?: () => void;
  t: CollabTranslate;
}): ReactNode {
  const rememberedSelection = useDshCollabRoomSelection(props.scope.sessionId);
  const snapshot = usePortSnapshot(props.port, fallbackSnapshot);
  const selection = rememberedSelection ?? resolveDshCollabRoomSelection(props.scope.sessionId, props.settings, snapshot);
  const autoOpenKey = useRef<string>();
  useEffect(() => {
    if (!props.workspacePorts || !selection || selection.roomId !== snapshot.roomId || snapshot.connection !== "online") return;
    void props.workspacePorts.activateSession(props.scope.sessionId, selection.roomId).catch(() => undefined);
  }, [props.workspacePorts, props.scope.sessionId, selection?.roomId, snapshot.roomId, snapshot.role, snapshot.connection]);
  useEffect(() => {
    if (!selection) return;
    const selectedRole = selection.kind === "owned" ? "host" : "participant";
    const activeRoom = snapshot.roomId === selection.roomId && snapshot.role === selectedRole;
    if (activeRoom && snapshot.connection !== "offline") return;
    const key = `${props.scope.sessionId}:${selection.kind}:${selection.roomId}`;
    if (autoOpenKey.current === key) return;
    autoOpenKey.current = key;
    let cancelled = false;
    void (async () => {
      try {
        if (selection.kind === "owned" && props.settings) {
          const room = props.settings.getOwnedRooms?.().find((candidate) => candidate.roomId === selection.roomId);
          if (!room) return;
          if (room.sharing) {
            if (!props.settings.bootstrap) throw new Error("Owned room connection is unavailable");
            await props.settings.bootstrap(room.roomId);
          } else {
            await shareDshCollabOwnedRoom(props.settings, { roomId: room.roomId, hostSessionId: room.hostSessionId, title: room.title });
          }
        } else if (selection.kind === "joined" && props.openJoinedRoom) {
          await props.openJoinedRoom(selection);
        }
      } catch {
        if (!cancelled) autoOpenKey.current = undefined;
      }
    })();
    return () => { cancelled = true; };
  }, [props.openJoinedRoom, props.scope.sessionId, props.settings, selection, snapshot.connection, snapshot.roomId]);
  const roomKey = selection ? `${props.scope.sessionId}:${selection.kind}:${selection.roomId}` : `${props.scope.sessionId}:empty`;
  const activityItems = projectCollabActivity((snapshot.roomEvents ?? []).filter((event) => event.type === "work-update.published"));
  return createElement(CollabBarView, {
    key: roomKey,
    scope: props.scope,
    selection,
    roomSnapshot: snapshot,
    discussion: createElement(DshCollabDock, { port: props.port, fallback: snapshot, showHeader: false, workUpdates: activityItems, t: props.t }),
    onOpenRooms: props.openRooms,
    ...(props.changesPort ? { changesPort: props.changesPort } : {}),
    ...(props.reviewsPort ? { reviewsPort: props.reviewsPort } : {}),
    t: props.t,
  });
}

function browserConfig(): { gatewayUrl: string; roomId: string; role?: "host" | "participant"; token?: string; principalId?: string } {
  return { gatewayUrl: `http://127.0.0.1:${String(defaultCollabSettings.gatewayPort)}/collab`, roomId: "dsh-room" };
}

/** Register additive conversation and settings contributions through real DSH slots. */
export function applyDshCollabClient(context: DshCollabClientContext): void {
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
  const connection = optionalService<{ rpc: DshClientConnectionRpc }>(context, "connection");
  const participantPersistence = connection
    ? participantScope
      ? createDshParticipantPersistence(participantScope, createDshParticipantSecretPort(connection.rpc))
      : createDshEphemeralParticipantPersistence()
    : undefined;
  const prepareParticipantPersistence = (): void => { void participantPersistence?.prepare?.().catch(() => undefined); };
  prepareParticipantPersistence();
  if (participantPersistence && participantScope && context.effect) {
    context.effect(() => participantScope.subscribe(prepareParticipantPersistence), "dsh-collab: Participant credentials");
  }
  const browserClient = existing ? undefined : createDshBrowserCollabClient({
    ...browserConfig(),
    ...(participantPersistence ? { participantPersistence } : {}),
    ...(connection ? { easyTierTransport: createDshBrowserEasyTierTransport(connection.rpc) } : {}),
  });
  const client = existing ?? browserClient;
  const rawBrowserSettings = optionalService<DshCollabSettingsPort>(context, "collabSettings") ?? browserClient?.settingsPort();
  const browserSettings = rawBrowserSettings && connection ? createDshGatewayControlPort(rawBrowserSettings, connection.rpc) : rawBrowserSettings;
  const settings = settingsScope && browserSettings ? createDshSettingsPort(settingsScope, browserSettings) : browserSettings;
  if (browserClient) context.provide?.("collabClient", browserClient);
  if (settings) context.provide?.("collabSettings", settings);
  const changesPort = optionalService<CollabChangesPort>(context, "collabChanges");
  const reviewsPort = optionalService<CollabReviewsPort>(context, "collabReviews");
  const workspaces = optionalService<DshClientWorkspaces>(context, "workspaces");
  const workspaceNavigation = optionalService<DshClientWorkspaceNavigation>(context, "uiWorkspace");
  const sessions = optionalService<DshClientSessions>(context, "sessions");
  const layout = optionalService<DshLayoutPanelPort>(context, "layout");
  const sidebarRight = optionalService<DshSidebarRightPort>(context, "sidebarRight");
  const sidebarRightTabs = optionalService<DshSidebarRightTabsPort>(context, "sidebarRightTabs");
  const panelHost = sidebarRight
    ? createOfficialCollabPanelHost(
        sidebarRight,
        workspaceNavigation ? (sessionId) => { workspaceNavigation.openSession(sessionId); } : undefined,
        layout ? (id) => { layout.selectPanel(id); } : undefined,
      )
    : undefined;
  if (panelHost) context.provide?.("collabPanelHost", panelHost);
  const createOwnedRoom = connection && workspaces && workspaceNavigation && sessions
    ? createDshOwnedRoomCreator({
        rpc: connection.rpc,
        ...(settings?.startGateway ? { startGateway: () => settings.startGateway!() } : {}),
        workspaces,
        workspaceNavigation,
        sessions,
        panelHost: () => panelHost,
        ...(settings?.refreshOwnedRooms ? { refreshOwnedRooms: () => settings.refreshOwnedRooms!() } : {}),
      })
    : undefined;
  const openWorkspace = workspaces && workspaceNavigation && sessions ? createDshParticipantWorkspaceOpener({
    workspaces,
    workspaceNavigation,
    sessions,
    panelHost: () => panelHost,
  }) : undefined;
  const openJoinedRoom = browserSettings && connection && openWorkspace
    && browserSettings.connectJoinedRoom && browserSettings.getRoomSnapshot && browserSettings.getLocalSnapshotAccess
    ? createDshJoinedRoomOpener({
        settings: browserSettings as DshJoinedRoomOpenerSettings,
        rpc: connection.rpc,
        openWorkspace,
      })
    : undefined;
  const workspacePorts = browserClient && connection ? new DshCollabWorkspacePorts({
    rpc: connection.rpc,
    source: browserClient,
    ...(openWorkspace ? { openWorkspace } : {}),
  }) : undefined;
  if (workspacePorts) {
    context.provide?.("collabWorkspacePorts", workspacePorts);
    context.effect?.(() => () => { workspacePorts.dispose(); }, "dsh-collab: workspace ports");
  }
  const roomPanel = (embedded: boolean, props: Record<string, unknown>): ReactNode => createElement(DshCollabRoomsPanel, {
    embedded,
    port: settings,
    panelHost,
    ...(createOwnedRoom ? { createOwnedRoom } : {}),
    ...(workspaceNavigation?.pickDirectory ? { pickDirectory: workspaceNavigation.pickDirectory.bind(workspaceNavigation) } : {}),
    ...(openJoinedRoom ? { openJoinedRoom } : {}),
    t: translationFor(props),
  });
  if (layout) {
    registerOfficialCollabSidebar({
      context,
      layout,
      ...(sidebarRight ? { sidebarRight } : {}),
      ...(sidebarRightTabs ? { sidebarRightTabs } : {}),
      label: fallbackT("rooms.title"),
      guideDescription: () => fallbackT("bar.guideDescription"),
      roomPanel: (embedded) => roomPanel(embedded, {}),
      rightPanel: (props: DshSidebarRightTabProps) => {
        const sessionId = props.sessionId;
        if (!sessionId) return null;
        const cwd = sessions?.list?.getSnapshot().byId[sessionId]?.cwd;
        const scope = collabPanelScopeFromTab(props, cwd);
        if (!scope) return null;
        const scoped = workspacePorts?.forSession(scope.sessionId);
        return createElement(DshCollabBarPanel, {
          scope,
          port: client,
          settings,
          panelHost,
          ...(openJoinedRoom ? { openJoinedRoom } : {}),
          openRooms: () => { openOfficialCollabRooms(layout, () => { setDshCollabRoomsOpen(true); }); },
          workspacePorts,
          changesPort: changesPort ?? scoped?.changes,
          reviewsPort: reviewsPort ?? scoped?.reviews,
          t: fallbackT,
        });
      },
    });
  } else {
    context.slots.inject("sidebar.footer.action", () => context.slots.register({ name: "sidebar.footer.action", id: "dsh-collab", order: 20, locale: COLLAB_LOCALE_NAMESPACE }, (props) => createElement(DshCollabRoomsLauncher, { wide: props.wide === true, t: translationFor(props) })));
    context.slots.inject("shell.overlay", () => context.slots.register({ name: "shell.overlay", id: "dsh-collab-rooms", order: 10, locale: COLLAB_LOCALE_NAMESPACE }, (props) => roomPanel(false, props)));
  }
  context.slots.inject("settings.plugin.item", () => context.slots.register({ name: "settings.plugin.item", key: "dsh-collab", locale: COLLAB_LOCALE_NAMESPACE }, (props) => createElement(DshCollabSettingsCard, {
    port: settings,
    t: translationFor(props),
  })));
}

/** DSH client runner entry expected by every `dsh.client` bundle. */
export { applyDshCollabClient as apply };
export { DshCollabSettingsCard } from "./collab-settings-card.js";
export { CollabActivity, projectCollabActivity } from "./collab-activity.js";
export { CollabChanges, validateCollabChangesSnapshot } from "./collab-changes.js";
export type { CollabChangesPort, CollabChangesSnapshot, CollabChangesWorkspaceSnapshot } from "./collab-changes.js";
export { CollabReviews, validateCollabReviewsSnapshot } from "./collab-reviews.js";
export type { CollabReviewItem, CollabReviewMember, CollabReviewsPort, CollabReviewsSnapshot } from "./collab-reviews.js";
export { CollabBarView, collabRoomMatchesScope, nextCollabBarTab } from "./collab-bar.js";
export type { CollabBarRoomSnapshot, CollabBarTab } from "./collab-bar.js";
export { closeDshCollabRoom, DshCollabRoomsLauncher, DshCollabRoomsPanel, openDshCollabRoom, setDshCollabRoomsOpen } from "./collab-rooms.js";
