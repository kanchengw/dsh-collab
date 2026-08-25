import { createElement, useEffect, useState, type ChangeEvent, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { ComposerTarget, TimelineItem } from "./ui.js";
import { createDshBrowserCollabClient, type DshBrowserCollabClient, type DshBrowserJoinInput, type ParticipantPersistence, type ParticipantResumeState } from "./dsh-browser-client.js";
import { DshCollabSettingsCard } from "./collab-settings-card.js";
import { normalizeAdvertisedGatewayEndpoint, normalizeGatewayEndpoint } from "./endpoint-policy.js";
import { defaultCollabSettings, DSH_COLLAB_PARTICIPANT_NAMESPACE, type DshCollabParticipantSettings, type DshCollabSecuritySettings } from "./settings-shared.js";

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

export interface DshCollabSettingsPort {
  getSnapshot(): { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; advertisedEndpoint: string; writable?: boolean } & Partial<DshCollabSecuritySettings>;
  getRoomSnapshot?(): Pick<DshCollabClientSnapshot, "roomId" | "roomTitle" | "hostDisplayName" | "role" | "connection">;
  subscribeRoom?(listener: () => void): () => void;
  subscribe?(listener: () => void): () => void;
  save(input: { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; advertisedEndpoint: string } & Partial<DshCollabSecuritySettings>): Promise<void>;
  bootstrap?(roomId?: string): Promise<void>;
  join?(input: DshBrowserJoinInput, roomId?: string): Promise<void>;
  createInvite?(input: { inviteId?: string; expiresAt: number; gatewayEndpoint: string }, roomId?: string): Promise<{ invitation: string }>;
  configureGateway?(input: { gatewayHost: string; gatewayPort: number }): void;
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
export const inject = ["slots", "settingsScope"];

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
  gateway: { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; advertisedEndpoint: string };
  security?: DshCollabSecuritySettings;
}

function decodeParticipant(value: unknown): ParticipantResumeState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if ([candidate.gatewayEndpoint, candidate.roomId, candidate.memberId, candidate.credential].some((field) => typeof field !== "string" || field.trim() === "")) return undefined;
  try { normalizeGatewayEndpoint(candidate.gatewayEndpoint as string); } catch { return undefined; }
  return candidate as unknown as ParticipantResumeState;
}

function decodePersistedSettings(value: unknown): PersistedCollabSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const gateway = (value as { gateway?: unknown }).gateway;
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) return undefined;
  const candidate = gateway as Record<string, unknown>;
  if ((candidate.gatewayHost !== "127.0.0.1" && candidate.gatewayHost !== "0.0.0.0")
    || !Number.isSafeInteger(candidate.gatewayPort) || (candidate.gatewayPort as number) < 1 || (candidate.gatewayPort as number) > 65535
    || (candidate.exposeMode !== "loopback" && candidate.exposeMode !== "network")) return undefined;
  const advertisedEndpoint = typeof candidate.advertisedEndpoint === "string" ? candidate.advertisedEndpoint : "";
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
  return { gateway: { ...candidate as Omit<PersistedCollabSettings["gateway"], "advertisedEndpoint">, advertisedEndpoint }, security: normalized };
}

function decodeParticipantSettings(value: unknown): DshCollabParticipantSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const resume = decodeParticipant((value as { resume?: unknown }).resume);
  return resume ? { resume } : {};
}

export function createDshParticipantPersistence(scope: DshSettingsScope<DshCollabParticipantSettings>): ParticipantPersistence {
  return {
    load: () => scope.getSnapshot().value?.resume,
    save: async (state) => {
      const current = scope.getSnapshot();
      if (current.status !== "ready" || !current.writable) throw new Error("DSH settings are not writable");
      await scope.set("resume", state);
      const saved = scope.getSnapshot().value?.resume;
      if (!saved || saved.credential !== state.credential || saved.roomId !== state.roomId || saved.memberId !== state.memberId || saved.gatewayEndpoint !== state.gatewayEndpoint) {
        throw new Error("Participant resume credential was not persisted by DSH");
      }
    },
    clear: async () => { await scope.unset("resume"); },
  };
}

