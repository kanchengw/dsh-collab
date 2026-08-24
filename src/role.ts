import type { MemberRole, RoomTokenClaims } from "./types.js";

export type RoomRole = "host" | "participant";

export interface LocalSessionEvidence {
  kind: "local-session";
  roomId: string;
  sessionId: string;
  /** Supplied by the trusted DSH session service, never by the browser. */
  owned: true;
}

export interface RemoteTokenEvidence {
  kind: "remote-token";
  roomId: string;
  gatewayUrl: string;
  claims: RoomTokenClaims;
}

export type RoomRoleEvidence = LocalSessionEvidence | RemoteTokenEvidence;

export interface RoomSessionContext {
  roomId: string;
  role: RoomRole;
  localSessionId?: string;
  remoteGatewayUrl?: string;
  token?: string;
  memberRole?: MemberRole;
}

/**
 * Resolve a room's face from server-owned evidence. A UI may request a face,
 * but it cannot elevate itself by declaring `host`.
 */
export function resolveRoomSession(input: {
  evidence?: RoomRoleEvidence;
  token?: string;
  requestedRole?: RoomRole;
}): RoomSessionContext {
  const evidence = input.evidence;
  if (!evidence) throw new Error("room role evidence is required");
  const authoritativeRole: RoomRole = evidence.kind === "local-session" ? "host" : "participant";
  if (input.requestedRole && input.requestedRole !== authoritativeRole) {
    throw new Error("requested room role does not match authoritative evidence");
  }
  if (evidence.kind === "local-session") {
    if (!evidence.owned) throw new Error("local session ownership was not verified");
    return {
      roomId: evidence.roomId,
      role: "host",
      localSessionId: evidence.sessionId,
    };
  }
  if (evidence.claims.roomId !== evidence.roomId || evidence.claims.role === "host") {
    throw new Error("remote token is not a participant token for this room");
  }
  if (evidence.gatewayUrl.trim() === "") throw new Error("remote gateway URL is required");
  if (!input.token || input.token.trim() === "") throw new Error("remote room token is required");
  return {
    roomId: evidence.roomId,
    role: "participant",
    remoteGatewayUrl: evidence.gatewayUrl,
    token: input.token,
    memberRole: evidence.claims.role,
  };
}
