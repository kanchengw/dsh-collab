import { normalizeGatewayEndpoint } from "./endpoint-policy.js";
import { COLLAB_PROTOCOL } from "./protocol.js";

export interface CollabInvitation {
  protocol: typeof COLLAB_PROTOCOL;
  type: "invite";
  gatewayEndpoint: string;
  roomId: string;
  inviteId: string;
  token: string;
  expiresAt: number;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`invitation ${field} must not be blank`);
  return value.trim();
}

function invitation(value: unknown): CollabInvitation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invitation must be an object");
  const input = value as Record<string, unknown>;
  if (input.protocol !== COLLAB_PROTOCOL) throw new Error("invitation protocol is not supported");
  if (input.type !== "invite") throw new Error("invitation type is not supported");
  if (typeof input.expiresAt !== "number" || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0) {
    throw new Error("invitation expiresAt must be a non-negative integer");
  }
  return {
    protocol: COLLAB_PROTOCOL,
    type: "invite",
    gatewayEndpoint: normalizeGatewayEndpoint(text(input.gatewayEndpoint, "gatewayEndpoint")),
    roomId: text(input.roomId, "roomId"),
    inviteId: text(input.inviteId, "inviteId"),
    token: text(input.token, "token"),
    expiresAt: input.expiresAt,
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
