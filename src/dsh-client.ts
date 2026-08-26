import { createElement, useEffect, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import type { ComposerTarget, TimelineItem } from "./ui.js";
import { createDshBrowserCollabClient, type DshBrowserCollabClient, type DshBrowserJoinInput, type JoinedRoomRef, type ParticipantPersistence, type ParticipantResumeState } from "./dsh-browser-client.js";
import { DshCollabSettingsCard } from "./collab-settings-card.js";
import { normalizeAdvertisedGatewayEndpoint, normalizeGatewayEndpoint } from "./endpoint-policy.js";
import { defaultCollabSettings, DSH_COLLAB_PARTICIPANT_NAMESPACE, type DshCollabParticipantSettings, type DshCollabSecuritySettings } from "./settings-shared.js";
import roomCss from "./collab-room.module.css";

export interface DshCollabClientSnapshot {
  roomId: string;
  roomTitle: string;
  hostDisplayName: string;
  role: "host" | "participant";
  connection: "connecting" | "online" | "offline";
  memberCount: number;
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
  get?<T = unknown>(name: string): T;
  provide?<T = unknown>(name: string, value: T): unknown;
}

/** DSH client runner service required by this browser contribution. */
export const inject = ["slots", "settingsScope", "connection"];

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

export function createDshGatewayControlPort(base: DshCollabSettingsPort, rpc: DshClientConnectionRpc): DshCollabSettingsPort {
  let gateway: DshCollabGatewayRuntimeSnapshot = { status: "stopped" };
  const listeners = new Set<() => void>();
  const publish = (next: DshCollabGatewayRuntimeSnapshot): DshCollabGatewayRuntimeSnapshot => {
    gateway = next;
    for (const listener of listeners) listener();
    return next;
  };
  const call = async (endpoint: string): Promise<DshCollabGatewayRuntimeSnapshot> => {
    return publish(decodeGatewayRuntimeResult(await rpc.call("/dsh-collab", endpoint, {})));
  };
  return {
    ...base,
    getGatewaySnapshot: () => gateway,
    subscribeGateway: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refreshGateway: () => call("gateway/status"),
    startGateway: async () => { publish({ status: "starting" }); return await call("gateway/start"); },
    stopGateway: () => call("gateway/stop"),
  };
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
    shareHostRoom: actions.shareHostRoom?.bind(actions),
    stopSharing: actions.stopSharing?.bind(actions),
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
  memberCount: 0,
  canSteer: false,
};

function option(target: ComposerTarget, selected: ComposerTarget, disabled = false): ReactNode {
  const label = target === "room" ? "People" : target === "dsh" ? "DSH Agent" : "Steer Agent";
  return createElement("option", { key: target, value: target, disabled }, label);
}

function timelineLabel(item: TimelineItem): string {
  if (item.text) return item.text;
  if (item.kind === "agent") return `Agent request ${item.status ?? item.state ?? "updated"}`;
  return "Room message";
}

function DshCollabTimeline(props: { items: readonly TimelineItem[] }): ReactNode {
  if (props.items.length === 0) return createElement("p", { className: roomCss.empty }, "No room messages yet");
  return createElement("div", { className: roomCss.timeline, "data-collab-timeline": true, "aria-live": "polite" },
    props.items.map((item) => createElement("article", {
      key: item.eventId,
      className: roomCss.message,
      "data-kind": item.kind,
      "data-status": item.status,
      "data-state": item.state,
    },
    createElement("small", { className: roomCss.author }, item.kind === "human" ? item.authorMemberId : "Host Agent"),
    createElement("p", { className: roomCss.text }, timelineLabel(item)),
    item.kind === "agent" ? createElement("span", { className: roomCss.status }, item.status ?? item.state ?? "") : null)),
  );
}

/** Additive composer dock rendered inside DSH's native conversation surface. */
export function DshCollabDock(props: { port?: DshCollabClientPort; fallback?: DshCollabClientSnapshot }): ReactNode {
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
      setError(cause instanceof Error ? cause.message : "Unable to send collaboration message");
    }
  };
  return createElement("section", { className: roomCss.dock, "data-collab-room-ui": true, "data-collab-mode": snapshot.role, "data-connection": snapshot.connection, "aria-label": "dsh-collab room" },
    createElement("div", { className: roomCss.header },
      createElement("strong", { className: roomCss.title }, snapshot.roomTitle),
      createElement("span", { className: roomCss.badge }, snapshot.role === "host" ? "Host" : "Participant"),
      snapshot.hostDisplayName ? createElement("span", { className: roomCss.host }, `Hosted by ${snapshot.hostDisplayName}`) : null,
      createElement("span", { className: roomCss.connection, role: "status" }, `${snapshot.connection} · ${String(snapshot.memberCount)} members`),
    ),
    createElement(DshCollabTimeline, { items: snapshot.timeline ?? [] }),
    createElement("form", { className: roomCss.composer, onSubmit: submit },
      createElement("label", { className: roomCss.targetLabel }, "Send to", createElement("select", { className: roomCss.select, value: selectedTarget, onChange: (event: ChangeEvent<HTMLSelectElement>) => setTarget(event.target.value as ComposerTarget), name: "collab-target" }, [option("room", selectedTarget), option("dsh", selectedTarget), canSteer ? option("dsh-steer", selectedTarget) : null])),
      createElement("textarea", { className: roomCss.textarea, value: draft, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value), name: "collab-text", "aria-label": "Collaboration message", placeholder: "Message people or ask the Host Agent", rows: 1 }),
      createElement("button", { className: roomCss.send, type: "submit", disabled: !props.port || draft.trim() === "" }, "Send"),
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

/** Session-scoped Host controls; the room identity is always the current DSH session. */
export function DshCollabSessionDock(props: {
  sessionId: string;
  defaultRoomName: string;
  port?: DshCollabClientPort;
  settingsPort?: DshCollabSettingsPort;
  fallback?: DshCollabClientSnapshot;
}): ReactNode {
  const snapshot = usePortSnapshot(props.port, props.fallback ?? fallbackSnapshot);
  const settings = useSettingsSnapshot(props.settingsPort);
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
      await props.settingsPort.shareHostRoom({ sessionId: props.sessionId, title: roomName.trim() });
      setRoomName(roomName.trim());
      setNotice({ tone: "success", text: hosted ? "Room name updated." : "This session is now shared." });
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : "Unable to share this session" });
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
      setNotice({ tone: "success", text: "One-use invitation created for the next hour." });
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : "Unable to create an invitation" });
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
      setNotice({ tone: "success", text: "Sharing stopped. The room and its history are saved." });
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : "Unable to stop sharing" });
    } finally {
      setBusy(undefined);
    }
  };
  const copyInvitation = async (): Promise<void> => {
    setBusy("copy");
    setNotice(undefined);
    try {
      await navigator.clipboard.writeText(invitation);
      setNotice({ tone: "success", text: "Invitation copied." });
    } catch (cause) {
      setNotice({ tone: "error", text: cause instanceof Error ? cause.message : "Unable to copy the invitation" });
    } finally {
      setBusy(undefined);
    }
  };

  return createElement("div", { "data-collab-session-id": props.sessionId },
    createElement("section", { className: roomCss.sharePanel, "aria-label": "Share this DSH session" },
      createElement("form", { className: roomCss.shareForm, onSubmit: submitShare },
        createElement("label", { className: roomCss.shareField, htmlFor: `collab-room-name-${props.sessionId}` },
          createElement("span", null, "Room name"),
          createElement("input", { id: `collab-room-name-${props.sessionId}`, name: "roomName", className: roomCss.roomName, value: roomName, maxLength: 80, onChange: (event: ChangeEvent<HTMLInputElement>) => setRoomName(event.target.value) }),
        ),
        createElement("button", { className: roomCss.shareButton, type: "submit", disabled: !props.settingsPort?.shareHostRoom || busy !== undefined || roomName.trim() === "" }, busy === "share" ? "Sharing…" : hosted ? "Update room" : "Share this session"),
      ),
      hosted ? createElement("div", { className: roomCss.inviteControls },
        createElement("button", { className: roomCss.inviteButton, type: "button", onClick: () => { void createInvitation(); }, disabled: !props.settingsPort?.createInvite || gatewayEndpoint === "" || busy !== undefined }, busy === "invite" ? "Creating…" : "Create invitation"),
        createElement("button", { className: roomCss.inviteButton, type: "button", onClick: () => { void stopSharing(); }, disabled: !props.settingsPort?.stopSharing || busy !== undefined }, busy === "stop" ? "Stopping…" : "Stop sharing"),
        gatewayEndpoint === "" ? createElement("span", { className: roomCss.shareHint }, "Configure a Private network or Custom WSS endpoint in Settings to invite people.") : null,
        invitation ? createElement("div", { className: roomCss.invitation },
          createElement("textarea", { name: "hostInvitationOutput", value: invitation, readOnly: true, rows: 3, "aria-label": "Invitation to share", className: roomCss.invitationText }),
          createElement("button", { className: roomCss.inviteButton, type: "button", onClick: () => { void copyInvitation(); }, disabled: busy !== undefined }, busy === "copy" ? "Copying…" : "Copy invitation"),
        ) : null,
      ) : null,
      notice ? createElement("p", { className: notice.tone === "error" ? roomCss.error : roomCss.success, role: notice.tone === "error" ? "alert" : "status" }, notice.text) : null,
    ),
    hosted ? createElement(DshCollabDock, { port: props.port, fallback: snapshot }) : null,
  );
}

