import { createElement, useEffect, useMemo, useState, type ChangeEvent, type CSSProperties, type FormEvent, type ReactNode } from "react";
import type { ComposerTarget, TimelineItem } from "./ui.js";
import { createDshBrowserCollabClient, type DshBrowserCollabClient, type DshBrowserJoinInput, type ParticipantPersistence, type ParticipantResumeState } from "./dsh-browser-client.js";
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
  getSnapshot(): { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network"; advertisedEndpoint: string } & Partial<DshCollabSecuritySettings>;
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
      const persisted = scope.getSnapshot().value;
      if (persisted) return {
        ...persisted.gateway,
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
  const [deployment, setDeployment] = useState({ gatewayHost: initial.gatewayHost, gatewayPort: initial.gatewayPort, exposeMode: initial.exposeMode });
  const [advertisedEndpoint, setAdvertisedEndpoint] = useState(initial.advertisedEndpoint);
  const [tokenTtlMs, setTokenTtlMs] = useState(String(initial.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs));
  const [approvalPolicy, setApprovalPolicy] = useState(initial.approvalPolicy ?? defaultCollabSettings.approvalPolicy);
  const [maxMembers, setMaxMembers] = useState(String(initial.maxMembers ?? defaultCollabSettings.maxMembers));
  const [maxMessageBytes, setMaxMessageBytes] = useState(String(initial.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes));
  const [maxQueue, setMaxQueue] = useState(String(initial.maxQueue ?? defaultCollabSettings.maxQueue));
  const [invitation, setInvitation] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [status, setStatus] = useState<string>();
  useEffect(() => props.port?.subscribe?.(() => {
    const snapshot = props.port?.getSnapshot();
    if (!snapshot) return;
    setDeployment({ gatewayHost: snapshot.gatewayHost, gatewayPort: snapshot.gatewayPort, exposeMode: snapshot.exposeMode });
    setAdvertisedEndpoint(snapshot.advertisedEndpoint);
    setTokenTtlMs(String(snapshot.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs));
    setApprovalPolicy(snapshot.approvalPolicy ?? defaultCollabSettings.approvalPolicy);
    setMaxMembers(String(snapshot.maxMembers ?? defaultCollabSettings.maxMembers));
    setMaxMessageBytes(String(snapshot.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes));
    setMaxQueue(String(snapshot.maxQueue ?? defaultCollabSettings.maxQueue));
  }), [props.port]);
  const warning = deployment.exposeMode === "network" ? createElement("p", { role: "alert" }, "Anyone on this trusted LAN/VPN can reach the Gateway. Invite and room tokens still control access.") : null;
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    try {
      await props.port?.save({ ...deployment, advertisedEndpoint, tokenTtlMs: Number(tokenTtlMs), approvalPolicy, maxMembers: Number(maxMembers), maxMessageBytes: Number(maxMessageBytes), maxQueue: Number(maxQueue) });
      setStatus("Collaboration settings saved. Gateway changes apply after DSH restart.");
    } catch (cause) {
      setStatus(cause instanceof Error ? cause.message : "Unable to save collaboration settings");
    }
  };
  const bootstrap = async (): Promise<void> => {
    if (!props.port?.bootstrap) return;
    try { await props.port.bootstrap(); setStatus("Connected to the configured room as Host"); } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Unable to open Host room"); }
  };
  const join = async (): Promise<void> => {
    if (!props.port?.join) return;
    try {
      await props.port.join({ invitation, displayName });
      setStatus("Joined the invitation room as Participant");
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Unable to join room"); }
  };
  const createInvite = async (): Promise<void> => {
    if (!props.port?.createInvite) return;
    try {
      const gatewayEndpoint = advertisedEndpoint.trim() || `ws://127.0.0.1:${String(deployment.gatewayPort)}/collab`;
      const result = await props.port.createInvite({ expiresAt: Date.now() + 60 * 60 * 1000, gatewayEndpoint });
      setInvitation(result.invitation);
      setStatus("Invitation created. Share the complete invitation text.");
    } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Unable to create invite"); }
  };
  return createElement("form", { className: "dsh-collab-settings-card", onSubmit: save, "data-settings-namespace": "dsh-collab" },
    createElement("h3", null, "dsh-collab"),
    createElement("fieldset", null,
      createElement("legend", null, "Dedicated Host Gateway"),
      createElement("p", null, "This dedicated Collab Gateway is separate from the DSH UI listener. Use trusted LAN/VPN mode for another device."),
      createElement("label", null, "Exposure ", createElement("select", {
        value: deployment.exposeMode,
        onChange: (event: ChangeEvent<HTMLSelectElement>) => {
          const exposeMode = event.target.value as "loopback" | "network";
          setDeployment((current) => ({ ...current, exposeMode, gatewayHost: exposeMode === "loopback" ? "127.0.0.1" : "0.0.0.0" }));
        },
        name: "exposeMode",
      }, createElement("option", { value: "loopback" }, "This device only"), createElement("option", { value: "network" }, "Trusted LAN / VPN"))),
      createElement("label", null, "Gateway port ", createElement("input", { type: "number", min: 1, max: 65535, value: deployment.gatewayPort, onChange: (event: ChangeEvent<HTMLInputElement>) => setDeployment((current) => ({ ...current, gatewayPort: Number(event.target.value) })), name: "gatewayPort" })),
      createElement("label", null, "Invitation address ", createElement("input", { type: "url", value: advertisedEndpoint, onChange: (event: ChangeEvent<HTMLInputElement>) => setAdvertisedEndpoint(event.target.value), name: "advertisedEndpoint", placeholder: deployment.exposeMode === "network" ? "ws://192.168.1.20:4310/collab" : "Optional wss:// public endpoint" })),
      createElement("p", null, deployment.exposeMode === "loopback" ? "Leave blank to use the loopback Gateway in local invitations." : "Use this Host's reachable private IP, or an existing external wss:// endpoint."),
      warning,
    ),
    createElement("fieldset", null,
      createElement("legend", null, "Host room safety (restart required)"),
      createElement("label", null, "Token lifetime (ms) ", createElement("input", { type: "number", min: 1, value: tokenTtlMs, onChange: (event: ChangeEvent<HTMLInputElement>) => setTokenTtlMs(event.target.value), name: "tokenTtlMs" })),
      createElement("label", null, "Approval policy ", createElement("select", { value: approvalPolicy, onChange: (event: ChangeEvent<HTMLSelectElement>) => setApprovalPolicy(event.target.value as "host-only" | "disabled"), name: "approvalPolicy" }, createElement("option", { value: "host-only" }, "Host only"), createElement("option", { value: "disabled" }, "Disabled"))),
      createElement("label", null, "Max members ", createElement("input", { type: "number", min: 1, value: maxMembers, onChange: (event: ChangeEvent<HTMLInputElement>) => setMaxMembers(event.target.value), name: "maxMembers" })),
      createElement("label", null, "Max message bytes ", createElement("input", { type: "number", min: 1, value: maxMessageBytes, onChange: (event: ChangeEvent<HTMLInputElement>) => setMaxMessageBytes(event.target.value), name: "maxMessageBytes" })),
      createElement("label", null, "Max queued Agent requests ", createElement("input", { type: "number", min: 0, value: maxQueue, onChange: (event: ChangeEvent<HTMLInputElement>) => setMaxQueue(event.target.value), name: "maxQueue" })),
    ),
    createElement("button", { type: "submit" }, "Save collaboration settings"),
    createElement("fieldset", null,
      createElement("legend", null, "Room access"),
      createElement("button", { type: "button", onClick: () => { void bootstrap(); }, disabled: !props.port?.bootstrap }, "Open Host room"),
      createElement("button", { type: "button", onClick: () => { void createInvite(); }, disabled: !props.port?.createInvite || (deployment.exposeMode === "network" && advertisedEndpoint.trim() === "") }, "Create invitation"),
      createElement("label", null, "Invitation ", createElement("textarea", { value: invitation, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setInvitation(event.target.value), name: "invitation", rows: 6, placeholder: "Paste the complete dsh-collab invitation here" })),
      createElement("label", null, "Display name ", createElement("input", { value: displayName, onChange: (event: ChangeEvent<HTMLInputElement>) => setDisplayName(event.target.value), name: "displayName" })),
      createElement("button", { type: "button", onClick: () => { void join(); }, disabled: !props.port?.join || invitation.trim() === "" || displayName.trim() === "" }, "Join as Participant"),
    ),
    status ? createElement("p", { role: "status" }, status) : null,
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
