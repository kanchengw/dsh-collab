export type CollabExposeMode = "loopback" | "network";
export type CollabConnectionMethod = "unconfigured" | "private-network" | "easytier" | "custom-wss";
export type CollabApprovalPolicy = "host-only" | "disabled";
export type CollabTokenTtl = number | null;

export const COLLAB_TOKEN_TTL_OPTIONS = [
  { value: "1d", ms: 24 * 60 * 60 * 1000 },
  { value: "3d", ms: 3 * 24 * 60 * 60 * 1000 },
  { value: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
  { value: "never", ms: null },
] as const;
export type CollabTokenTtlOption = (typeof COLLAB_TOKEN_TTL_OPTIONS)[number]["value"];

export function tokenTtlOptionFromMs(value: CollabTokenTtl | undefined): CollabTokenTtlOption {
  return COLLAB_TOKEN_TTL_OPTIONS.find((option) => option.ms === value)?.value ?? "1d";
}

export function tokenTtlMsFromOption(value: string): CollabTokenTtl {
  const option = COLLAB_TOKEN_TTL_OPTIONS.find((candidate) => candidate.value === value);
  if (!option) throw new Error("token lifetime option is invalid");
  return option.ms;
}

export interface CollabSettings {
  enabled: boolean;
  gatewayHost: "127.0.0.1" | "0.0.0.0";
  gatewayPort: number;
  exposeMode: CollabExposeMode;
  advertisedEndpoint: string;
  connectionMethod: CollabConnectionMethod;
  easyTierSharedNode: string;
  tokenTtlMs: CollabTokenTtl;
  approvalPolicy: CollabApprovalPolicy;
  maxMembers: number;
  maxMessageBytes: number;
  maxQueue: number;
}

export const defaultCollabSettings: CollabSettings = {
  enabled: true,
  gatewayHost: "127.0.0.1",
  gatewayPort: 4310,
  exposeMode: "loopback",
  advertisedEndpoint: "",
  connectionMethod: "unconfigured",
  easyTierSharedNode: "tcp://public.kkrainbow.top:11010",
  tokenTtlMs: 24 * 60 * 60 * 1000,
  approvalPolicy: "host-only",
  maxMembers: 16,
  maxMessageBytes: 64 * 1024,
  maxQueue: 5,
};

export const DSH_COLLAB_SETTINGS_NAMESPACE = "dsh-collab";
export const DSH_COLLAB_PARTICIPANT_NAMESPACE = "dsh-collab-participant";

export interface DshCollabGatewaySettings {
  gatewayHost: "127.0.0.1" | "0.0.0.0";
  gatewayPort: number;
  exposeMode: CollabExposeMode;
  advertisedEndpoint: string;
}

export interface DshCollabSecuritySettings {
  tokenTtlMs: CollabTokenTtl;
  approvalPolicy: CollabApprovalPolicy;
  maxMembers: number;
  maxMessageBytes: number;
  maxQueue: number;
}

export interface DshCollabPersistedSettings {
  gateway: DshCollabGatewaySettings;
  appliedGateway?: DshCollabGatewaySettings;
  security?: DshCollabSecuritySettings;
  connectionMethod?: CollabConnectionMethod;
  easyTierSharedNode?: string;
  easyTierRooms?: DshCollabEasyTierRoom[];
}

export interface DshCollabEasyTierRoom {
  roomId: string;
  credentialKey: string;
}

export interface DshCollabJoinedRoom {
  gatewayEndpoint: string;
  roomId: string;
  memberId: string;
  credentialKey: string;
  roomTitle?: string;
  hostDisplayName?: string;
}

export interface DshCollabParticipantSettings {
  joinedRooms?: DshCollabJoinedRoom[];
}
