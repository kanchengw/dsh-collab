import { createElement, useEffect, useMemo, useState, type ChangeEvent, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { ComposerTarget, TimelineItem } from "./ui.js";
import { createDshBrowserCollabClient, type DshBrowserCollabClient, type DshBrowserJoinInput } from "./dsh-browser-client.js";
import { defaultCollabSettings, type DshCollabSecuritySettings } from "./settings.js";

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
  getSnapshot(): { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; participantGatewayUrl?: string } & Partial<DshCollabSecuritySettings>;
  subscribe?(listener: () => void): () => void;
  save(input: { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; participantGatewayUrl?: string } & Partial<DshCollabSecuritySettings>): Promise<void>;
  bootstrap?(roomId?: string): Promise<void>;
  join?(input: DshBrowserJoinInput, roomId?: string): Promise<void>;
  createInvite?(input: { inviteId: string; expiresAt: number }, roomId?: string): Promise<{ token: string }>;
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
  gateway: { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network" };
  participantGatewayUrl: string;
  security?: DshCollabSecuritySettings;
}

function decodePersistedSettings(value: unknown): PersistedCollabSettings | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const gateway = (value as { gateway?: unknown }).gateway;
  if (!gateway || typeof gateway !== "object" || Array.isArray(gateway)) return undefined;
  const candidate = gateway as Record<string, unknown>;
  if ((candidate.gatewayHost !== "127.0.0.1" && candidate.gatewayHost !== "0.0.0.0")
    || !Number.isSafeInteger(candidate.gatewayPort) || (candidate.gatewayPort as number) < 0 || (candidate.gatewayPort as number) > 65535
    || (candidate.exposeMode !== "loopback" && candidate.exposeMode !== "network")) return undefined;
  const participantGatewayUrl = (value as { participantGatewayUrl?: unknown }).participantGatewayUrl;
  if (typeof participantGatewayUrl !== "string") return undefined;
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
  return { gateway: candidate as PersistedCollabSettings["gateway"], participantGatewayUrl, security: normalized };
}

