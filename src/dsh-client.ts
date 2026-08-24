import { createElement, useEffect, useMemo, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import type { ComposerTarget } from "./ui.js";
import { createDshBrowserCollabClient, type DshBrowserCollabClient, type DshBrowserJoinInput } from "./dsh-browser-client.js";

export interface DshCollabClientSnapshot {
  roomId: string;
  roomTitle: string;
  hostDisplayName: string;
  role: "host" | "participant";
  connection: "connecting" | "online" | "offline";
  memberCount: number;
  canSteer: boolean;
}

export interface DshCollabClientPort {
  getSnapshot(): DshCollabClientSnapshot;
  subscribe(listener: () => void): () => void;
  send(input: { text: string; target: ComposerTarget }): Promise<void>;
}

export interface DshCollabSettingsPort {
  getSnapshot(): { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network" };
  save(input: { gatewayHost: string; gatewayPort: number; exposeMode: "loopback" | "network" }): Promise<void>;
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
export const inject = ["slots"];

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
    createElement("form", { onSubmit: submit },
      createElement("label", null, "Send to ", createElement("select", { value: selectedTarget, onChange: (event: ChangeEvent<HTMLSelectElement>) => setTarget(event.target.value as ComposerTarget), name: "collab-target" }, [option("room", selectedTarget), option("dsh", selectedTarget), canSteer ? option("dsh-steer", selectedTarget) : null])),
      createElement("textarea", { value: draft, onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value), name: "collab-text", placeholder: "Message the room or ask the Host Agent", rows: 2 }),
      createElement("button", { type: "submit", disabled: !props.port || draft.trim() === "" }, "Send"),
    ),
    error ? createElement("p", { role: "alert" }, error) : null,
  );
}

/** Settings card registered under DSH's plugin configuration tab. */
export function DshCollabSettingsCard(props: { port?: DshCollabSettingsPort }): ReactNode {
  const initial = useMemo(() => props.port?.getSnapshot() ?? { gatewayHost: "127.0.0.1", gatewayPort: 0, exposeMode: "loopback" as const }, [props.port]);
  const [host, setHost] = useState(initial.gatewayHost);
  const [port, setPort] = useState(String(initial.gatewayPort));
  const [exposeMode, setExposeMode] = useState(initial.exposeMode);
  const [roomId, setRoomId] = useState("");
  const [inviteId, setInviteId] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [memberId, setMemberId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [principalId, setPrincipalId] = useState("");
  const [status, setStatus] = useState<string>();
  const warning = exposeMode === "network" ? createElement("p", { role: "alert" }, "Anyone who can reach this address may attempt to join. Use authenticated access.") : null;
  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    await props.port?.save({ gatewayHost: host, gatewayPort: Number(port), exposeMode });
    setStatus("Gateway settings saved");
  };
  const bootstrap = async (): Promise<void> => {
    if (!props.port?.bootstrap) return;
    try { await props.port.bootstrap(roomId.trim() || undefined); setStatus(`Connected to room ${roomId || "configured room"} as Host`); } catch (cause) { setStatus(cause instanceof Error ? cause.message : "Unable to open Host room"); }
  };
  const join = async (): Promise<void> => {
    if (!props.port?.join) return;
    try {
      await props.port.join({ inviteId, inviteToken, memberId, displayName, principalId }, roomId.trim() || undefined);
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
  return createElement("form", { className: "dsh-collab-settings-card", onSubmit: save, "data-settings-namespace": "collab" },
    createElement("h3", null, "dsh-collab"),
    createElement("p", null, "Configure the Host gateway used by collaboration rooms."),
    createElement("label", null, "Bind host ", createElement("select", { value: host, onChange: (event: ChangeEvent<HTMLSelectElement>) => setHost(event.target.value), name: "gatewayHost" }, createElement("option", { value: "127.0.0.1" }, "127.0.0.1 (loopback)"), createElement("option", { value: "0.0.0.0" }, "0.0.0.0 (network)"))),
    createElement("label", null, "Port ", createElement("input", { type: "number", min: 0, max: 65535, value: port, onChange: (event: ChangeEvent<HTMLInputElement>) => setPort(event.target.value), name: "gatewayPort" })),
    createElement("label", null, "Exposure ", createElement("select", { value: exposeMode, onChange: (event: ChangeEvent<HTMLSelectElement>) => setExposeMode(event.target.value as "loopback" | "network"), name: "exposeMode" }, createElement("option", { value: "loopback" }, "Loopback"), createElement("option", { value: "network" }, "Explicit network"))),
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
      createElement("label", null, "Principal ID ", createElement("input", { value: principalId, onChange: (event: ChangeEvent<HTMLInputElement>) => setPrincipalId(event.target.value), name: "principalId" })),
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
  const settings = optionalService<DshCollabSettingsPort>(context, "collabSettings") ?? browserClient?.settingsPort();
  if (browserClient) context.provide?.("collabClient", browserClient);
  if (settings) context.provide?.("collabSettings", settings);
  context.slots.inject("conversation.input.dock", () => context.slots.register({ name: "conversation.input.dock", id: "collab", order: 5 }, () => createElement(DshCollabDock, { port: client })));
  context.slots.inject("settings.plugin.item", () => context.slots.register({ name: "settings.plugin.item", key: "collab" }, () => createElement(DshCollabSettingsCard, { port: settings })));
  context.slots.inject("settings.plugins.tab", () => context.slots.register({ name: "settings.plugins.tab", id: "collab", order: 5, label: "Collaboration" }, () => createElement(DshCollabSettingsCard, { port: settings })));
}

/** DSH client runner entry expected by every `dsh.client` bundle. */
export { applyDshCollabClient as apply };
