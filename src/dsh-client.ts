import { createElement, useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import type { ComposerTarget, TimelineItem } from "./ui.js";
import { createDshBrowserCollabClient, type DshBrowserCollabClient, type DshBrowserJoinInput, type JoinedRoomRef, type ParticipantPersistence, type ParticipantResumeState } from "./dsh-browser-client.js";
import { DshCollabSettingsCard } from "./collab-settings-card.js";
import { DshCollabRoomsLauncher, DshCollabRoomsPanel } from "./collab-rooms.js";
import { normalizeAdvertisedGatewayEndpoint, normalizeGatewayEndpoint } from "./endpoint-policy.js";
import { defaultCollabSettings, DSH_COLLAB_PARTICIPANT_NAMESPACE, type DshCollabParticipantSettings, type DshCollabSecuritySettings } from "./settings-shared.js";
import { COLLAB_LOCALE_NAMESPACE, defaultCollabTranslate, en, zh, type CollabLocaleKey, type CollabTranslate } from "./locales.js";
import roomCss from "./collab-room.module.css";

export interface DshCollabClientSnapshot {
  roomId: string;
  roomTitle: string;
  hostDisplayName: string;
  role: "host" | "participant";
  connection: "connecting" | "online" | "offline";
  onlineCount: number;
  canSteer: boolean;
  timeline?: readonly TimelineItem[];
}

export interface DshCollabClientPort {
  getSnapshot(): DshCollabClientSnapshot;
  subscribe(listener: () => void): () => void;
  send(input: { text: string; target: ComposerTarget }): Promise<void>;
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
  getRoomSnapshot?(): Pick<DshCollabClientSnapshot, "roomId" | "roomTitle" | "hostDisplayName" | "role" | "connection">;
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
}

/** DSH client runner service required by this browser contribution. */
export const inject = ["slots", "settingsScope", "connection", "sessions", "locale"];

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
    tokenTtlMs: security.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs,
    approvalPolicy: security.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
    maxMembers: security.maxMembers ?? defaultCollabSettings.maxMembers,
    maxMessageBytes: security.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
    maxQueue: security.maxQueue ?? defaultCollabSettings.maxQueue,
  };
  return { gateway, ...(appliedGateway ? { appliedGateway } : {}), security: normalized };
}