function validateParticipantGatewayUrl(value: string): void {
  if (value === "") return;
  try {
    const url = new URL(value);
    if ((url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && !url.search && !url.hash && url.pathname.replace(/\/$/, "") === "/collab") return;
  } catch { /* handled by the common validation error below */ }
  throw new Error("participantGatewayUrl must be an http(s) /collab URL without credentials, query, or fragment");
}

export function createDshSettingsPort(scope: DshSettingsScope<PersistedCollabSettings>, actions: DshCollabSettingsPort): DshCollabSettingsPort {
  return {
    getSnapshot: () => {
      const persisted = scope.getSnapshot().value;
      if (persisted) return {
        ...persisted.gateway,
        participantGatewayUrl: persisted.participantGatewayUrl,
        tokenTtlMs: persisted.security?.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs,
        approvalPolicy: persisted.security?.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
        maxMembers: persisted.security?.maxMembers ?? defaultCollabSettings.maxMembers,
        maxMessageBytes: persisted.security?.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
        maxQueue: persisted.security?.maxQueue ?? defaultCollabSettings.maxQueue,
      };
      const fallback = actions.getSnapshot();
      return {
        ...fallback,
        tokenTtlMs: fallback.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs,
        approvalPolicy: fallback.approvalPolicy ?? defaultCollabSettings.approvalPolicy,
        maxMembers: fallback.maxMembers ?? defaultCollabSettings.maxMembers,
        maxMessageBytes: fallback.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes,
        maxQueue: fallback.maxQueue ?? defaultCollabSettings.maxQueue,
      };
    },
    subscribe: (listener) => scope.subscribe(listener),
    async save(input) {
      if (!Number.isSafeInteger(input.gatewayPort) || input.gatewayPort < 0 || input.gatewayPort > 65535) throw new Error("gatewayPort must be between 0 and 65535");
      if (input.exposeMode === "loopback" && input.gatewayHost !== "127.0.0.1") throw new Error("loopback mode requires 127.0.0.1");
      if (input.exposeMode === "network" && input.gatewayHost !== "0.0.0.0") throw new Error("network mode requires 0.0.0.0");
      const participantGatewayUrl = input.participantGatewayUrl ?? "";
      validateParticipantGatewayUrl(participantGatewayUrl);
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
      await scope.set("gateway", { gatewayHost: input.gatewayHost, gatewayPort: input.gatewayPort, exposeMode: input.exposeMode });
      await scope.set("participantGatewayUrl", participantGatewayUrl);
      await scope.set("security", security);
    },
    bootstrap: actions.bootstrap?.bind(actions),
    join: actions.join?.bind(actions),
    createInvite: actions.createInvite?.bind(actions),
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

/** Settings card registered under DSH's plugin configuration tab. */
export function DshCollabSettingsCard(props: { port?: DshCollabSettingsPort }): ReactNode {
  const initial = useMemo(() => props.port?.getSnapshot() ?? { ...defaultCollabSettings }, [props.port]);
  const [host, setHost] = useState(initial.gatewayHost);
  const [port, setPort] = useState(String(initial.gatewayPort));
  const [exposeMode, setExposeMode] = useState(initial.exposeMode);
  const [participantGatewayUrl, setParticipantGatewayUrl] = useState(initial.participantGatewayUrl ?? "");
  const [tokenTtlMs, setTokenTtlMs] = useState(String(initial.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs));
  const [approvalPolicy, setApprovalPolicy] = useState(initial.approvalPolicy ?? defaultCollabSettings.approvalPolicy);
  const [maxMembers, setMaxMembers] = useState(String(initial.maxMembers ?? defaultCollabSettings.maxMembers));
  const [maxMessageBytes, setMaxMessageBytes] = useState(String(initial.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes));
  const [maxQueue, setMaxQueue] = useState(String(initial.maxQueue ?? defaultCollabSettings.maxQueue));
  const [roomId, setRoomId] = useState("");
  const [inviteId, setInviteId] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [memberId, setMemberId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<string>();
  useEffect(() => props.port?.subscribe?.(() => {
    const snapshot = props.port?.getSnapshot();
    if (!snapshot) return;
    setHost(snapshot.gatewayHost);
    setPort(String(snapshot.gatewayPort));
    setExposeMode(snapshot.exposeMode);
    setParticipantGatewayUrl(snapshot.participantGatewayUrl ?? "");
    setTokenTtlMs(String(snapshot.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs));
    setApprovalPolicy(snapshot.approvalPolicy ?? defaultCollabSettings.approvalPolicy);
    setMaxMembers(String(snapshot.maxMembers ?? defaultCollabSettings.maxMembers));
    setMaxMessageBytes(String(snapshot.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes));
    setMaxQueue(String(snapshot.maxQueue ?? defaultCollabSettings.maxQueue));
  }), [props.port]);
  const warning = exposeMode === "network" ? createElement("p", { role: "alert" }, "Anyone who can reach this address may attempt to join. Use authenticated access.") : null;
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    try {
      await props.port?.save({ gatewayHost: host, gatewayPort: Number(port), exposeMode, participantGatewayUrl, tokenTtlMs: Number(tokenTtlMs), approvalPolicy, maxMembers: Number(maxMembers), maxMessageBytes: Number(maxMessageBytes), maxQueue: Number(maxQueue) });
      setStatus("Gateway settings saved");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "Unable to save Gateway settings");
    }
  };
  const bootstrap = async (): Promise<void> => {
    if (!props.port?.bootstrap) return;
    try { await props.port.bootstrap(roomId.trim() || undefined); setStatus(`Connected to room ${roomId || "configured room"} as Host`); } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Unable to open Host room"); }
  };
  const join = async (): Promise<void> => {
    if (!props.port?.join) return;
    try {
      await props.port.join({ inviteId, inviteToken, memberId, displayName, gatewayUrl: participantGatewayUrl.trim() || undefined }, roomId.trim() || undefined);
      setStatus(`Joined room ${roomId || "configured room"} as Participant`);
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Unable to join room"); }
  };
  const createInvite = async (): Promise<void> => {
    if (!props.port?.createInvite) return;
    try {
      const result = await props.port.createInvite({ inviteId, expiresAt: Date.now() + 60 * 60 * 1000 }, roomId.trim() || undefined);
      setInviteToken(result.token);
      setStatus("Invite created; share the invite id and token");
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Unable to create invite"); }
  };
  return createElement("form", { className: "dsh-collab-settings-card", onSubmit: save, "data-settings-namespace": "dsh-collab" },
    createElement("h3", null, "dsh-collab"),
    createElement("p", null, "Configure the Host gateway used by collaboration rooms."),
    createElement("label", null, "Bind host ", createElement("select", { value: host, onChange: (event: ChangeEvent<HTMLSelectElement>) => setHost(event.target.value), name: "gatewayHost" }, createElement("option", { value: "127.0.0.1" }, "127.0.0.1 (loopback)"), createElement("option", { value: "0.0.0.0" }, "0.0.0.0 (network)"))),
    createElement("label", null, "Port ", createElement("input", { type: "number", min: 0, max: 65535, value: port, onChange: (event: ChangeEvent<HTMLInputElement>) => setPort(event.target.value), name: "gatewayPort" })),
    createElement("label", null, "Exposure ", createElement("select", { value: exposeMode, onChange: (event: ChangeEvent<HTMLSelectElement>) => setExposeMode(event.target.value as "loopback" | "network"), name: "exposeMode" }, createElement("option", { value: "loopback" }, "Loopback"), createElement("option", { value: "network" }, "Explicit network"))),
    createElement("label", null, "Participant Gateway URL ", createElement("input", { type: "url", value: participantGatewayUrl, onChange: (event: ChangeEvent<HTMLInputElement>) => setParticipantGatewayUrl(event.target.value), name: "participantGatewayUrl", placeholder: "https://host.example/collab" })),
    createElement("label", null, "Token lifetime (ms) ", createElement("input", { type: "number", min: 1, value: tokenTtlMs, onChange: (event: ChangeEvent<HTMLInputElement>) => setTokenTtlMs(event.target.value), name: "tokenTtlMs" })),
    createElement("label", null, "Approval policy ", createElement("select", { value: approvalPolicy, onChange: (event: ChangeEvent<HTMLSelectElement>) => setApprovalPolicy(event.target.value as "host-only" | "disabled"), name: "approvalPolicy" }, createElement("option", { value: "host-only" }, "Host only"), createElement("option", { value: "disabled" }, "Disabled"))),
    createElement("label", null, "Max members ", createElement("input", { type: "number", min: 1, value: maxMembers, onChange: (event: ChangeEvent<HTMLInputElement>) => setMaxMembers(event.target.value), name: "maxMembers" })),
    createElement("label", null, "Max message bytes ", createElement("input", { type: "number", min: 1, value: maxMessageBytes, onChange: (event: ChangeEvent<HTMLInputElement>) => setMaxMessageBytes(event.target.value), name: "maxMessageBytes" })),
    createElement("label", null, "Max queued Agent requests ", createElement("input", { type: "number", min: 0, value: maxQueue, onChange: (event: ChangeEvent<HTMLInputElement>) => setMaxQueue(event.target.value), name: "maxQueue" })),
    warning,
    createElement("button", { type: "submit" }, "Save"),
    createElement("fieldset", null,
      createElement("legend", null, "Room access"),
      createElement("label", null, "Room ID ", createElement("input", { value: roomId, onChange: (event: ChangeEvent<HTMLInputElement>) => setRoomId(event.target.value), name: "roomId", placeholder: "dsh-room" })),
      createElement("button", { type: "button", onClick: () => { void bootstrap(); }, disabled: !props.port?.bootstrap }, "Open Host room"),
      createElement("label", null, "Invite ID ", createElement("input", { value: inviteId, onChange: (event: ChangeEvent<HTMLInputElement>) => setInviteId(event.target.value), name: "inviteId" })),
      createElement("label", null, "Invite token ", createElement("input", { value: inviteToken, onChange: (event: ChangeEvent<HTMLInputElement>) => setInviteToken(event.target.value), name: "inviteToken" })),
      createElement("label", null, "Member ID ", createElement("input", { value: memberId, onChange: (event: ChangeEvent<HTMLInputElement>) => setMemberId(event.target.value), name: "memberId" })),
      createElement("label", null, "Display name ", createElement("input", { value: displayName, onChange: (event: ChangeEvent<HTMLInputElement>) => setDisplayName(event.target.value), name: "displayName" })),
      createElement("button", { type: "button", onClick: () => { void createInvite(); }, disabled: !props.port?.createInvite || inviteId.trim() === "" }, "Create invite"),
      createElement("button", { type: "button", onClick: () => { void join(); }, disabled: !props.port?.join || inviteId.trim() === "" || inviteToken.trim() === "" }, "Join as Participant"),
    ),
    status ? createElement("p", { role: "status" }, status) : null,
  );
}

function optionalService<T>(context: DshCollabClientContext, name: string): T | undefined {
  try { return context.get?.<T>(name); } catch { return undefined; }
}

function browserConfig(): { gatewayUrl: string; roomId: string; role?: "host" | "participant"; token?: string; principalId?: string } {
  const location = (globalThis as unknown as { location?: { origin?: string } }).location;
  const origin = location?.origin ?? "http://127.0.0.1:3080";
  return { gatewayUrl: `${origin}/collab`, roomId: "dsh-room" };
}

/** Register additive conversation and settings contributions through real DSH slots. */
export function applyDshCollabClient(context: DshCollabClientContext): void {
  const existing = optionalService<DshCollabClientPort>(context, "collabClient");
  const browserClient = existing ? undefined : createDshBrowserCollabClient(browserConfig());
  const client = existing ?? browserClient;
  const browserSettings = optionalService<DshCollabSettingsPort>(context, "collabSettings") ?? browserClient?.settingsPort();
  const settingsScope = optionalService<DshSettingsScopeBinder>(context, "settingsScope")?.bind<PersistedCollabSettings>({ namespace: "dsh-collab", decode: decodePersistedSettings });
  const settings = settingsScope && browserSettings ? createDshSettingsPort(settingsScope, browserSettings) : browserSettings;
  if (browserClient) context.provide?.("collabClient", browserClient);
  if (settings) context.provide?.("collabSettings", settings);
  context.slots.inject("conversation.input.dock", () => context.slots.register({ name: "conversation.input.dock", id: "collab", order: 5 }, () => createElement(DshCollabDock, { port: client })));
  context.slots.inject("shell.overlay", () => context.slots.register({ name: "shell.overlay", id: "dsh-collab", order: 10 }, () => createElement(DshCollabParticipantOverlay, { port: client })));
  context.slots.inject("settings.plugin.item", () => context.slots.register({ name: "settings.plugin.item", key: "dsh-collab" }, () => createElement(DshCollabSettingsCard, { port: settings })));
}

/** DSH client runner entry expected by every `dsh.client` bundle. */
export { applyDshCollabClient as apply };
