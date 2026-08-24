import { CollabError, invalidInput } from "./errors.js";
import { EventLedger } from "./events.js";
import { RoomStore } from "./room.js";
import type {
  AgentDelivery,
  AgentRequest,
  HostAgentPort,
  QueueRecord,
} from "./types.js";

function copy<T>(value: T): T {
  return structuredClone(value);
}

function actorFor(room: RoomStore, roomId: string, principalId: string, action: "agentRequest" | "steer") {
  return room.authorize(roomId, principalId, action);
}

export class AgentDispatcher {
  private readonly records = new Map<string, { record: QueueRecord; fingerprint: string }>();
  private readonly queue: string[] = [];
  private activeRequestId: string | undefined;
  private nextQueueSeq = 1;

  constructor(
    private readonly options: {
      rooms: RoomStore;
      ledger: EventLedger;
      agent: HostAgentPort;
    },
  ) {}

  async submit(input: { principalId: string; message: AgentRequest }): Promise<QueueRecord> {
    const message = input.message;
    if (message.kind !== "agent-request" || message.target !== "dsh") {
      throw invalidInput("dispatcher accepts only agent requests");
    }
    const action = message.deliveryMode === "steer" ? "steer" : "agentRequest";
    const member = actorFor(this.options.rooms, message.roomId, input.principalId, action);
    if (member.memberId !== message.authorMemberId) {
      throw new CollabError("ACTION_FORBIDDEN", "request author does not match the authenticated member", {
        memberId: member.memberId,
      });
    }

    const requestId = message.messageId;
    const fingerprint = JSON.stringify(message);
    const existing = this.records.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new CollabError("REQUEST_CONFLICT", "request id was already used for different data", { requestId });
      }
      return copy(existing.record);
    }

    const room = this.options.rooms.getRoom(message.roomId);
    const record: QueueRecord = {
      requestId,
      roomId: message.roomId,
      hostSessionId: room.hostSessionId,
      authorMemberId: member.memberId,
      deliveryMode: message.deliveryMode,
      status: "queued",
      queueSeq: this.nextQueueSeq,
      message: copy(message),
    };
    this.nextQueueSeq += 1;
    this.records.set(requestId, { record, fingerprint });
    this.queue.push(requestId);
    const actor = { memberId: member.memberId, principalId: member.principalId };
    this.options.ledger.append({
      eventId: requestId + ":created",
      roomId: message.roomId,
      type: "agent.request.created",
      actor,
      payload: { requestId, deliveryMode: message.deliveryMode },
    });
    this.options.ledger.append({
      eventId: requestId + ":queued",
      roomId: message.roomId,
      type: "agent.request.queued",
      actor,
      payload: { requestId, queueSeq: record.queueSeq },
    });
    return copy(record);
  }

  queued(): QueueRecord[] {
    return this.queue
      .map((requestId) => this.records.get(requestId)?.record)
      .filter((record): record is QueueRecord => record !== undefined)
      .map(copy);
  }

  async drainOne(): Promise<QueueRecord | undefined> {
    if (this.activeRequestId !== undefined) return undefined;
    const requestId = this.queue.shift();
    if (!requestId) return undefined;
    const entry = this.records.get(requestId);
    if (!entry) throw new CollabError("REQUEST_NOT_FOUND", "queued request disappeared", { requestId });

    const member = this.options.rooms.listMembers(entry.record.roomId).find((candidate) => candidate.memberId === entry.record.authorMemberId);
    if (!member) {
      entry.record.status = "failed";
      entry.record.error = "request author no longer exists";
      throw new CollabError("MEMBER_NOT_FOUND", entry.record.error, { requestId });
    }
    try {
      this.options.rooms.authorize(
        entry.record.roomId,
        member.principalId,
        entry.record.deliveryMode === "steer" ? "steer" : "agentRequest",
      );
    } catch (error) {
      entry.record.status = "failed";
      entry.record.error = error instanceof Error ? error.message : String(error);
      throw error;
    }
    entry.record.status = "running";
    this.activeRequestId = requestId;
    this.options.ledger.append({
      eventId: requestId + ":claimed",
      roomId: entry.record.roomId,
      type: "agent.request.claimed",
      actor: { memberId: member.memberId, principalId: member.principalId },
      payload: { requestId, hostSessionId: entry.record.hostSessionId },
    });

    const delivery: AgentDelivery = {
      requestId,
      roomId: entry.record.roomId,
      hostSessionId: entry.record.hostSessionId,
      authorMemberId: entry.record.authorMemberId,
      text: entry.record.message.text,
    };
    if (entry.record.message.contextRefs) delivery.contextRefs = [...entry.record.message.contextRefs];
    try {
      await this.options.agent[entry.record.deliveryMode](delivery);
    } catch (error) {
      entry.record.status = "failed";
      entry.record.error = error instanceof Error ? error.message : String(error);
      this.activeRequestId = undefined;
      this.options.ledger.append({
        eventId: requestId + ":failed",
        roomId: entry.record.roomId,
        type: "agent.request.failed",
        actor: { memberId: member.memberId, principalId: member.principalId },
        payload: { requestId, error: entry.record.error },
      });
      throw error;
    }
    return copy(entry.record);
  }

  async complete(requestId: string): Promise<QueueRecord> {
    const entry = this.records.get(requestId);
    if (!entry) throw new CollabError("REQUEST_NOT_FOUND", "request does not exist", { requestId });
    if (this.activeRequestId !== requestId || entry.record.status !== "running") {
      throw new CollabError("REQUEST_STATE", "only the active request can complete", { requestId });
    }
    entry.record.status = "completed";
    this.activeRequestId = undefined;
    const member = this.options.rooms.listMembers(entry.record.roomId).find((candidate) => candidate.memberId === entry.record.authorMemberId);
    if (!member) throw new CollabError("MEMBER_NOT_FOUND", "request author no longer exists", { requestId });
    this.options.ledger.append({
      eventId: requestId + ":completed",
      roomId: entry.record.roomId,
      type: "agent.request.completed",
      actor: { memberId: member.memberId, principalId: member.principalId },
      payload: { requestId },
    });
    return copy(entry.record);
  }
}