export function decodeDshParticipantSettings(value: unknown): DshCollabParticipantSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const joinedRooms = Array.isArray((value as { joinedRooms?: unknown }).joinedRooms)
    ? (value as { joinedRooms: unknown[] }).joinedRooms.map(decodeParticipant).filter((room): room is ParticipantResumeState => room !== undefined)
    : [];
  const resume = decodeParticipant((value as { resume?: unknown }).resume);
  if (resume && !joinedRooms.some((room) => room.gatewayEndpoint === resume.gatewayEndpoint && room.roomId === resume.roomId)) joinedRooms.push(resume);
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
      const rooms = list();
      const index = rooms.findIndex((room) => sameRoom(room, state));
      if (index === -1) rooms.push(state); else rooms[index] = state;
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
  return Object.assign(base, {
    getGatewaySnapshot: () => gateway,
    subscribeGateway: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshGateway: () => call("gateway/status"),
    startGateway: async () => { publish({ status: "starting" }); const result = await call("gateway/start"); await refreshOwnedRooms(); return result; },
    stopGateway: async () => { const result = await call("gateway/stop"); await refreshOwnedRooms(); return result; },
    getOwnedRooms: () => ownedRooms,
    subscribeOwnedRooms: (listener: () => void) => { roomListeners.add(listener); return () => { roomListeners.delete(listener); }; },
    refreshOwnedRooms,
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
        tokenTtlMs: persisted.security?.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs,
        approvalPolicy: persisted.security?.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
        maxMembers: persisted.security?.maxMembers ?? defaultCollabSettings.maxMembers,
        maxMessageBytes: persisted.security?.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
        maxQueue: persisted.security?.maxQueue ?? defaultCollabSettings.maxQueue,
      };
      const fallback = actions.getSnapshot();
      return {
        ...fallback,
        writable: scopeSnapshot.writable,
        tokenTtlMs: fallback.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs,
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
      if (input.advertisedEndpoint === "" && input.exposeMode === "network") throw new Error("advertisedEndpoint is required in network mode");
      const advertisedEndpoint = input.advertisedEndpoint === "" ? "" : normalizeAdvertisedGatewayEndpoint(input.advertisedEndpoint, input.exposeMode);
      const security = {
        tokenTtlMs: input.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs,
        approvalPolicy: input.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
        maxMembers: input.maxMembers ?? defaultCollabSettings.maxMembers,
        maxMessageBytes: input.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
        maxQueue: input.maxQueue ?? defaultCollabSettings.maxQueue,
      };
      if (!Number.isSafeInteger(security.tokenTtlMs) || security.tokenTtlMs < 1) throw new Error("tokenTtlMs must be positive");
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

function option(target: ComposerTarget, selected: ComposerTarget, t: CollabTranslate, disabled = false): ReactNode {
  const label = t(target === "room" ? "composer.people" : target === "dsh" ? "composer.dshAgent" : "composer.steerAgent");
  return createElement("option", { key: target, value: target, disabled }, label);
}

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
  if (item.kind === "agent") return t("room.agentRequest", { status: agentStatusLabel(item.status ?? item.state ?? "updated", t) });
  return t("room.message");
}

function DshCollabTimeline(props: { items: readonly TimelineItem[]; t: CollabTranslate }): ReactNode {
  if (props.items.length === 0) return createElement("p", { className: roomCss.empty }, props.t("room.noMessages"));
  return createElement("div", { className: roomCss.timeline, "data-collab-timeline": true, "aria-live": "polite" },
    props.items.map((item) => createElement("article", {
      key: item.eventId,
      className: roomCss.message,
      "data-kind": item.kind,
      "data-status": item.status,
      "data-state": item.state,
    },
    createElement("small", { className: roomCss.author }, item.kind === "human" ? item.authorMemberId : props.t("room.hostAgent")),
    createElement("p", { className: roomCss.text }, timelineLabel(item, props.t)),
    item.kind === "agent" ? createElement("span", { className: roomCss.status }, agentStatusLabel(item.status ?? item.state ?? "", props.t)) : null)),
  );
}

/** Additive composer dock rendered inside DSH's native conversation surface. */
export function DshCollabDock(props: { port?: DshCollabClientPort; fallback?: DshCollabClientSnapshot; t?: CollabTranslate }): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const fallback = props.fallback ?? fallbackSnapshot;
  const snapshot = usePortSnapshot(props.port, fallback);
  const [target, setTarget] = useState<ComposerTarget>("room");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string>();
  const canSteer = snapshot.role === "host" && snapshot.canSteer;
  const selectedTarget = canSteer || target !== "dsh-steer" ? target : "dsh";
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!props.port || draft.trim() === "") return;
    try {
      setError(undefined);
      await props.port.send({ text: draft.trim(), target: selectedTarget });
      setDraft("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("composer.sendError"));
    }
  };
  return createElement("section", { className: roomCss.dock, "data-collab-room-ui": true, "data-collab-mode": snapshot.role, "data-connection": snapshot.connection, "aria-label": t("room.aria") },
    createElement("div", { className: roomCss.header },
      createElement("strong", { className: roomCss.title }, snapshot.roomTitle),
      createElement("span", { className: roomCss.badge }, t(snapshot.role === "host" ? "role.owner" : "role.participant")),
      snapshot.hostDisplayName ? createElement("span", { className: roomCss.host }, t("room.hostedBy", { name: snapshot.hostDisplayName })) : null,
      createElement("span", { className: roomCss.connection, role: "status" }, t("connection.summary", { connection: connectionLabel(snapshot.connection, t), count: snapshot.onlineCount })),
    ),
    createElement(DshCollabTimeline, { items: snapshot.timeline ?? [], t }),
    createElement("form", { className: roomCss.composer, onSubmit: submit },
      createElement("label", { className: roomCss.targetLabel }, t("composer.sendTo"), createElement("select", { className: roomCss.select, value: selectedTarget, onChange: (event: ChangeEvent<HTMLSelectElement>) => setTarget(event.target.value as ComposerTarget), name: "collab-target" }, [option("room", selectedTarget, t), option("dsh", selectedTarget, t), canSteer ? option("dsh-steer", selectedTarget, t) : null])),
      createElement("textarea", { className: roomCss.textarea, value: draft, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value), name: "collab-text", "aria-label": t("composer.messageAria"), placeholder: t("composer.placeholder"), rows: 1 }),
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

/** Session-scoped Host controls; the room identity is always the current DSH session. */
export function DshCollabSessionDock(props: {
  sessionId: string;
  defaultRoomName: string;
  port?: DshCollabClientPort;
  settingsPort?: DshCollabSettingsPort;
  fallback?: DshCollabClientSnapshot;
  t?: CollabTranslate;
}): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const snapshot = usePortSnapshot(props.port, props.fallback ?? fallbackSnapshot);
  const settings = useSettingsSnapshot(props.settingsPort);
  const gateway = useGatewaySnapshot(props.settingsPort);
  const [roomName, setRoomName] = useState(props.defaultRoomName);
  const [invitation, setInvitation] = useState("");
  const [busy, setBusy] = useState<"share" | "stop" | "invite" | "copy">();
  const [notice, setNotice] = useState<{ tone: "error" | "success"; text: string }>();
  useEffect(() => {
    setRoomName(props.defaultRoomName);
    setInvitation("");
    setNotice(undefined);
  }, [props.sessionId]);

  if (snapshot.role === "participant" && snapshot.connection !== "offline") return null;
  const hosted = snapshot.role === "host" && snapshot.roomId === props.sessionId && snapshot.connection !== "offline";
  const appliedGateway = settings?.appliedGateway ?? settings;
  const gatewayEndpoint = appliedGateway?.advertisedEndpoint ?? "";
  const submitShare = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!props.settingsPort?.shareHostRoom || roomName.trim() === "") return;
    setBusy("share");
    setNotice(undefined);
    try {
      if (gateway.status !== "running") await props.settingsPort.startGateway?.();
      await props.settingsPort.shareHostRoom({ sessionId: props.sessionId, title: roomName.trim() });
      setRoomName(roomName.trim());
      setNotice({ tone: "success", text: t(hosted ? "share.nameUpdatedNotice" : "share.startedNotice") });
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : t("share.startError") });
    } finally {
      setBusy(undefined);
    }
  };
  const createInvitation = async (): Promise<void> => {
    if (!props.settingsPort?.createInvite || gatewayEndpoint === "") return;
    setBusy("invite");
    setNotice(undefined);
    try {
      const created = await props.settingsPort.createInvite({ expiresAt: Date.now() + 60 * 60 * 1000, gatewayEndpoint }, props.sessionId);
      setInvitation(created.invitation);
      setNotice({ tone: "success", text: t("share.invitationCreatedNotice") });
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : t("share.invitationError") });
    } finally {
      setBusy(undefined);
    }
  };
  const stopSharing = async (): Promise<void> => {
    if (!props.settingsPort?.stopSharing) return;
    setBusy("stop");
    setNotice(undefined);
    try {
      await props.settingsPort.stopSharing(props.sessionId);
      setInvitation("");
      setNotice({ tone: "success", text: t("share.stoppedNotice") });
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : t("share.stopError") });
    } finally {
      setBusy(undefined);
    }
  };
  const copyInvitation = async (): Promise<void> => {
    setBusy("copy");
    setNotice(undefined);
    try {
      await navigator.clipboard.writeText(invitation);
      setNotice({ tone: "success", text: t("share.copiedNotice") });
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : t("share.copyError") });
    } finally {
      setBusy(undefined);
    }
  };

  return createElement("div", { "data-collab-session-id": props.sessionId },
    createElement("section", { className: roomCss.sharePanel, "aria-label": t("share.aria") },
      createElement("form", { className: roomCss.shareForm, onSubmit: submitShare },
        createElement("label", { className: roomCss.shareField, htmlFor: `collab-room-name-${props.sessionId}` },
          createElement("span", null, t("share.roomName")),
          createElement("input", { id: `collab-room-name-${props.sessionId}`, name: "roomName", className: roomCss.roomName, value: roomName, maxLength: 80, onChange: (event: ChangeEvent<HTMLInputElement>) => setRoomName(event.target.value) }),
        ),
        createElement("button", { className: roomCss.shareButton, type: "submit", disabled: !props.settingsPort?.shareHostRoom || busy !== undefined || roomName.trim() === "" }, t(busy === "share" ? "share.sharing" : hosted ? "share.updateRoom" : gateway.status === "running" ? "share.shareSession" : "share.startAndShare")),
      ),
      hosted ? createElement("div", { className: roomCss.inviteControls },
        createElement("button", { className: roomCss.inviteButton, type: "button", onClick: () => { void createInvitation(); }, disabled: !props.settingsPort?.createInvite || gatewayEndpoint === "" || busy !== undefined }, t(busy === "invite" ? "share.creating" : "share.createInvitation")),
        createElement("button", { className: roomCss.inviteButton, type: "button", onClick: () => { void stopSharing(); }, disabled: !props.settingsPort?.stopSharing || busy !== undefined }, t(busy === "stop" ? "share.stopping" : "share.stopSharing")),
        gatewayEndpoint === "" ? createElement("span", { className: roomCss.shareHint }, t("share.configureEndpoint")) : null,
        invitation ? createElement("div", { className: roomCss.invitation },
          createElement("textarea", { name: "hostInvitationOutput", value: invitation, readOnly: true, rows: 3, "aria-label": t("share.invitationAria"), className: roomCss.invitationText }),
          createElement("button", { className: roomCss.inviteButton, type: "button", onClick: () => { void copyInvitation(); }, disabled: busy !== undefined }, t(busy === "copy" ? "share.copying" : "share.copyInvitation")),
        ) : null,
      ) : null,
      notice ? createElement("p", { className: notice.tone === "error" ? roomCss.error : roomCss.success, role: notice.tone === "error" ? "alert" : "status" }, notice.text) : null,
    ),
    hosted ? createElement(DshCollabDock, { port: props.port, fallback: snapshot, t }) : null,
  );
}

