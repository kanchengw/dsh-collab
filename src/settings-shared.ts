export type CollabExposeMode = "loopback" | "network";
export type CollabApprovalPolicy = "host-only" | "disabled";

export interface CollabSettings {
  enabled: boolean;
  gatewayHost: "127.0.0.1" | "0.0.0.0";
  gatewayPort: number;
  exposeMode: CollabExposeMode;
  advertisedEndpoint: string;
  tokenTtlMs: number;
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
  tokenTtlMs: 8 * 60 * 60 * 1000,
  approvalPolicy: "host-only",
  maxMembers: 16,
  maxMessageBytes: 64 * 1024,
  maxQueue: 32,
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
  tokenTtlMs: number;
  approvalPolicy: CollabApprovalPolicy;
  maxMembers: number;
  maxMessageBytes: number;
  maxQueue: number;
}

export interface DshCollabPersistedSettings {
  gateway: DshCollabGatewaySettings;
  security?: DshCollabSecuritySettings;
}

export interface DshCollabParticipantSettings {
  resume?: {
    gatewayEndpoint: string;
    roomId: string;
    memberId: string;
    credential: string;
  };
}
