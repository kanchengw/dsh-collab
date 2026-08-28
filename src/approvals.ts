import { CollabError, invalidInput } from "./errors.js";
import { EventLedger } from "./events.js";
import { RoomStore } from "./room.js";

export type ApprovalOutcome = "allowed-once" | "allowed-always" | "rejected" | "cancelled" | "unavailable";
export type ApprovalState = "pending" | "decided" | "expired";

export interface ApprovalView {
  approvalId: string;
  roomId: string;
  hostSessionId: string;
  requesterMemberId: string;
  requesterPrincipalId: string;
  toolName: string;
  reason: string;
  createdAt: number;
  expiresAt: number;
  state: ApprovalState;
  outcome?: ApprovalOutcome;
  decidedAt?: number;
  decidedByMemberId?: string;
}

export interface ApprovalStoreSnapshot {
  version: 1;
  records: ApprovalView[];
}

export interface ApprovalRequestInput {
  approvalId: string;
  roomId: string;
  requesterPrincipalId: string;
  toolName: string;
  reason: string;
  expiresAt: number;
  now?: number;
}

export interface ApprovalDecisionInput {
  approvalId: string;
  roomId: string;
  principalId: string;
  outcome: ApprovalOutcome;
  now?: number;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(field + " must not be blank", { field });
  return value.trim();
}

function time(value: number | undefined, field: string): number {
  const normalized = value ?? Date.now();
  if (!Number.isSafeInteger(normalized) || normalized < 0) throw invalidInput(field + " must be a non-negative integer", { field });
  return normalized;
}

function outcome(value: string): value is ApprovalOutcome {
  return value === "allowed-once" || value === "allowed-always" || value === "rejected" || value === "cancelled" || value === "unavailable";
}

export class ApprovalStore {
  private readonly records = new Map<string, { view: ApprovalView; fingerprint: string }>();
  private readonly hasAnswerer: boolean;

  constructor(private readonly options: { rooms: RoomStore; ledger: EventLedger; answerer?: object }) {
    this.hasAnswerer = options.answerer !== undefined;
  }

  request(input: ApprovalRequestInput): ApprovalView {
    const approvalId = text(input.approvalId, "approvalId");
    const roomId = text(input.roomId, "roomId");
    const now = time(input.now, "now");
    const expiresAt = time(input.expiresAt, "expiresAt");
    if (expiresAt <= now) throw invalidInput("expiresAt must be after now", { expiresAt, now });
    const member = this.options.rooms.authorize(roomId, text(input.requesterPrincipalId, "requesterPrincipalId"), "approval");
    const toolName = text(input.toolName, "toolName");
    const reason = text(input.reason, "reason");
    const fingerprint = JSON.stringify({ roomId, requesterMemberId: member.memberId, toolName, reason, expiresAt });
    const existing = this.records.get(approvalId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new CollabError("REQUEST_CONFLICT", "approval id was already used for different data", { approvalId });
      return copy(existing.view);
    }

    const room = this.options.rooms.getRoom(roomId);
    const view: ApprovalView = {
      approvalId,
      roomId,
      hostSessionId: room.hostSessionId,
      requesterMemberId: member.memberId,
      requesterPrincipalId: member.principalId,
      toolName,
      reason,
      createdAt: now,
      expiresAt,
      state: "pending",
    };
    this.records.set(approvalId, { view, fingerprint });
    this.append(view, "approval.requested", member.memberId, member.principalId);
    if (!this.hasAnswerer) this.finish(view, "unavailable", now);
    return copy(view);
  }

  get(approvalId: string, now = Date.now()): ApprovalView | undefined {
    const entry = this.records.get(text(approvalId, "approvalId"));
    if (!entry) return undefined;
    this.expire(entry.view, time(now, "now"));
    return copy(entry.view);
  }