/** Root-scoped Participant room surface; it does not require a local DSH session. */
export function DshCollabParticipantOverlay(props: { port?: DshCollabClientPort; fallback?: DshCollabClientSnapshot; t?: CollabTranslate }): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const snapshot = usePortSnapshot(props.port, props.fallback ?? fallbackSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  if (snapshot.role !== "participant" || snapshot.connection === "offline") return null;
  if (collapsed) return createElement("button", {
    type: "button",
    onClick: () => setCollapsed(false),
    "aria-label": t("participant.open"),
    className: roomCss.collapsed,
  }, `Collab · ${t(snapshot.connection === "connecting" ? "connection.connecting" : "connection.online")}`);
  return createElement("aside", { className: roomCss.overlay, "data-collab-room-ui": true, "data-collab-surface": "participant-overlay", "aria-label": t("participant.aria") },
    createElement("div", { className: roomCss.overlayBar },
      createElement("span", null, t("participant.remoteRoom")),
      createElement("button", { type: "button", onClick: () => setCollapsed(true), "aria-label": t("participant.minimizeAria"), className: roomCss.minimize }, t("participant.minimize")),
    ),
    createElement(DshCollabDock, { port: props.port, fallback: snapshot, t }),
  );
}

function optionalService<T>(context: DshCollabClientContext, name: string): T | undefined {
  try { return context.get?.<T>(name); } catch { return undefined; }
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
  const browserClient = existing ? undefined : createDshBrowserCollabClient({ ...browserConfig(), ...(participantScope ? { participantPersistence: createDshParticipantPersistence(participantScope) } : {}) });
  const client = existing ?? browserClient;
  const rawBrowserSettings = optionalService<DshCollabSettingsPort>(context, "collabSettings") ?? browserClient?.settingsPort();
  const connection = optionalService<{ rpc: DshClientConnectionRpc }>(context, "connection");
  const browserSettings = rawBrowserSettings && connection ? createDshGatewayControlPort(rawBrowserSettings, connection.rpc) : rawBrowserSettings;
  const settings = settingsScope && browserSettings ? createDshSettingsPort(settingsScope, browserSettings) : browserSettings;
  const sessions = optionalService<{ open(sessionId: string): void }>(context, "sessions");
  if (browserClient) context.provide?.("collabClient", browserClient);
  if (settings) context.provide?.("collabSettings", settings);
  context.slots.inject("conversation.input.dock", () => context.slots.register({
    name: "conversation.input.dock",
    id: "collab",
    order: 5,
    locale: COLLAB_LOCALE_NAMESPACE,
    inject: (sessionId: string) => ({ collabSessionId: sessionId }),
  }, (props) => {
    const sessionId = String(props.collabSessionId ?? props.sessionId ?? "");
    const useSessions = props.useSessions as undefined | (<T>(selector: (state: { byId: Record<string, { displayTitle: string }> }) => T) => T);
    const defaultRoomName = useSessions ? useSessions((state) => state.byId[sessionId]?.displayTitle ?? sessionId) : sessionId;
    return createElement(DshCollabSessionDock, { key: sessionId, sessionId, defaultRoomName, port: client, settingsPort: settings, t: translationFor(props) });
  }));
  context.slots.inject("sidebar.footer.action", () => context.slots.register({ name: "sidebar.footer.action", id: "dsh-collab", order: 20, locale: COLLAB_LOCALE_NAMESPACE }, (props) => createElement(DshCollabRoomsLauncher, { wide: props.wide === true, t: translationFor(props) })));
  context.slots.inject("shell.overlay", () => context.slots.register({ name: "shell.overlay", id: "dsh-collab-rooms", order: 10, locale: COLLAB_LOCALE_NAMESPACE }, (props) => createElement(DshCollabRoomsPanel, { port: settings, openSession: sessions?.open.bind(sessions), t: translationFor(props) })));
  context.slots.inject("shell.overlay", () => context.slots.register({ name: "shell.overlay", id: "dsh-collab-participant", order: 20, locale: COLLAB_LOCALE_NAMESPACE }, (props) => createElement(DshCollabParticipantOverlay, { port: client, t: translationFor(props) })));
  context.slots.inject("settings.plugin.item", () => context.slots.register({ name: "settings.plugin.item", key: "dsh-collab", locale: COLLAB_LOCALE_NAMESPACE }, (props) => createElement(DshCollabSettingsCard, { port: settings, t: translationFor(props) })));
}

/** DSH client runner entry expected by every `dsh.client` bundle. */
export { applyDshCollabClient as apply };
export { DshCollabSettingsCard } from "./collab-settings-card.js";
export { DshCollabRoomsLauncher, DshCollabRoomsPanel, setDshCollabRoomsOpen } from "./collab-rooms.js";
