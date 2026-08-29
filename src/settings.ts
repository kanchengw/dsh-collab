import z from "@deepseek-ai/schemastery";
import { normalizeAdvertisedGatewayEndpoint, normalizeGatewayEndpoint } from "./endpoint-policy.js";
import { COLLAB_TOKEN_TTL_OPTIONS, defaultCollabSettings, tokenTtlOptionFromMs, type CollabSettings, type DshCollabParticipantSettings, type DshCollabPersistedSettings } from "./settings-shared.js";
export * from "./settings-shared.js";

export const DSH_COLLAB_SETTINGS_SCHEMA: z<DshCollabPersistedSettings> = z.object({
  gateway: z.object({
    gatewayHost: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
    gatewayPort: z.number().step(1).min(1).max(65535).required(),
    exposeMode: z.union([z.const("loopback"), z.const("network")]).required(),
    advertisedEndpoint: z.string().default(""),
  }).required(),
  appliedGateway: z.object({
    gatewayHost: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
    gatewayPort: z.number().step(1).min(1).max(65535).required(),
    exposeMode: z.union([z.const("loopback"), z.const("network")]).required(),
    advertisedEndpoint: z.string().default(""),
  }).default(undefined as unknown as NonNullable<DshCollabPersistedSettings["appliedGateway"]>).hidden(),
  security: z.object({
    tokenTtlMs: z.union([z.number().step(1).min(1), z.const(null)]).required(),
    approvalPolicy: z.union([z.const("host-only"), z.const("disabled")]).required(),
    maxMembers: z.number().step(1).min(1).required(),
    maxMessageBytes: z.number().step(1).min(1).required(),
    maxQueue: z.number().step(1).min(0).required(),
  }).default({
    tokenTtlMs: defaultCollabSettings.tokenTtlMs,
    approvalPolicy: defaultCollabSettings.approvalPolicy,
    maxMembers: defaultCollabSettings.maxMembers,
    maxMessageBytes: defaultCollabSettings.maxMessageBytes,
    maxQueue: defaultCollabSettings.maxQueue,
  }),
});

export const DSH_COLLAB_PARTICIPANT_SCHEMA: z<DshCollabParticipantSettings> = z.object({
  joinedRooms: z.array(z.object({
    gatewayEndpoint: z.string().min(1).required(),
    roomId: z.string().min(1).required(),
    memberId: z.string().min(1).required(),
    credential: z.string().min(1).required(),
    roomTitle: z.string().default(""),
    hostDisplayName: z.string().default(""),
  })).default([]).hidden(),
  resume: z.object({
    gatewayEndpoint: z.string().min(1).required(),
    roomId: z.string().min(1).required(),
    memberId: z.string().min(1).required(),
    credential: z.string().min(1).required(),
  }).default(undefined as unknown as NonNullable<DshCollabParticipantSettings["resume"]>).hidden(),
});

function validateAdvertisedEndpoint(gateway: DshCollabPersistedSettings["gateway"]): void {
  if (gateway.advertisedEndpoint === "") {
    return;
  }
  normalizeAdvertisedGatewayEndpoint(gateway.advertisedEndpoint, gateway.exposeMode);
}

function validateGateway(gateway: DshCollabPersistedSettings["gateway"]): void {
  if (!Number.isSafeInteger(gateway.gatewayPort) || gateway.gatewayPort < 1 || gateway.gatewayPort > 65535) throw new Error("gatewayPort must be between 1 and 65535");
  if (gateway.exposeMode === "loopback" && gateway.gatewayHost !== "127.0.0.1") throw new Error("loopback mode requires 127.0.0.1");
  if (gateway.exposeMode === "network" && gateway.gatewayHost !== "0.0.0.0") throw new Error("network mode requires 0.0.0.0");
  validateAdvertisedEndpoint(gateway);
}

export function validateDshCollabPersistedSettings(settings: DshCollabPersistedSettings): void {
  validateGateway(settings.gateway);
  if (settings.appliedGateway) validateGateway(settings.appliedGateway);
  if (settings.security) {
    const security: CollabSettings = { ...defaultCollabSettings, ...settings.security, ...settings.gateway };
    validateCollabSettings(security);
  }
}

