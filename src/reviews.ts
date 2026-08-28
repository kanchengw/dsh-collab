import { createHash } from "node:crypto";
import type {
  ReviewFinding,
  ReviewFindingLocation,
  ReviewFindingPage,
  ReviewLifecycle,
  ReviewPoint,
} from "./collaboration-types.js";
import { CollabError, invalidInput } from "./errors.js";
import { ReviewPointService } from "./review-points.js";
import { RoomStore } from "./room.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_FINDINGS_PER_ROOM = 1_000;

export interface ReviewServiceSnapshot {
  version: 1;
  findings: ReviewFinding[];
}

interface ReviewServiceOptions {
  rooms: RoomStore;
  reviewPoints: ReviewPointService;
  now?: () => number;
}

function text(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(`${field} must not be blank`, { field });
  const normalized = value.trim();
  if (normalized.length > maxLength) throw invalidInput(`${field} is too long`, { field, maxLength });
  return normalized;
}

function requestId(value: string): string {
  return text(value, "clientRequestId", 128);
}

function findingId(roomId: string, principalId: string, clientRequestId: string): string {
  return createHash("sha256").update(`${roomId}\0${principalId}\0review-finding\0${clientRequestId}`).digest("hex");
}

function severity(value: ReviewFinding["severity"]): ReviewFinding["severity"] {
  if (!["critical", "high", "medium", "low", "note"].includes(value)) throw invalidInput("finding severity is invalid");
  return value;
}

function location(value: ReviewFindingLocation, point: ReviewPoint): ReviewFindingLocation {
  if (!value || typeof value !== "object" || !["general", "file", "line"].includes(value.kind)) {
    throw invalidInput("finding location is invalid");
  }
  if (value.kind === "general") return { kind: "general" };
  if (typeof value.path !== "string" || !point.files.some((file) => file.path === value.path)) {
    throw invalidInput("finding path is not part of the Review Point", { path: value.path });
  }
  if (value.kind === "file") return { kind: "file", path: value.path };
  if (!Number.isSafeInteger(value.line) || value.line < 1) throw invalidInput("finding line must be a positive integer");
  return { kind: "line", path: value.path, line: value.line };
}

function validateRestoredFinding(value: ReviewFinding, options: ReviewServiceOptions, points: ReadonlyMap<string, ReviewPoint>): ReviewFinding {
  const point = points.get(value?.reviewPointId);
  if (!value || !/^[a-f0-9]{64}$/.test(value.findingId) || typeof value.roomId !== "string" || !point || point.roomId !== value.roomId
    || typeof value.authorId !== "string" || !options.rooms.listMembers(value.roomId).some((member) => member.memberId === value.authorId)
    || !["open", "accepted", "dismissed", "resolved"].includes(value.state)
    || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || (value.state === "open" ? value.decidedBy !== undefined || value.decidedAt !== undefined
      : typeof value.decidedBy !== "string" || typeof value.decidedAt !== "number" || !Number.isSafeInteger(value.decidedAt) || value.decidedAt < 0)) {
    throw new CollabError("SNAPSHOT_INVALID", "Review finding snapshot is invalid");
  }
  severity(value.severity);
  text(value.body, "body", 4_000);
  location(value.location, point);
  if (value.decidedBy !== undefined && !options.rooms.listMembers(value.roomId).some((member) => member.memberId === value.decidedBy && member.role === "host")) {
    throw new CollabError("SNAPSHOT_INVALID", "Review finding decision member is invalid");
  }
  return structuredClone(value);
}

export class ReviewService {
  private readonly findings: ReviewFinding[] = [];
  private readonly byId = new Map<string, ReviewFinding>();
  private readonly byPoint = new Map<string, ReviewFinding[]>();
  private readonly listeners = new Set<() => void>();
  private readonly now: () => number;

