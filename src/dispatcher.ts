import { CollabError, invalidInput } from "./errors.js";
import { EventLedger } from "./events.js";
import { RoomStore } from "./room.js";
import type {
  AgentDelivery,
  AgentRequest,
  DispatcherSnapshot,
  HostAgentPort,
  QueueRecord,
  QueueStatus,
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
  private processing: Promise<void> | undefined;

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

    const requestId = message.requestId ?? message.messageId;
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
      payload: { requestId, deliveryMode: message.deliveryMode, text: message.text },
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

  get(requestId: string): QueueRecord | undefined {
    const record = this.records.get(requestId)?.record;
    return record ? copy(record) : undefined;
  }

  snapshot(): DispatcherSnapshot {
    const snapshot: DispatcherSnapshot = {
      version: 1,
      records: [...this.records.values()].map((entry) => copy(entry.record)),
      queue: [...this.queue],
      nextQueueSeq: this.nextQueueSeq,
    };
    if (this.activeRequestId !== undefined) snapshot.activeRequestId = this.activeRequestId;
    return snapshot;
  }

  static fromSnapshot(input: {
    rooms: RoomStore;
    ledger: EventLedger;
    agent: HostAgentPort;
    snapshot: DispatcherSnapshot;
  }): AgentDispatcher {
    if (!input.snapshot || input.snapshot.version !== 1) {
      throw new CollabError("SNAPSHOT_INVALID", "unsupported dispatcher snapshot");
    }
    const dispatcher = new AgentDispatcher({
      rooms: input.rooms,
      ledger: input.ledger,
      agent: input.agent,
    });
    dispatcher.restore(input.snapshot);
    return dispatcher;
  }

  restore(snapshot: DispatcherSnapshot): void {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.records) || !Array.isArray(snapshot.queue)) {
      throw new CollabError("SNAPSHOT_INVALID", "invalid dispatcher snapshot");
    }
    if (!Number.isSafeInteger(snapshot.nextQueueSeq) || snapshot.nextQueueSeq < 1) {
      throw new CollabError("SNAPSHOT_INVALID", "invalid dispatcher queue sequence");
    }
    const records = new Map<string, { record: QueueRecord; fingerprint: string }>();
    for (const record of snapshot.records) {
      if (!record.requestId || records.has(record.requestId) || !isQueueStatus(record.status)
        || (record.claimAttempt !== undefined && (!Number.isSafeInteger(record.claimAttempt) || record.claimAttempt < 1))) {
        throw new CollabError("SNAPSHOT_INVALID", "invalid dispatcher record");
      }
      records.set(record.requestId, { record: copy(record), fingerprint: JSON.stringify(record.message) });
    }
    const queued = new Set<string>();
    for (const requestId of snapshot.queue) {
      const record = records.get(requestId)?.record;
      if (!record || record.status !== "queued" || queued.has(requestId)) {
        throw new CollabError("SNAPSHOT_INVALID", "dispatcher queue does not match records");
      }
      queued.add(requestId);
    }
    if (snapshot.activeRequestId !== undefined) {
      const active = records.get(snapshot.activeRequestId)?.record;
      if (!active || active.status !== "running") {
        throw new CollabError("SNAPSHOT_INVALID", "dispatcher active request is not running");
      }
    }
    this.records.clear();
    for (const [requestId, record] of records) this.records.set(requestId, record);
    this.queue.length = 0;
    this.queue.push(...snapshot.queue);
    this.activeRequestId = snapshot.activeRequestId;
    this.nextQueueSeq = snapshot.nextQueueSeq;
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
    const claimAttempt = (entry.record.claimAttempt ?? 0) + 1;
    entry.record.claimAttempt = claimAttempt;
    this.options.ledger.append({
      eventId: requestId + ":claimed" + (claimAttempt === 1 ? "" : ":" + String(claimAttempt)),
      roomId: entry.record.roomId,
      type: "agent.request.claimed",
      actor: { memberId: member.memberId, principalId: member.principalId },
      payload: { requestId, hostSessionId: entry.record.hostSessionId, claimAttempt },
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

  processQueue(): Promise<void> {
    if (this.processing) return this.processing;
    const processing = this.drainQueue();
    this.processing = processing;
    void processing.finally(() => {
      if (this.processing === processing) this.processing = undefined;
      if (this.queue.length > 0) void this.processQueue();
    });
    return processing;
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

  async cancel(input: { principalId: string; requestId: string; keepInbox: boolean }): Promise<QueueRecord> {
    const entry = this.records.get(input.requestId);
    if (!entry) {
      throw new CollabError("REQUEST_NOT_FOUND", "request does not exist", { requestId: input.requestId });
    }
    const member = this.options.rooms.authorize(entry.record.roomId, input.principalId, "cancel");
    if (entry.record.status === "completed" || entry.record.status === "failed" || entry.record.status === "cancelled") {
      return copy(entry.record);
    }
    if (entry.record.status === "queued") {
      this.removeFromQueue(input.requestId);
      entry.record.status = "cancelled";
      this.appendCancelled(entry.record, member);
      return copy(entry.record);
    }
    if (this.activeRequestId !== input.requestId || entry.record.status !== "running") {
      throw new CollabError("REQUEST_STATE", "request is not cancellable", { requestId: input.requestId });
    }

    await this.options.agent.cancel({
      requestId: input.requestId,
      roomId: entry.record.roomId,
      hostSessionId: entry.record.hostSessionId,
      keepInbox: input.keepInbox,
    });
    entry.record.status = "cancelled";
    this.activeRequestId = undefined;
    this.appendCancelled(entry.record, member);

    if (!input.keepInbox) {
      for (const queuedRequestId of [...this.queue]) {
        const queued = this.records.get(queuedRequestId);
        if (!queued || queued.record.status !== "queued") continue;
        queued.record.status = "cancelled";
        this.appendCancelled(queued.record, member);
      }
      this.queue.length = 0;
    }
    return copy(entry.record);
  }

  private removeFromQueue(requestId: string): void {
    const index = this.queue.indexOf(requestId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private async drainQueue(): Promise<void> {
    while (this.activeRequestId === undefined && this.queue.length > 0) {
      let record: QueueRecord | undefined;
      try {
        record = await this.drainOne();
      } catch {
        continue;
      }
      if (!record) return;
      let result;
      try {
        result = await this.options.agent.whenIdle?.({
          requestId: record.requestId,
          roomId: record.roomId,
          hostSessionId: record.hostSessionId,
        });
      } catch (error) {
        this.failRunning(record, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (this.activeRequestId === record.requestId && this.records.get(record.requestId)?.record.status === "running") {
        try {
          if (result?.error) {
            this.failRunning(record, result.error);
            continue;
          }
          if (result?.text) this.appendAgentOutput(record, result.text);
          await this.complete(record.requestId);
        } catch {
          continue;
        }
      }
    }
  }

  private failRunning(record: QueueRecord, error: string): void {
    const entry = this.records.get(record.requestId);
    if (!entry || entry.record.status !== "running" || this.activeRequestId !== record.requestId) return;
    const member = this.options.rooms.listMembers(record.roomId).find((candidate) => candidate.memberId === record.authorMemberId);
    if (!member) throw new CollabError("MEMBER_NOT_FOUND", "request author no longer exists", { requestId: record.requestId });
    entry.record.status = "failed";
    entry.record.error = error;
    this.activeRequestId = undefined;
    this.options.ledger.append({
      eventId: record.requestId + ":failed",
      roomId: record.roomId,
      type: "agent.request.failed",
      actor: { memberId: member.memberId, principalId: member.principalId },
      payload: { requestId: record.requestId, error },
    });
  }

  private appendAgentOutput(record: QueueRecord, text: string): void {
    const host = this.options.rooms.listMembers(record.roomId).find((member) => member.role === "host");
    if (!host) throw new CollabError("MEMBER_NOT_FOUND", "room host no longer exists", { roomId: record.roomId });
    this.options.ledger.append({
      eventId: record.requestId + ":output",
      roomId: record.roomId,
      type: "agent.state.changed",
      actor: { memberId: host.memberId, principalId: host.principalId },
      payload: { requestId: record.requestId, state: "output", text },
    });
  }

  private appendCancelled(record: QueueRecord, actor: { memberId: string; principalId: string }): void {
    this.options.ledger.append({
      eventId: record.requestId + ":cancelled",
      roomId: record.roomId,
      type: "agent.request.cancelled",
      actor: { memberId: actor.memberId, principalId: actor.principalId },
      payload: { requestId: record.requestId },
    });
  }
}

function isQueueStatus(value: string): value is QueueStatus {
  return value === "queued"
    || value === "running"
    || value === "completed"
    || value === "failed"
    || value === "cancelled";
}
