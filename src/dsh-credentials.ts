import { randomBytes } from "node:crypto";
import { normalizeGatewayEndpoint } from "./endpoint-policy.js";
import { assertEasyTierPrivateIpv4, decodeEasyTierInvitationNetwork, type EasyTierInvitationNetwork } from "./easytier-invitation.js";
import type { ParticipantResumeState } from "./dsh-browser-client.js";

export interface DshCredentialRecord {
  readonly kind: string;
  readonly payload?: unknown;
}

export interface DshCredentialProvider {
  readRecord(key: string): Promise<DshCredentialRecord | undefined>;
  modifyRecord(key: string, mutate: (current: DshCredentialRecord | undefined) => Promise<DshCredentialRecord | undefined>): Promise<DshCredentialRecord | undefined>;
  deleteRecord(key: string): Promise<void>;
}

const PARTICIPANT_KEY = /^dsh-collab\/participant-[a-z0-9-]+$/;
const OWNER_KEY = /^dsh-collab\/owner-[a-z0-9-]+$/;

function requiredText(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`${field} is invalid`);
  return value;
}

function participantState(value: unknown): ParticipantResumeState {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Participant credential payload is invalid");
  const input = value as Record<string, unknown>;
  const gatewayEndpoint = requiredText(input.gatewayEndpoint, "gatewayEndpoint", 2048);
  normalizeGatewayEndpoint(gatewayEndpoint);
  const result: ParticipantResumeState = {
    gatewayEndpoint,
    roomId: requiredText(input.roomId, "roomId"),
    memberId: requiredText(input.memberId, "memberId"),
    credential: requiredText(input.credential, "credential", 2048),
    ...(typeof input.roomTitle === "string" && input.roomTitle.trim() !== "" ? { roomTitle: requiredText(input.roomTitle, "roomTitle", 80) } : {}),
    ...(typeof input.hostDisplayName === "string" && input.hostDisplayName.trim() !== "" ? { hostDisplayName: requiredText(input.hostDisplayName, "hostDisplayName", 80) } : {}),
  };
  if (input.easyTier !== undefined) {
    if (!input.easyTier || typeof input.easyTier !== "object" || Array.isArray(input.easyTier)) throw new Error("Participant EasyTier credential payload is invalid");
    const easyTier = input.easyTier as Record<string, unknown>;
    const localVirtualAddress = requiredText(easyTier.localVirtualAddress, "localVirtualAddress", 64);
    assertEasyTierPrivateIpv4("localVirtualAddress", localVirtualAddress);
    result.easyTier = { network: decodeEasyTierInvitationNetwork(easyTier.network), localVirtualAddress };
  }
  return result;
}

function grantPayload(record: DshCredentialRecord | undefined, kind: "participant" | "owner-network"): unknown {
  if (record?.kind !== "grant" || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)) {
    throw new Error("Collab credential record is missing or invalid");
  }
  const payload = record.payload as Record<string, unknown>;
  if (payload.version !== 1 || payload.kind !== kind) throw new Error("Collab credential record is missing or invalid");
  return payload;
}

export class DshCollabCredentialStore {
  constructor(
    private readonly credentials: DshCredentialProvider,
    private readonly idFactory: () => string = () => randomBytes(16).toString("hex"),
  ) {}

  async saveParticipant(state: ParticipantResumeState, key?: string): Promise<string> {
    const normalized = participantState(state);
    const nextKey = key ?? `dsh-collab/participant-${this.idFactory()}`;
    this.assertParticipantKey(nextKey);
    await this.credentials.modifyRecord(nextKey, async () => ({
      kind: "grant",
      payload: { version: 1, kind: "participant", state: normalized },
    }));
    return nextKey;
  }

  async loadParticipant(key: string): Promise<ParticipantResumeState> {
    this.assertParticipantKey(key);
    const payload = grantPayload(await this.credentials.readRecord(key), "participant") as Record<string, unknown>;
    return participantState(payload.state);
  }

  async saveOwnerNetwork(network: EasyTierInvitationNetwork, key?: string): Promise<string> {
    const normalized = decodeEasyTierInvitationNetwork(network);
    const nextKey = key ?? `dsh-collab/owner-${this.idFactory()}`;
    this.assertOwnerKey(nextKey);
    await this.credentials.modifyRecord(nextKey, async () => ({
      kind: "grant",
      payload: { version: 1, kind: "owner-network", network: normalized },
    }));
    return nextKey;
  }

  async loadOwnerNetwork(key: string): Promise<EasyTierInvitationNetwork> {
    this.assertOwnerKey(key);
    const payload = grantPayload(await this.credentials.readRecord(key), "owner-network") as Record<string, unknown>;
    return decodeEasyTierInvitationNetwork(payload.network);
  }

  async deleteParticipant(key: string): Promise<void> {
    this.assertParticipantKey(key);
    await this.credentials.deleteRecord(key);
  }

  async deleteOwnerNetwork(key: string): Promise<void> {
    this.assertOwnerKey(key);
    await this.credentials.deleteRecord(key);
  }

  private assertParticipantKey(key: string): void {
    if (!PARTICIPANT_KEY.test(key)) throw new Error("Participant credential key is invalid");
  }

  private assertOwnerKey(key: string): void {
    if (!OWNER_KEY.test(key)) throw new Error("Owner credential key is invalid");
  }
}