  constructor(private readonly options: ReviewServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  static fromSnapshot(options: ReviewServiceOptions, snapshot: ReviewServiceSnapshot): ReviewService {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.findings)) {
      throw new CollabError("SNAPSHOT_INVALID", "Review snapshot is invalid");
    }
    const service = new ReviewService(options);
    const points = new Map(options.reviewPoints.snapshot().reviewPoints.map((point) => [point.reviewPointId, point]));
    const roomCounts = new Map<string, number>();
    for (const raw of snapshot.findings) {
      let finding: ReviewFinding;
      try {
        finding = validateRestoredFinding(raw, options, points);
      } catch (error) {
        if (error instanceof CollabError && error.code === "SNAPSHOT_INVALID") throw error;
        throw new CollabError("SNAPSHOT_INVALID", "Review finding snapshot is invalid");
      }
      if (service.byId.has(finding.findingId)) throw new CollabError("SNAPSHOT_INVALID", "Review snapshot contains duplicate findings");
      const roomCount = (roomCounts.get(finding.roomId) ?? 0) + 1;
      if (roomCount > MAX_FINDINGS_PER_ROOM) throw new CollabError("SNAPSHOT_INVALID", "Review finding snapshot exceeds the room limit");
      roomCounts.set(finding.roomId, roomCount);
      service.add(finding);
    }
    return service;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  createFinding(input: {
    roomId: string;
    principalId: string;
    reviewPointId: string;
    clientRequestId: string;
    severity: ReviewFinding["severity"];
    location: ReviewFindingLocation;
    body: string;
  }): ReviewFinding {
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    const point = this.options.reviewPoints.get(input);
    const id = findingId(input.roomId, input.principalId, requestId(input.clientRequestId));
    const existing = this.byId.get(id);
    const finding: ReviewFinding = {
      findingId: id,
      roomId: input.roomId,
      reviewPointId: point.reviewPointId,
      authorId: member.memberId,
      severity: severity(input.severity),
      location: location(input.location, point),
      body: text(input.body, "body", 4_000),
      state: "open",
      createdAt: existing?.createdAt ?? this.now(),
    };
    if (existing) {
      const sameCreatePayload = existing.roomId === finding.roomId
        && existing.reviewPointId === finding.reviewPointId
        && existing.authorId === finding.authorId
        && existing.severity === finding.severity
        && JSON.stringify(existing.location) === JSON.stringify(finding.location)
        && existing.body === finding.body;
      if (!sameCreatePayload) throw new CollabError("REQUEST_CONFLICT", "Review finding request conflicts with an existing request");
      return structuredClone(existing);
    }
    if (this.options.rooms.getRoom(input.roomId).state !== "open" || point.lifecycle === "closed") {
      throw new CollabError("ACTION_FORBIDDEN", "room or Review Point is not open for Review findings");
    }
    if (this.findings.filter((item) => item.roomId === input.roomId).length >= MAX_FINDINGS_PER_ROOM) {
      throw new CollabError("RESOURCE_LIMIT", "Review finding limit reached for this room");
    }
    this.add(finding);
    this.emit();
    return structuredClone(finding);
  }

  listFindings(input: { roomId: string; principalId: string; reviewPointId: string; after?: string; limit?: number }): ReviewFindingPage {
    this.options.reviewPoints.get(input);
    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw invalidInput("limit must be between 1 and 100");
    const ordered = [...(this.byPoint.get(input.reviewPointId) ?? [])].reverse();
    const start = input.after === undefined ? 0 : ordered.findIndex((finding) => finding.findingId === input.after) + 1;
    if (input.after !== undefined && start === 0) throw invalidInput("Review finding cursor is invalid");
    const page = ordered.slice(start, start + limit);
    const nextCursor = start + page.length < ordered.length ? page.at(-1)?.findingId : undefined;
    return { findings: structuredClone(page), ...(nextCursor ? { nextCursor } : {}) };
  }

  setReviewers(input: { roomId: string; principalId: string; reviewPointId: string; reviewerIds: string[] }): ReviewPoint {
    return this.options.reviewPoints.setWorkflow(input);
  }

  setLifecycle(input: { roomId: string; principalId: string; reviewPointId: string; lifecycle: ReviewLifecycle }): ReviewPoint {
    return this.options.reviewPoints.setWorkflow({ ...input, lifecycle: input.lifecycle });
  }

  setFindingState(input: {
    roomId: string;
    principalId: string;
    reviewPointId: string;
    findingId: string;
    state: "accepted" | "dismissed";
  }): ReviewFinding {
    const host = this.requireHost(input.roomId, input.principalId);
    const point = this.options.reviewPoints.get(input);
    const finding = this.byId.get(input.findingId);
    if (!finding || finding.roomId !== input.roomId || finding.reviewPointId !== input.reviewPointId) {
      throw new CollabError("SNAPSHOT_NOT_FOUND", "Review finding does not exist");
    }
    if (finding.state === input.state) return structuredClone(finding);
    this.requireOpenRoom(input.roomId);
    this.requireOpenReviewPoint(point);
    if (finding.state !== "open") throw new CollabError("REQUEST_CONFLICT", "Review finding decision is terminal");
    finding.state = input.state;
    finding.decidedBy = host.memberId;
    finding.decidedAt = this.now();
    this.emit();
    return structuredClone(finding);
  }

  snapshot(): ReviewServiceSnapshot {
    return { version: 1, findings: structuredClone(this.findings) };
  }

  private requireHost(roomId: string, principalId: string) {
    const member = this.options.rooms.authorize(roomId, principalId, "read");
    if (member.role !== "host") throw new CollabError("ACTION_FORBIDDEN", "only the Host can update Review workflow");
    return member;
  }

  private requireOpenRoom(roomId: string): void {
    if (this.options.rooms.getRoom(roomId).state !== "open") {
      throw new CollabError("ACTION_FORBIDDEN", "room is not open for Review workflow changes");
    }
  }

  private requireOpenReviewPoint(point: ReviewPoint): void {
    if (point.lifecycle === "closed") {
      throw new CollabError("ACTION_FORBIDDEN", "Review Point is closed for workflow changes");
    }
  }

  private add(finding: ReviewFinding): void {
    this.findings.push(finding);
    this.byId.set(finding.findingId, finding);
    const findings = this.byPoint.get(finding.reviewPointId) ?? [];
    findings.push(finding);
    this.byPoint.set(finding.reviewPointId, findings);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
