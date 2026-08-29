import { CollabError, invalidInput } from "./errors.js";
import { EventLedger } from "./events.js";
import { RoomStore } from "./room.js";
import type {
  AgentDelivery,
  AgentQueueItem,
  AgentQueuePriority,
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

class DispatchPersistenceError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
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
      canDispatch?: (roomId: string, requestId: string) => boolean;
      commitCriticalState?: () => Promise<void>;
    },
  ) {}

  async submit(input: { principalId: string; message: AgentRequest }): Promise<QueueRecord> {
    return this.submitImmediate(input);
  }

  submitImmediate(input: { principalId: string; message: AgentRequest }): QueueRecord {
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
      priority: member.role === "host" ? "host" : "participant",
      messageRevision: 0,
      message: copy(message),
    };
    this.nextQueueSeq += 1;
    this.records.set(requestId, { record, fingerprint });
    this.queue.push(requestId);
    const actor = { memberId: member.memberId, principalId: member.principalId };
    try {
      this.options.ledger.append({
        eventId: requestId + ":created",
        roomId: message.roomId,
        type: "agent.request.created",
        actor,
        payload: {
          requestId,
          messageId: message.messageId,
          deliveryMode: message.deliveryMode,
          text: message.text,
          priority: record.priority,
        },
      });
      this.options.ledger.append({
        eventId: requestId + ":queued",
        roomId: message.roomId,
        type: "agent.request.queued",
        actor,
        payload: { requestId, messageId: message.messageId, queueSeq: record.queueSeq, priority: record.priority },
      });
    } catch (error) {
      this.records.delete(requestId);
      this.removeFromQueue(requestId);
      if (this.nextQueueSeq === record.queueSeq + 1) this.nextQueueSeq = record.queueSeq;
      throw error;
    }
    return copy(record);
  }

  queued(): QueueRecord[] {
    return this.queue
      .map((requestId) => this.records.get(requestId)?.record)
      .filter((record): record is QueueRecord => record !== undefined)
      .map(copy);
  }

  queueView(roomId?: string): AgentQueueItem[] {
    const active = [
      ...(this.activeRequestId ? [this.records.get(this.activeRequestId)?.record] : []),
      ...this.queue.map((requestId) => this.records.get(requestId)?.record),
    ]
      .filter((record): record is QueueRecord => record !== undefined)
      .filter((record, index, records) => records.findIndex((candidate) => candidate.requestId === record.requestId) === index)
      .filter((record) => roomId === undefined || record.roomId === roomId)
      .sort(compareQueueRecords);
    return active.map((record, index) => ({
      requestId: record.requestId,
      messageId: record.message.messageId,
      roomId: record.roomId,
      authorMemberId: record.authorMemberId,
      text: record.message.text,
      deliveryMode: record.deliveryMode,
      status: record.status === "running" ? "running" : "queued",
      queueSeq: record.queueSeq,
      position: index + 1,
      priority: record.priority,
    }));
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
    commitCriticalState?: () => Promise<void>;
    snapshot: DispatcherSnapshot;
  }): AgentDispatcher {
    if (!input.snapshot || input.snapshot.version !== 1) {
      throw new CollabError("SNAPSHOT_INVALID", "unsupported dispatcher snapshot");
    }
    const dispatcher = new AgentDispatcher({
      rooms: input.rooms,
      ledger: input.ledger,
      agent: input.agent,
      ...(input.commitCriticalState ? { commitCriticalState: input.commitCriticalState } : {}),
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
    for (const rawRecord of snapshot.records) {
      const record = {
        ...rawRecord,
        priority: rawRecord.priority ?? this.recordPriority(rawRecord),
        messageRevision: rawRecord.messageRevision ?? 0,
      };
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
    const queueIndex = this.nextDispatchableIndex();
    if (queueIndex < 0) return undefined;
    const [requestId] = this.queue.splice(queueIndex, 1);
    if (!requestId) return undefined;
    const entry = this.records.get(requestId);
    if (!entry) throw new CollabError("REQUEST_NOT_FOUND", "queued request disappeared", { requestId });

    const roomMembers = this.options.rooms.listMembers(entry.record.roomId);
    const member = roomMembers.find((candidate) => candidate.memberId === entry.record.authorMemberId);
    if (!member) {
      const error = "request author no longer exists";
      this.failQueued(entry.record, error, roomMembers.find((candidate) => candidate.role === "host")!);
      throw new CollabError("MEMBER_NOT_FOUND", error, { requestId });
    }
    try {
      this.options.rooms.authorize(
        entry.record.roomId,
        member.principalId,
        entry.record.deliveryMode === "steer" ? "steer" : "agentRequest",
      );
    } catch (error) {
      this.failQueued(entry.record, error instanceof Error ? error.message : String(error), member);
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
    try {
      await this.options.commitCriticalState?.();
    } catch (error) {
      entry.record.status = "queued";
      this.activeRequestId = undefined;
      this.queue.splice(Math.min(queueIndex, this.queue.length), 0, requestId);
      throw new DispatchPersistenceError(error);
    }

    const delivery: AgentDelivery = {
      requestId,
      roomId: entry.record.roomId,
      hostSessionId: entry.record.hostSessionId,
      authorMemberId: entry.record.authorMemberId,
      text: entry.record.message.text,
    };
    if (entry.record.message.contextRefs) {
      delivery.contextRefs = [...entry.record.message.contextRefs];
      const contextContent = entry.record.message.contextRefs.flatMap((reference) => {
        const event = this.options.ledger.readAfter(entry.record.roomId, 0, 500).find((candidate) => candidate.eventId === reference);
        const payload = event?.payload;
        return payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as { text?: unknown }).text === "string"
          ? [(payload as { text: string }).text]
          : [];
      });
      if (contextContent.length > 0) delivery.contextContent = contextContent;
    }
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
      await this.options.commitCriticalState?.();
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
      if (this.hasDispatchableRequest()) void this.processQueue();
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
    await this.options.commitCriticalState?.();
    return copy(entry.record);
  }

  async edit(input: { roomId: string; principalId: string; requestId: string; text: string }): Promise<QueueRecord> {
    const entry = this.records.get(input.requestId);
    if (!entry) throw new CollabError("REQUEST_NOT_FOUND", "request does not exist", { requestId: input.requestId });
    if (entry.record.roomId !== input.roomId) throw new CollabError("TOKEN_SCOPE", "request is scoped to another room", { roomId: input.roomId });
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "agentRequest");
    this.assertCanManageMessage(entry.record, member.memberId, member.role);
    if (entry.record.status !== "queued") throw new CollabError("REQUEST_STATE", "only queued requests can be edited", { requestId: input.requestId });
    entry.record.messageRevision += 1;
    entry.record.message = { ...entry.record.message, text: input.text };
    entry.fingerprint = JSON.stringify(entry.record.message);
    this.options.ledger.append({
      eventId: input.requestId + ":edited:" + String(entry.record.messageRevision),
      roomId: input.roomId,
      type: "agent.request.edited",
      actor: { memberId: member.memberId, principalId: member.principalId },
      payload: {
        requestId: input.requestId,
        messageId: entry.record.message.messageId,
        text: input.text,
        revision: entry.record.messageRevision,
      },
    });
    await this.options.commitCriticalState?.();
    return copy(entry.record);
  }

  async withdraw(input: { roomId: string; principalId: string; requestId: string }): Promise<QueueRecord> {
    const entry = this.records.get(input.requestId);
    if (!entry) throw new CollabError("REQUEST_NOT_FOUND", "request does not exist", { requestId: input.requestId });
    if (entry.record.roomId !== input.roomId) throw new CollabError("TOKEN_SCOPE", "request is scoped to another room", { roomId: input.roomId });
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "agentRequest");
    this.assertCanManageMessage(entry.record, member.memberId, member.role);
    if (entry.record.status === "withdrawn") return copy(entry.record);
    if (entry.record.status !== "queued") throw new CollabError("REQUEST_STATE", "only queued requests can be withdrawn", { requestId: input.requestId });
    this.removeFromQueue(input.requestId);
    entry.record.status = "withdrawn";
    this.options.ledger.append({
      eventId: input.requestId + ":withdrawn",
      roomId: input.roomId,
      type: "agent.request.withdrawn",
      actor: { memberId: member.memberId, principalId: member.principalId },
      payload: { requestId: input.requestId, messageId: entry.record.message.messageId },
    });
    await this.options.commitCriticalState?.();
    return copy(entry.record);
  }

  interruptActive(error: string): QueueRecord | undefined {
    const requestId = this.activeRequestId;
    if (!requestId) return undefined;
    const entry = this.records.get(requestId);
    if (!entry) throw new CollabError("REQUEST_NOT_FOUND", "active request does not exist", { requestId });
    const record = entry.record;
    entry.record.status = "failed";
    entry.record.error = error;
    this.activeRequestId = undefined;
    const member = this.options.rooms.listMembers(record.roomId).find((candidate) => candidate.memberId === record.authorMemberId);
    if (!member) throw new CollabError("MEMBER_NOT_FOUND", "request author no longer exists", { requestId });
    this.options.ledger.append({
      eventId: requestId + ":interrupted",
      roomId: record.roomId,
      type: "agent.request.failed",
      actor: { memberId: member.memberId, principalId: member.principalId },
      payload: { requestId, error },
    });
    this.schedulePersistenceCommit();
    return this.get(requestId);
  }

  failQueuedRequest(requestId: string, error: string): QueueRecord | undefined {
    const entry = this.records.get(requestId);
    if (!entry || entry.record.status !== "queued") return undefined;
    const members = this.options.rooms.listMembers(entry.record.roomId);
    const actor = members.find((member) => member.memberId === entry.record.authorMemberId)
      ?? members.find((member) => member.role === "host");
    if (!actor) throw new CollabError("MEMBER_NOT_FOUND", "request room has no active author or Host", { requestId });
    this.removeFromQueue(requestId);
    this.failQueued(entry.record, error, actor);
    return copy(entry.record);
  }

  async cancel(input: { roomId: string; principalId: string; requestId: string; keepInbox: boolean }): Promise<QueueRecord> {
    const entry = this.records.get(input.requestId);
    if (!entry) {
      throw new CollabError("REQUEST_NOT_FOUND", "request does not exist", { requestId: input.requestId });
    }
    if (entry.record.roomId !== input.roomId) {
      throw new CollabError("TOKEN_SCOPE", "request is scoped to another room", { roomId: input.roomId });
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
        if (!queued || queued.record.status !== "queued" || queued.record.roomId !== entry.record.roomId) continue;
        queued.record.status = "cancelled";
        this.appendCancelled(queued.record, member);
        this.removeFromQueue(queuedRequestId);
      }
    }
    return copy(entry.record);
  }

  private removeFromQueue(requestId: string): void {
    const index = this.queue.indexOf(requestId);
    if (index >= 0) this.queue.splice(index, 1);
  }

  private nextDispatchableIndex(): number {
    let bestIndex = -1;
    for (let index = 0; index < this.queue.length; index += 1) {
      const requestId = this.queue[index]!;
      const roomId = this.records.get(requestId)?.record.roomId;
      if (roomId === undefined || !(this.options.canDispatch?.(roomId, requestId) ?? true)) continue;
      if (bestIndex < 0 || compareQueueRecords(this.records.get(requestId)!.record, this.records.get(this.queue[bestIndex]!)!.record) < 0) {
        bestIndex = index;
      }
    }
    return bestIndex;
  }

  private hasDispatchableRequest(): boolean {
    return this.nextDispatchableIndex() >= 0;
  }

  private async drainQueue(): Promise<void> {
    while (this.activeRequestId === undefined && this.queue.length > 0) {
      let record: QueueRecord | undefined;
      try {
        record = await this.drainOne();
      } catch (error) {
        if (error instanceof DispatchPersistenceError) return;
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
        await this.failRunning(record, error instanceof Error ? error.message : String(error));
        continue;
      }
      if (this.activeRequestId === record.requestId && this.records.get(record.requestId)?.record.status === "running") {
        try {
          if (result?.error) {
            await this.failRunning(record, result.error);
            continue;
          }
          if (result?.text) await this.appendAgentOutput(record, result.text);
          await this.complete(record.requestId);
        } catch (error) {
          if (this.activeRequestId === record.requestId && this.records.get(record.requestId)?.record.status === "running") {
            await this.failRunning(record, `Agent result persistence failed: ${error instanceof Error ? error.message : String(error)}`)
              .catch(() => undefined);
          }
          continue;
        }
      }
    }
  }

  private async failRunning(record: QueueRecord, error: string, eventId = record.requestId + ":failed"): Promise<void> {
    const entry = this.records.get(record.requestId);
    if (!entry || entry.record.status !== "running" || this.activeRequestId !== record.requestId) return;
    const member = this.options.rooms.listMembers(record.roomId).find((candidate) => candidate.memberId === record.authorMemberId);
    if (!member) throw new CollabError("MEMBER_NOT_FOUND", "request author no longer exists", { requestId: record.requestId });
    entry.record.status = "failed";
    entry.record.error = error;
    this.activeRequestId = undefined;
    this.options.ledger.append({
      eventId,
      roomId: record.roomId,
      type: "agent.request.failed",
      actor: { memberId: member.memberId, principalId: member.principalId },
      payload: { requestId: record.requestId, error },
    });
    await this.options.commitCriticalState?.();
  }

  private failQueued(record: QueueRecord, error: string, actor: { memberId: string; principalId: string }): void {
    const entry = this.records.get(record.requestId);
    if (!entry || entry.record.status !== "queued") return;
    entry.record.status = "failed";
    entry.record.error = error;
    this.options.ledger.append({
      eventId: record.requestId + ":failed",
      roomId: record.roomId,
      type: "agent.request.failed",
      actor: { memberId: actor.memberId, principalId: actor.principalId },
      payload: { requestId: record.requestId, error },
    });
    this.schedulePersistenceCommit();
  }

  private async appendAgentOutput(record: QueueRecord, text: string): Promise<void> {
    const host = this.options.rooms.listMembers(record.roomId).find((member) => member.role === "host");
    if (!host) throw new CollabError("MEMBER_NOT_FOUND", "room host no longer exists", { roomId: record.roomId });
    this.options.ledger.append({
      eventId: record.requestId + ":output",
      roomId: record.roomId,
      type: "agent.state.changed",
      actor: { memberId: host.memberId, principalId: host.principalId },
      payload: { requestId: record.requestId, state: "output", text },
    });
    await this.options.commitCriticalState?.();
  }

  private schedulePersistenceCommit(): void {
    const commit = this.options.commitCriticalState?.();
    if (commit) void commit.catch(() => undefined);
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

  private recordPriority(record: QueueRecord): AgentQueuePriority {
    const member = this.options.rooms.listMembers(record.roomId).find((candidate) => candidate.memberId === record.authorMemberId);
    return member?.role === "host" ? "host" : "participant";
  }

  private assertCanManageMessage(record: QueueRecord, memberId: string, role: string): void {
    if (role !== "host" && record.authorMemberId !== memberId) {
      throw new CollabError("ACTION_FORBIDDEN", "members can only manage their own Agent requests", { requestId: record.requestId });
    }
  }
}

function compareQueueRecords(left: QueueRecord, right: QueueRecord): number {
  const priority = (right.priority === "host" ? 1 : 0) - (left.priority === "host" ? 1 : 0);
  return priority || left.queueSeq - right.queueSeq;
}

function isQueueStatus(value: string): value is QueueStatus {
  return value === "queued"
    || value === "running"
    || value === "completed"
    || value === "failed"
    || value === "cancelled"
    || value === "withdrawn";
}
