import { CollabError, invalidInput } from "./errors.js";

export interface ResourceLimitOptions {
  maxRooms?: number;
  maxMembersPerRoom?: number;
  maxConnectionsPerRoom?: number;
  maxMessagesPerMemberPerWindow?: number;
  messageWindowMs?: number;
  maxQueuedRequestsPerRoom?: number;
  maxOutputBytes?: number;
}

function positive(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput(field + " must be a positive integer", { field });
  return value;
}

export class ResourceLimiter {
  private readonly rooms: number | undefined;
  private readonly members: number | undefined;
  private readonly connections: number | undefined;
  private readonly messages: number | undefined;
  private readonly windowMs: number;
  private readonly queue: number | undefined;
  private readonly outputBytes: number | undefined;
  private readonly activeConnections = new Map<string, number>();
  private readonly messageTimes = new Map<string, number[]>();

  constructor(options: ResourceLimitOptions = {}) {
    this.rooms = positive(options.maxRooms, "maxRooms");
    this.members = positive(options.maxMembersPerRoom, "maxMembersPerRoom");
    this.connections = positive(options.maxConnectionsPerRoom, "maxConnectionsPerRoom");
    this.messages = positive(options.maxMessagesPerMemberPerWindow, "maxMessagesPerMemberPerWindow");
    this.windowMs = positive(options.messageWindowMs, "messageWindowMs") ?? 60_000;
    this.queue = positive(options.maxQueuedRequestsPerRoom, "maxQueuedRequestsPerRoom");
    this.outputBytes = positive(options.maxOutputBytes, "maxOutputBytes");
  }

  checkRooms(count: number): void {
    this.checkCount(count, "rooms", this.rooms, "room resource limit");
  }

  checkMembers(roomId: string, count: number): void {
    this.checkCount(count, "members", this.members, "member resource limit", roomId);
  }

  acquireConnection(roomId: string): void {
    const current = this.activeConnections.get(roomId) ?? 0;
    this.checkCount(current + 1, "connections", this.connections, "connection resource limit", roomId);
    this.activeConnections.set(roomId, current + 1);
  }

  releaseConnection(roomId: string): void {
    const current = this.activeConnections.get(roomId) ?? 0;
    if (current <= 1) this.activeConnections.delete(roomId);
    else this.activeConnections.set(roomId, current - 1);
  }

  checkQueue(roomId: string, depth: number): void {
    this.checkCount(depth, "queue", this.queue, "queue resource limit", roomId);
  }

  consumeMessage(roomId: string, memberId: string, now: number): void {
    if (!Number.isSafeInteger(now) || now < 0) throw invalidInput("now must be a non-negative integer", { now });
    if (this.messages === undefined) return;
    const key = roomId + ":" + memberId;
    const valid = (this.messageTimes.get(key) ?? []).filter((timestamp) => timestamp >= now - this.windowMs);
    if (valid.length >= this.messages) throw new CollabError("RESOURCE_LIMIT", "message rate limit exceeded", { roomId, memberId });
    valid.push(now);
    this.messageTimes.set(key, valid);
  }

  acceptOutput(bytes: number): void {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw invalidInput("output bytes must be a non-negative integer", { bytes });
    if (this.outputBytes !== undefined && bytes > this.outputBytes) {
      throw new CollabError("RESOURCE_LIMIT", "output resource limit exceeded", { bytes, maxOutputBytes: this.outputBytes });
    }
  }

  private checkCount(count: number, field: string, limit: number | undefined, message: string, scope?: string): void {
    if (!Number.isSafeInteger(count) || count < 0) throw invalidInput(field + " count must be a non-negative integer", { field });
    if (limit !== undefined && count > limit) throw new CollabError("RESOURCE_LIMIT", message, { field, scope, limit, count });
  }
}
