import z from "@deepseek-ai/schemastery";

export type CollabExposeMode = "loopback" | "network";
export type CollabApprovalPolicy = "host-only" | "disabled";

export interface CollabSettings {
  enabled: boolean;
  gatewayHost: "127.0.0.1" | "0.0.0.0";
  gatewayPort: number;
  exposeMode: CollabExposeMode;
  participantGatewayUrl: string;
  tokenTtlMs: number;
  approvalPolicy: CollabApprovalPolicy;
  maxMembers: number;
  maxMessageBytes: number;
  maxQueue: number;
}

export const defaultCollabSettings: CollabSettings = {
  enabled: true,
  gatewayHost: "127.0.0.1",
  gatewayPort: 0,
  exposeMode: "loopback",
  participantGatewayUrl: "",
  tokenTtlMs: 8 * 60 * 60 * 1000,
  approvalPolicy: "host-only",
  maxMembers: 16,
  maxMessageBytes: 64 * 1024,
  maxQueue: 32,
};

export const DSH_COLLAB_SETTINGS_NAMESPACE = "dsh-collab";

export interface DshCollabGatewaySettings {
  gatewayHost: "127.0.0.1" | "0.0.0.0";
  gatewayPort: number;
  exposeMode: CollabExposeMode;
}

export interface DshCollabPersistedSettings {
  gateway: DshCollabGatewaySettings;
}

export const DSH_COLLAB_SETTINGS_SCHEMA: z<DshCollabPersistedSettings> = z.object({
  gateway: z.object({
    gatewayHost: z.union([z.const("127.0.0.1"), z.const("0.0.0.0")]).required(),
    gatewayPort: z.number().step(1).min(0).max(65535).required(),
    exposeMode: z.union([z.const("loopback"), z.const("network")]).required(),
  }).required(),
});

export function validateDshCollabPersistedSettings(settings: DshCollabPersistedSettings): void {
  const gateway = settings.gateway;
  if (gateway.exposeMode === "loopback" && gateway.gatewayHost !== "127.0.0.1") throw new Error("loopback mode requires 127.0.0.1");
  if (gateway.exposeMode === "network" && gateway.gatewayHost !== "0.0.0.0") throw new Error("network mode requires 0.0.0.0");
}

export function validateCollabSettings(settings: CollabSettings): void {
  if (!Number.isSafeInteger(settings.gatewayPort) || settings.gatewayPort < 0 || settings.gatewayPort > 65535) throw new Error("gatewayPort must be between 0 and 65535");
  if (!Number.isSafeInteger(settings.tokenTtlMs) || settings.tokenTtlMs < 1) throw new Error("tokenTtlMs must be positive");
  if (!Number.isSafeInteger(settings.maxMembers) || settings.maxMembers < 1) throw new Error("maxMembers must be positive");
  if (!Number.isSafeInteger(settings.maxMessageBytes) || settings.maxMessageBytes < 1) throw new Error("maxMessageBytes must be positive");
  if (!Number.isSafeInteger(settings.maxQueue) || settings.maxQueue < 0) throw new Error("maxQueue must be non-negative");
  if (settings.exposeMode === "loopback" && settings.gatewayHost !== "127.0.0.1") throw new Error("loopback mode requires 127.0.0.1");
  if (settings.exposeMode === "network" && settings.gatewayHost !== "0.0.0.0") throw new Error("network mode requires 0.0.0.0");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

export function renderCollabSettings(settings: CollabSettings): string {
  validateCollabSettings(settings);
  const warning = settings.exposeMode === "network"
    ? `<p class="collab-settings__warning" role="alert">Anyone who can reach this address may attempt to join. Use an authenticated reverse proxy and rotate invites.</p>`
    : `<p class="collab-settings__safe" role="status">Loopback only: remote participants need a deliberate gateway address.</p>`;
  return `<section class="collab-settings" data-settings-namespace="collab"><h2>dsh-collab</h2><p>Configure the one Host gateway and how this DSH joins remote rooms.</p><fieldset><legend>Host gateway</legend><label><input type="checkbox" name="enabled"${settings.enabled ? " checked" : ""}> Enable collaboration</label><label>Bind host <select name="gatewayHost"><option value="127.0.0.1"${settings.gatewayHost === "127.0.0.1" ? " selected" : ""}>127.0.0.1 (loopback)</option><option value="0.0.0.0"${settings.gatewayHost === "0.0.0.0" ? " selected" : ""}>0.0.0.0 (network)</option></select></label><label>Port <input name="gatewayPort" type="number" min="0" max="65535" value="${String(settings.gatewayPort)}"></label><label>Exposure <select name="exposeMode"><option value="loopback"${settings.exposeMode === "loopback" ? " selected" : ""}>Loopback</option><option value="network"${settings.exposeMode === "network" ? " selected" : ""}>Explicit network</option></select></label>${warning}</fieldset><fieldset><legend>Participant connection</legend><label>Gateway URL <input name="participantGatewayUrl" type="url" value="${escapeHtml(settings.participantGatewayUrl)}" placeholder="https://host.example"></label><p>Joining an invite selects Participant mode for that room; it never starts a local Agent for the remote room.</p></fieldset><fieldset><legend>Room safety</legend><label>Token lifetime (ms) <input name="tokenTtlMs" type="number" min="1" value="${String(settings.tokenTtlMs)}"></label><label>Approval policy <select name="approvalPolicy"><option value="host-only"${settings.approvalPolicy === "host-only" ? " selected" : ""}>Host only</option><option value="disabled"${settings.approvalPolicy === "disabled" ? " selected" : ""}>Disabled</option></select></label><label>Max members <input name="maxMembers" type="number" min="1" value="${String(settings.maxMembers)}"></label><label>Max message bytes <input name="maxMessageBytes" type="number" min="1" value="${String(settings.maxMessageBytes)}"></label><label>Max queued Agent requests <input name="maxQueue" type="number" min="0" value="${String(settings.maxQueue)}"></label></fieldset><button type="submit" data-action="save-settings">Save</button></section>`;
}