export function validateDshCollabParticipantSettings(settings: DshCollabParticipantSettings): void {
  const rooms = settings.joinedRooms ?? [];
  const keys = new Set<string>();
  for (const room of rooms) {
    normalizeGatewayEndpoint(room.gatewayEndpoint);
    for (const field of ["roomId", "memberId", "credential"] as const) {
      if (room[field].trim() === "") throw new Error(field + " must not be blank");
    }
    const key = `${room.gatewayEndpoint}\n${room.roomId}`;
    if (keys.has(key)) throw new Error("joined room must be unique");
    keys.add(key);
  }
  if (settings.resume) {
    normalizeGatewayEndpoint(settings.resume.gatewayEndpoint);
    for (const field of ["roomId", "memberId", "credential"] as const) {
      if (settings.resume[field].trim() === "") throw new Error(field + " must not be blank");
    }
  }
}

export function validateCollabSettings(settings: CollabSettings): void {
  if (!Number.isSafeInteger(settings.gatewayPort) || settings.gatewayPort < 1 || settings.gatewayPort > 65535) throw new Error("gatewayPort must be between 1 and 65535");
  if (settings.tokenTtlMs !== null && (!Number.isSafeInteger(settings.tokenTtlMs) || settings.tokenTtlMs < 1)) throw new Error("tokenTtlMs must be positive or null");
  if (!Number.isSafeInteger(settings.maxMembers) || settings.maxMembers < 1) throw new Error("maxMembers must be positive");
  if (!Number.isSafeInteger(settings.maxMessageBytes) || settings.maxMessageBytes < 1) throw new Error("maxMessageBytes must be positive");
  if (!Number.isSafeInteger(settings.maxQueue) || settings.maxQueue < 0) throw new Error("maxQueue must be non-negative");
  if (settings.exposeMode === "loopback" && settings.gatewayHost !== "127.0.0.1") throw new Error("loopback mode requires 127.0.0.1");
  if (settings.exposeMode === "network" && settings.gatewayHost !== "0.0.0.0") throw new Error("network mode requires 0.0.0.0");
  validateAdvertisedEndpoint(settings);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function renderCollabSettings(settings: CollabSettings): string {
  validateCollabSettings(settings);
  const connectionMethod = settings.exposeMode === "network" ? "private-network" : settings.advertisedEndpoint.startsWith("wss://") ? "custom-wss" : "unconfigured";
  const warning = connectionMethod === "private-network"
    ? `<p class="collab-settings__warning" role="alert">Anyone on this trusted network can reach the Gateway; invite and room tokens still control access.</p>`
    : connectionMethod === "unconfigured" ? `<p class="collab-settings__safe" role="status">Not configured: choose a connection method before creating invitations.</p>` : "";
  const endpointField = connectionMethod === "custom-wss"
    ? `<label>Custom WSS endpoint <input name="customWssEndpoint" type="url" value="${escapeHtml(settings.advertisedEndpoint)}"></label>`
    : "";
  const tokenTtlOption = tokenTtlOptionFromMs(settings.tokenTtlMs);
  const tokenTtlOptions = COLLAB_TOKEN_TTL_OPTIONS.map((option) => `<option value="${option.value}"${option.value === tokenTtlOption ? " selected" : ""}>${option.value === "never" ? "Never" : option.value.slice(0, -1) + " day" + (option.value === "1d" ? "" : "s")}</option>`).join("");
  const connectionField = `<label>Connection method <select name="connectionMethod"><option value="unconfigured"${connectionMethod === "unconfigured" ? " selected" : ""} disabled>Not configured</option><option value="private-network"${connectionMethod === "private-network" ? " selected" : ""}>Private network</option><option value="custom-wss"${connectionMethod === "custom-wss" ? " selected" : ""}>Custom WSS endpoint</option></select></label>`;
  const lanSettings = `<fieldset><legend>LAN settings</legend>${connectionField}${endpointField}${connectionMethod === "private-network" ? warning : ""}<p>Private network discovery and the invitation endpoint are handled automatically when the Gateway starts.</p></fieldset>`;
  return `<section class="collab-settings" data-settings-namespace="collab"><h2>dsh-collab</h2><p>Configure the dedicated Host Gateway.</p><fieldset><legend>Host gateway</legend><label><input type="checkbox" name="enabled"${settings.enabled ? " checked" : ""}> Enable collaboration</label></fieldset><details><summary>Advanced options</summary><fieldset><legend>Security</legend><label>Token lifetime <select name="tokenTtl">${tokenTtlOptions}</select></label></fieldset><fieldset><legend>Chat</legend><label>Max members <input name="maxMembers" type="number" min="1" value="${String(settings.maxMembers)}"></label><label>Max message bytes <input name="maxMessageBytes" type="number" min="1" value="${String(settings.maxMessageBytes)}"></label><label>Max queued Agent requests <input name="maxQueue" type="number" min="0" value="${String(settings.maxQueue)}"></label></fieldset>${lanSettings}</details><button type="submit" data-action="save-settings">Save</button></section>`;
}
