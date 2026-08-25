import z from "@deepseek-ai/schemastery";
import { normalizeAdvertisedGatewayEndpoint, normalizeGatewayEndpoint } from "./endpoint-policy.js";
import { defaultCollabSettings, type CollabSettings, type DshCollabParticipantSettings, type DshCollabPersistedSettings } from "./settings-shared.js";
export * from "./settings-shared.js";

export const DSH_COLLAB_SETTINGS_SCHEMA: z<DshCollabPersistedSettings> = z.object({
  gateway: z.object({
    gatewayHost: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
    gatewayPort: z.number().step(1).min(1).max(65535).required(),
    exposeMode: z.union([z.const("loopback"), z.const("network")]).required(),
    advertisedEndpoint: z.string().default(""),
  }).required(),
  security: z.object({
    tokenTtlMs: z.number().step(1).min(1).required(),
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
  resume: z.object({
    gatewayEndpoint: z.string().min(1).required(),
    roomId: z.string().min(1).required(),
    memberId: z.string().min(1).required(),
    credential: z.string().min(1).required(),
  }).hidden(),
});

function validateAdvertisedEndpoint(gateway: DshCollabPersistedSettings["gateway"]): void {
  if (gateway.advertisedEndpoint === "") {
    if (gateway.exposeMode === "network") throw new Error("advertisedEndpoint is required in network mode");
    return;
  }
  normalizeAdvertisedGatewayEndpoint(gateway.advertisedEndpoint, gateway.exposeMode);
}

export function validateDshCollabPersistedSettings(settings: DshCollabPersistedSettings): void {
  const gateway = settings.gateway;
  if (!Number.isSafeInteger(gateway.gatewayPort) || gateway.gatewayPort < 1 || gateway.gatewayPort > 65535) throw new Error("gatewayPort must be between 1 and 65535");
  if (gateway.exposeMode === "loopback" && gateway.gatewayHost !== "127.0.0.1") throw new Error("loopback mode requires 127.0.0.1");
  if (gateway.exposeMode === "network" && gateway.gatewayHost !== "0.0.0.0") throw new Error("network mode requires 0.0.0.0");
  validateAdvertisedEndpoint(gateway);
  if (settings.security) {
    const security: CollabSettings = { ...defaultCollabSettings, ...settings.security, ...gateway };
    validateCollabSettings(security);
  }
}

export function validateDshCollabParticipantSettings(settings: DshCollabParticipantSettings): void {
  if (!settings.resume) return;
  normalizeGatewayEndpoint(settings.resume.gatewayEndpoint);
  for (const field of ["roomId", "memberId", "credential"] as const) {
    if (settings.resume[field].trim() === "") throw new Error(field + " must not be blank");
  }
}

export function validateCollabSettings(settings: CollabSettings): void {
  if (!Number.isSafeInteger(settings.gatewayPort) || settings.gatewayPort < 1 || settings.gatewayPort > 65535) throw new Error("gatewayPort must be between 1 and 65535");
  if (!Number.isSafeInteger(settings.tokenTtlMs) || settings.tokenTtlMs < 1) throw new Error("tokenTtlMs must be positive");
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
  const warning = settings.exposeMode === "network"
    ? `<p class="collab-settings__warning" role="alert">Anyone on this trusted network can reach the Gateway; invite and room tokens still control access.</p>`
    : `<p class="collab-settings__safe" role="status">Loopback only: use network mode before inviting another device.</p>`;
  return `<section class="collab-settings" data-settings-namespace="collab"><h2>dsh-collab</h2><p>Configure the dedicated Host Gateway.</p><fieldset><legend>Host gateway</legend><label><input type="checkbox" name="enabled"${settings.enabled ? " checked" : ""}> Enable collaboration</label><label>Port <input name="gatewayPort" type="number" min="1" max="65535" value="${String(settings.gatewayPort)}"></label><label>Exposure <select name="exposeMode"><option value="loopback"${settings.exposeMode === "loopback" ? " selected" : ""}>Loopback</option><option value="network"${settings.exposeMode === "network" ? " selected" : ""}>Trusted LAN/VPN</option></select></label><label>Invitation address <input name="advertisedEndpoint" type="url" value="${escapeHtml(settings.advertisedEndpoint)}" placeholder="ws://192.168.1.20:4310/collab"></label>${warning}</fieldset><fieldset><legend>Room safety</legend><label>Token lifetime (ms) <input name="tokenTtlMs" type="number" min="1" value="${String(settings.tokenTtlMs)}"></label><label>Approval policy <select name="approvalPolicy"><option value="host-only"${settings.approvalPolicy === "host-only" ? " selected" : ""}>Host only</option><option value="disabled"${settings.approvalPolicy === "disabled" ? " selected" : ""}>Disabled</option></select></label><label>Max members <input name="maxMembers" type="number" min="1" value="${String(settings.maxMembers)}"></label><label>Max message bytes <input name="maxMessageBytes" type="number" min="1" value="${String(settings.maxMessageBytes)}"></label><label>Max queued Agent requests <input name="maxQueue" type="number" min="0" value="${String(settings.maxQueue)}"></label></fieldset><button type="submit" data-action="save-settings">Save</button></section>`;
}