  list(roomId: string, now = Date.now()): ApprovalView[] {
    const normalizedRoomId = text(roomId, "roomId");
    return [...this.records.values()]
      .filter(({ view }) => view.roomId === normalizedRoomId)
      .map(({ view }) => this.get(view.approvalId, now)!)
      .map(copy);
  }

  decide(input: ApprovalDecisionInput): ApprovalView {
    const approvalId = text(input.approvalId, "approvalId");
    const entry = this.records.get(approvalId);
    if (!entry) throw new CollabError("REQUEST_NOT_FOUND", "approval does not exist", { approvalId });
    const roomId = text(input.roomId, "roomId");
    if (entry.view.roomId !== roomId) throw new CollabError("TOKEN_SCOPE", "approval is scoped to another room", { roomId });
    const member = this.options.rooms.authorize(roomId, text(input.principalId, "principalId"), "approval");
    const now = time(input.now, "now");
    this.expire(entry.view, now);
    if (entry.view.state === "expired") throw new CollabError("REQUEST_STATE", "approval has expired", { approvalId });
    if (entry.view.state === "decided") {
      if (entry.view.outcome === input.outcome) return copy(entry.view);
      throw new CollabError("REQUEST_CONFLICT", "approval was already decided", { approvalId });
    }
    if (!outcome(input.outcome)) throw invalidInput("approval outcome is not supported", { outcome: input.outcome });
    this.finish(entry.view, input.outcome, now, member.memberId, member.principalId);
    return copy(entry.view);
  }

  snapshot(): ApprovalStoreSnapshot {
    return { version: 1, records: [...this.records.values()].map(({ view }) => copy(view)) };
  }

  static fromSnapshot(input: { rooms: RoomStore; ledger: EventLedger; answerer?: object; snapshot: ApprovalStoreSnapshot }): ApprovalStore {
    if (!input.snapshot || input.snapshot.version !== 1 || !Array.isArray(input.snapshot.records)) {
      throw new CollabError("SNAPSHOT_INVALID", "invalid approval snapshot");
    }
    const store = new ApprovalStore({ rooms: input.rooms, ledger: input.ledger, answerer: input.answerer });
    for (const view of input.snapshot.records) {
      if (!view || !text(view.approvalId, "approvalId") || !outcome(view.outcome ?? "unavailable") && view.state === "decided") {
        throw new CollabError("SNAPSHOT_INVALID", "invalid approval record");
      }
      const fingerprint = JSON.stringify({ roomId: view.roomId, requesterMemberId: view.requesterMemberId, toolName: view.toolName, reason: view.reason, expiresAt: view.expiresAt });
      if (store.records.has(view.approvalId)) throw new CollabError("SNAPSHOT_INVALID", "duplicate approval record", { approvalId: view.approvalId });
      store.records.set(view.approvalId, { view: copy(view), fingerprint });
    }
    return store;
  }

  private expire(view: ApprovalView, now: number): void {
    if (view.state === "pending" && now >= view.expiresAt) this.finish(view, "unavailable", now, undefined, undefined, "expired");
  }

  private finish(view: ApprovalView, result: ApprovalOutcome, now: number, memberId?: string, principalId?: string, state: ApprovalState = "decided"): void {
    view.state = state;
    view.outcome = result;
    view.decidedAt = now;
    if (memberId) view.decidedByMemberId = memberId;
    this.append(view, "approval.decided", memberId ?? view.requesterMemberId, principalId ?? view.requesterPrincipalId);
  }

  private append(view: ApprovalView, type: "approval.requested" | "approval.decided", memberId: string, principalId: string): void {
    this.options.ledger.append({
      eventId: view.approvalId + ":" + type,
      roomId: view.roomId,
      type,
      actor: { memberId, principalId },
      createdAt: type === "approval.requested" ? view.createdAt : view.decidedAt,
      payload: { approvalId: view.approvalId, state: view.state, outcome: view.outcome, toolName: view.toolName },
    });
  }
}
