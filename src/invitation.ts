import { normalizeGatewayEndpoint } from "./endpoint-policy.js";
import { decodeEasyTierInvitationNetwork, type EasyTierInvitationNetwork } from "./easytier-invitation.js";
import { COLLAB_INVITATION_PROTOCOL, COLLAB_PROTOCOL } from "./protocol.js";

export { COLLAB_INVITATION_PROTOCOL } from "./protocol.js";

export type CollabInvitationNetwork =
  | { mode: "lan"; version: 1; endpoint: string }
  | EasyTierInvitationNetwork
  | { mode: "custom-wss"; version: 1; endpoint: string };

interface CollabInvitationBase {
  type: "invite";
  gatewayEndpoint: string;
  roomId: string;
  inviteId: string;
  token: string;
  expiresAt: number;
}

export interface LegacyCollabInvitation extends CollabInvitationBase {
  protocol: typeof COLLAB_PROTOCOL;
}

export interface VersionedCollabInvitation extends CollabInvitationBase {
  protocol: typeof COLLAB_INVITATION_PROTOCOL;
  network: CollabInvitationNetwork;
}

export type CollabInvitation = LegacyCollabInvitation | VersionedCollabInvitation;

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`invitation ${field} must not be blank`);
  return value.trim();
}

function versionedNetwork(value: unknown, gatewayEndpoint: string): CollabInvitationNetwork {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invitation network must be an object");
  const input = value as Record<string, unknown>;
  if (input.version !== 1) throw new Error("invitation network.version is not supported");
  if (input.mode === "easytier") {
    const network = decodeEasyTierInvitationNetwork(input);
    const gateway = new URL(gatewayEndpoint);
    if (gateway.protocol !== "ws:" || gateway.hostname !== network.ownerVirtualAddress) {
      throw new Error("invitation gatewayEndpoint must use ownerVirtualAddress over ws");
    }
    return network;
  }
  if (input.mode !== "lan" && input.mode !== "custom-wss") throw new Error("invitation network.mode is not supported");
  const endpoint = normalizeGatewayEndpoint(text(input.endpoint, "network.endpoint"));
  if (endpoint !== gatewayEndpoint) throw new Error("invitation network endpoint must match gatewayEndpoint");
  const protocol = new URL(endpoint).protocol;
  if (input.mode === "lan" && protocol !== "ws:") throw new Error("invitation LAN endpoint must use ws");
  if (input.mode === "custom-wss" && protocol !== "wss:") throw new Error("invitation custom WSS endpoint must use wss");
  return { mode: input.mode, version: 1, endpoint };
}

function invitation(value: unknown): CollabInvitation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invitation must be an object");
  const input = value as Record<string, unknown>;
  if (input.protocol !== COLLAB_PROTOCOL && input.protocol !== COLLAB_INVITATION_PROTOCOL) throw new Error("invitation protocol is not supported");
  if (input.type !== "invite") throw new Error("invitation type is not supported");
  if (typeof input.expiresAt !== "number" || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) {
    throw new Error("invitation expiresAt must be a non-negative integer");
  }
  const common = {
    type: "invite",
    gatewayEndpoint: normalizeGatewayEndpoint(text(input.gatewayEndpoint, "gatewayEndpoint")),
    roomId: text(input.roomId, "roomId"),
    inviteId: text(input.inviteId, "inviteId"),
    token: text(input.token, "token"),
    expiresAt: input.expiresAt,
  } as const;
  if (input.protocol === COLLAB_PROTOCOL) {
    if (input.network !== undefined) throw new Error("invitation network requires the versioned invitation protocol");
    return { protocol: COLLAB_PROTOCOL, ...common };
  }
  return {
    protocol: COLLAB_INVITATION_PROTOCOL,
    ...common,
    network: versionedNetwork(input.network, common.gatewayEndpoint),
  };
}

export function encodeCollabInvitation(value: CollabInvitation): string {
  return JSON.stringify(invitation(value));
}

export function decodeCollabInvitation(value: string): CollabInvitation {
  try {
    return invitation(JSON.parse(value));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("invitation must be valid JSON");
    throw error;
  }
}