export function createDshSettingsPort(scope: DshSettingsScope<PersistedCollabSettings>, actions: DshCollabSettingsPort): DshCollabSettingsPort {
  const syncGateway = (): void => {
    const gateway = scope.getSnapshot().value?.gateway;
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
    join: actions.join?.bind(actions),
    createInvite: actions.createInvite?.bind(actions),
    configureGateway: actions.configureGateway?.bind(actions),
    getRoomSnapshot: actions.getRoomSnapshot?.bind(actions),
    subscribeRoom: actions.subscribeRoom?.bind(actions),
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
  if (props.items.length === 0) return createElement("p", { className: "dsh-collab-timeline__empty" }, "No room messages yet");
  return createElement("div", { className: "dsh-collab-timeline", "data-collab-timeline": true, "aria-live": "polite" },
    props.items.map((item) => createElement("article", {
      key: item.eventId,
      className: "dsh-collab-timeline__item",
      "data-kind": item.kind,
      "data-status": item.status,
      "data-state": item.state,
    },
    createElement("small", null, item.kind === "human" ? item.authorMemberId : "Host Agent"),
    createElement("p", null, timelineLabel(item)))),
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
  return createElement("section", { className: "dsh-collab-dock", "data-collab-mode": snapshot.role, "data-connection": snapshot.connection, "aria-label": "dsh-collab room" },
    createElement("div", { className: "dsh-collab-dock__identity" },
      createElement("strong", null, snapshot.roomTitle),
      createElement("span", { className: "dsh-collab-dock__badge" }, snapshot.role === "host" ? "Host" : "Participant"),
      snapshot.hostDisplayName ? createElement("span", null, `Hosted by ${snapshot.hostDisplayName}`) : null,
      createElement("span", { className: "dsh-collab-dock__connection", role: "status" }, `${snapshot.connection} · ${String(snapshot.memberCount)} members`),
    ),
    createElement(DshCollabTimeline, { items: snapshot.timeline ?? [] }),
    createElement("form", { onSubmit: submit },
      createElement("label", null, "Send to ", createElement("select", { value: selectedTarget, onChange: (event: ChangeEvent<HTMLSelectElement>) => setTarget(event.target.value as ComposerTarget), name: "collab-target" }, [option("room", selectedTarget), option("dsh", selectedTarget), canSteer ? option("dsh-steer", selectedTarget) : null])),
      createElement("textarea", { value: draft, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value), name: "collab-text", placeholder: "Message the room or ask the Host Agent", rows: 2 }),
      createElement("button", { type: "submit", disabled: !props.port || draft.trim() === "" }, "Send"),
    ),
    error ? createElement("p", { role: "alert" }, error) : null,
  );
}

const participantOverlayStyle: CSSProperties = {
  position: "fixed",
  right: "1.25rem",
  bottom: "1.25rem",
  zIndex: 40,
  width: "min(26rem, calc(100vw - 2rem))",
  maxHeight: "min(42rem, calc(100vh - 2rem))",
  overflow: "auto",
  pointerEvents: "auto",
  border: "1px solid rgba(27, 35, 30, 0.16)",
  borderRadius: "1rem",
  background: "linear-gradient(145deg, #fffdf7 0%, #f2f7ef 100%)",
  boxShadow: "0 1.25rem 4rem rgba(20, 31, 24, 0.22)",
  padding: "0.85rem",
  color: "#17211b",
};

/** Root-scoped Participant room surface; it does not require a local DSH session. */
export function DshCollabParticipantOverlay(props: { port?: DshCollabClientPort; fallback?: DshCollabClientSnapshot }): ReactNode {
  const snapshot = usePortSnapshot(props.port, props.fallback ?? fallbackSnapshot);
  const [collapsed, setCollapsed] = useState(false);
  if (snapshot.role !== "participant" || snapshot.connection === "offline") return null;
  if (collapsed) return createElement("button", {
    type: "button",
    onClick: () => setCollapsed(false),
    "aria-label": "Open collaboration room",
    style: { ...participantOverlayStyle, width: "auto", borderRadius: "999px", padding: "0.65rem 0.9rem" },
  }, `Collab · ${snapshot.connection}`);
  return createElement("aside", { style: participantOverlayStyle, "data-collab-surface": "participant-overlay", "aria-label": "Participant collaboration room" },
    createElement("button", {
      type: "button",
      onClick: () => setCollapsed(true),
      "aria-label": "Minimize collaboration room",
      style: { float: "right" },
    }, "Minimize"),
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
  const participantScope = optionalService<DshSettingsScopeBinder>(context, "settingsScope")?.bind<DshCollabParticipantSettings>({ namespace: DSH_COLLAB_PARTICIPANT_NAMESPACE, decode: decodeParticipantSettings });
  const browserClient = existing ? undefined : createDshBrowserCollabClient({ ...browserConfig(), ...(participantScope ? { participantPersistence: createDshParticipantPersistence(participantScope) } : {}) });
  const client = existing ?? browserClient;
  const browserSettings = optionalService<DshCollabSettingsPort>(context, "collabSettings") ?? browserClient?.settingsPort();
  const settings = settingsScope && browserSettings ? createDshSettingsPort(settingsScope, browserSettings) : browserSettings;
  if (browserClient) context.provide?.("collabClient", browserClient);
  if (settings) context.provide?.("collabSettings", settings);
  if (browserClient && participantScope) {
    let attempted = false;
    let unsubscribe = (): void => {};
    const restore = (): void => {
      if (attempted || participantScope.getSnapshot().status !== "ready") return;
      attempted = true;
      unsubscribe();
      void browserClient.restoreParticipant().catch(() => undefined);
    };
    unsubscribe = participantScope.subscribe(restore);
    restore();
  }
  context.slots.inject("conversation.input.dock", () => context.slots.register({ name: "conversation.input.dock", id: "collab", order: 5 }, () => createElement(DshCollabDock, { port: client })));
  context.slots.inject("shell.overlay", () => context.slots.register({ name: "shell.overlay", id: "dsh-collab", order: 10 }, () => createElement(DshCollabParticipantOverlay, { port: client })));
  context.slots.inject("settings.plugin.item", () => context.slots.register({ name: "settings.plugin.item", key: "dsh-collab" }, () => createElement(DshCollabSettingsCard, { port: settings })));
}

/** DSH client runner entry expected by every `dsh.client` bundle. */
export { applyDshCollabClient as apply };
export { DshCollabSettingsCard } from "./collab-settings-card.js";