/** Root-scoped Participant room surface; it does not require a local DSH session. */
export function DshCollabParticipantOverlay(props: { port?: DshCollabClientPort; fallback?: DshCollabClientSnapshot }): ReactNode {
  const snapshot = usePortSnapshot(props.port, props.fallback ?? fallbackSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  if (snapshot.role !== "participant" || snapshot.connection === "offline") return null;
  if (collapsed) return createElement("button", {
    type: "button",
    onClick: () => setCollapsed(false),
    "aria-label": "Open collaboration room",
    className: roomCss.collapsed,
  }, `Collab · ${snapshot.connection}`);
  return createElement("aside", { className: roomCss.overlay, "data-collab-room-ui": true, "data-collab-surface": "participant-overlay", "aria-label": "Participant collaboration room" },
    createElement("div", { className: roomCss.overlayBar },
      createElement("span", null, "Remote room · one Host Agent"),
      createElement("button", { type: "button", onClick: () => setCollapsed(true), "aria-label": "Minimize collaboration room", className: roomCss.minimize }, "Minimize"),
    ),
    createElement(DshCollabDock, { port: props.port, fallback: snapshot }),
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
  context.slots.inject("conversation.input.dock", () => context.slots.register({
    name: "conversation.input.dock",
    id: "collab",
    order: 5,
    inject: (sessionId: string) => ({ collabSessionId: sessionId }),
  }, (props) => {
    const sessionId = String(props.collabSessionId ?? props.sessionId ?? "");
    const useSessions = props.useSessions as undefined | (<T>(selector: (state: { byId: Record<string, { displayTitle: string }> }) => T) => T);
    const defaultRoomName = useSessions ? useSessions((state) => state.byId[sessionId]?.displayTitle ?? sessionId) : sessionId;
    return createElement(DshCollabSessionDock, { key: sessionId, sessionId, defaultRoomName, port: client, settingsPort: settings });
  }));
  context.slots.inject("shell.overlay", () => context.slots.register({ name: "shell.overlay", id: "dsh-collab", order: 10 }, () => createElement(DshCollabParticipantOverlay, { port: client })));
  context.slots.inject("settings.plugin.item", () => context.slots.register({ name: "settings.plugin.item", key: "dsh-collab" }, () => createElement(DshCollabSettingsCard, { port: settings })));
}

/** DSH client runner entry expected by every `dsh.client` bundle. */
export { applyDshCollabClient as apply };
export { DshCollabSettingsCard } from "./collab-settings-card.js";
