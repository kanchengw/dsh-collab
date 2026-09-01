import { createHash } from "node:crypto";
import type {
  AcceptedReviewPublication,
  ReviewFinding,
  ReviewFindingCreateInput,
  ReviewFindingLocation,
  ReviewFindingPage,
  ReviewLifecycle,
  ReviewPoint,
  ReviewPublication,
  ReviewPublicationPage,
} from "./collaboration-types.js";
import { CollabError, invalidInput } from "./errors.js";
import { ReviewPointService } from "./review-points.js";
import { RoomStore } from "./room.js";

const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_FINDINGS_PER_ROOM = 1_000;
const MAX_PUBLICATION_FINDINGS = 100;
const MAX_PUBLICATION_CONTENT_LENGTH = 8_000;
export const MAINLINE_REQUEST_PREFIX = "internal:mainline:";

export interface ReviewServiceSnapshot {
  version: 1;
  findings: ReviewFinding[];
  publications?: ReviewPublication[];
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

function publicationId(roomId: string, principalId: string, taskId: string): string {
  return createHash("sha256").update(`${roomId}\0${principalId}\0review-publication\0${taskId}`).digest("hex");
}

function integrationRequestId(roomId: string, id: string): string {
  return MAINLINE_REQUEST_PREFIX + createHash("sha256").update(`${roomId}\0${id}\0mainline-integration`).digest("hex");
}

function isIntegrationRequestId(roomId: string, publicationId: string, value: unknown): value is string {
  return value === integrationRequestId(roomId, publicationId);
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

function sameLocation(left: ReviewFindingLocation, right: ReviewFindingLocation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateRestoredPublication(
  value: ReviewPublication,
  options: ReviewServiceOptions,
  points: ReadonlyMap<string, ReviewPoint>,
  findings: ReadonlyMap<string, ReviewFinding>,
): ReviewPublication {
  const point = points.get(value?.reviewPointId);
  const accepted = value?.state === "accepted";
  if (!value || !/^[a-f0-9]{64}$/.test(value.publicationId) || typeof value.roomId !== "string" || !point || point.roomId !== value.roomId
    || typeof value.taskId !== "string" || value.taskId.trim() === "" || value.taskId.length > 128
    || value.workspaceSnapshotId !== point.workspaceSnapshotId || typeof value.publishedBy !== "string"
    || typeof value.summary !== "string" || value.summary.trim() === "" || value.summary.length > MAX_PUBLICATION_CONTENT_LENGTH
    || !Array.isArray(value.findingIds) || value.findingIds.length < 1 || value.findingIds.length > MAX_PUBLICATION_FINDINGS
    || new Set(value.findingIds).size !== value.findingIds.length
    || value.findingIds.some((id) => {
      const finding = findings.get(id);
      return !finding || finding.roomId !== value.roomId || finding.reviewPointId !== value.reviewPointId || finding.authorId !== value.publishedBy;
    })
    || !["published", "accepted"].includes(value.state) || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
    || (accepted
      ? typeof value.acceptedBy !== "string" || !Number.isSafeInteger(value.acceptedAt) || typeof value.integrationRequestId !== "string"
      : value.acceptedBy !== undefined || value.acceptedAt !== undefined || value.integrationRequestId !== undefined)) {
    throw new CollabError("SNAPSHOT_INVALID", "Review publication snapshot is invalid");
  }
  const publisher = options.rooms.listMembers(value.roomId).find((member) => member.memberId === value.publishedBy);
  if (!publisher) throw new CollabError("SNAPSHOT_INVALID", "Review publication snapshot is invalid");
  if (value.publicationId !== publicationId(value.roomId, publisher.principalId, value.taskId)
    || value.findingIds.some((id, index) => id !== findingId(value.roomId, publisher.principalId, `${value.publicationId}:${String(index)}`))
    || (accepted && !isIntegrationRequestId(value.roomId, value.publicationId, value.integrationRequestId))) {
    throw new CollabError("SNAPSHOT_INVALID", "Review publication snapshot is invalid");
  }
  if (value.summary.length + value.findingIds.reduce((total, id) => total + findings.get(id)!.body.length, 0) > MAX_PUBLICATION_CONTENT_LENGTH) {
    throw new CollabError("SNAPSHOT_INVALID", "Review publication snapshot is invalid");
  }
  if (accepted) {
    const host = options.rooms.listMembers(value.roomId).find((member) => member.memberId === value.acceptedBy && member.role === "host");
    if (!host || value.findingIds.some((id) => {
      const finding = findings.get(id)!;
      return finding.state !== "accepted" || finding.decidedBy !== value.acceptedBy || finding.decidedAt !== value.acceptedAt;
    })) {
      throw new CollabError("SNAPSHOT_INVALID", "Review publication snapshot is invalid");
    }
  } else if (value.findingIds.some((id) => findings.get(id)?.state !== "open")) {
    throw new CollabError("SNAPSHOT_INVALID", "Review publication snapshot is invalid");
  }
  return structuredClone(value);
}

export class ReviewService {
  private readonly findings: ReviewFinding[] = [];
  private readonly byId = new Map<string, ReviewFinding>();
  private readonly byPoint = new Map<string, ReviewFinding[]>();
  private readonly publications: ReviewPublication[] = [];
  private readonly publicationsById = new Map<string, ReviewPublication>();
  private readonly publicationsByPoint = new Map<string, ReviewPublication[]>();
  private readonly publicationByFindingId = new Map<string, ReviewPublication>();
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
    if (snapshot.publications !== undefined && !Array.isArray(snapshot.publications)) {
      throw new CollabError("SNAPSHOT_INVALID", "Review publication snapshot is invalid");
    }
    for (const raw of snapshot.publications ?? []) {
      const publication = validateRestoredPublication(raw, options, points, service.byId);
      if (service.publicationsById.has(publication.publicationId)) throw new CollabError("SNAPSHOT_INVALID", "Review snapshot contains duplicate publications");
      service.addPublication(publication);
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
        && sameLocation(existing.location, finding.location)
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

  publishSideTaskResult(input: {
    roomId: string;
    principalId: string;
    reviewPointId: string;
    taskId: string;
    workspaceSnapshotId: string;
    summary: string;
    findings: ReviewFindingCreateInput[];
  }): ReviewPublication {
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    const point = this.options.reviewPoints.get(input);
    const taskId = text(input.taskId, "taskId", 128);
    const id = publicationId(input.roomId, input.principalId, taskId);
    const summary = text(input.summary, "summary", MAX_PUBLICATION_CONTENT_LENGTH);
    if (input.workspaceSnapshotId !== point.workspaceSnapshotId) throw invalidInput("publication snapshot does not match the Review Point");
    if (!Array.isArray(input.findings) || input.findings.length < 1 || input.findings.length > MAX_PUBLICATION_FINDINGS) {
      throw invalidInput("publication findings must contain between 1 and 100 items");
    }
    const candidates = input.findings.map((finding, index): ReviewFinding => ({
      findingId: findingId(input.roomId, input.principalId, `${id}:${String(index)}`),
      roomId: input.roomId,
      reviewPointId: point.reviewPointId,
      authorId: member.memberId,
      severity: severity(finding.severity),
      location: location(finding.location, point),
      body: text(finding.body, "body", 4_000),
      state: "open",
      createdAt: this.now(),
    }));
    if (summary.length + candidates.reduce((total, finding) => total + finding.body.length, 0) > MAX_PUBLICATION_CONTENT_LENGTH) {
      throw invalidInput("publication summary and findings are too long");
    }
    const next: ReviewPublication = {
      publicationId: id,
      roomId: input.roomId,
      reviewPointId: point.reviewPointId,
      taskId,
      workspaceSnapshotId: point.workspaceSnapshotId,
      publishedBy: member.memberId,
      summary,
      findingIds: candidates.map((finding) => finding.findingId),
      state: "published",
      createdAt: candidates[0]!.createdAt,
    };
    const existing = this.publicationsById.get(id);
    if (existing) {
      const existingFindings = existing.findingIds.map((findingId) => this.byId.get(findingId)!);
      const samePayload = existing.roomId === next.roomId && existing.reviewPointId === next.reviewPointId
        && existing.taskId === next.taskId && existing.workspaceSnapshotId === next.workspaceSnapshotId
        && existing.publishedBy === next.publishedBy && existing.summary === next.summary
        && existingFindings.length === candidates.length
        && existingFindings.every((finding, index) => finding.severity === candidates[index]!.severity
          && sameLocation(finding.location, candidates[index]!.location) && finding.body === candidates[index]!.body);
      if (!samePayload) throw new CollabError("REQUEST_CONFLICT", "SideTask publication conflicts with an existing request");
      return structuredClone(existing);
    }
    this.requireOpenRoom(input.roomId);
    this.requireOpenReviewPoint(point);
    if (this.findings.filter((finding) => finding.roomId === input.roomId).length + candidates.length > MAX_FINDINGS_PER_ROOM) {
      throw new CollabError("RESOURCE_LIMIT", "Review finding limit reached for this room");
    }
    for (const finding of candidates) this.add(finding);
    this.addPublication(next);
    this.emit();
    return structuredClone(next);
  }

  listPublications(input: { roomId: string; principalId: string; reviewPointId: string }): ReviewPublicationPage {
    this.options.reviewPoints.get(input);
    return { publications: structuredClone([...(this.publicationsByPoint.get(input.reviewPointId) ?? [])].reverse()) };
  }

  acceptSideTaskPublication(input: {
    roomId: string;
    principalId: string;
    reviewPointId: string;
    publicationId: string;
  }, commitIntegrationRequest: (accepted: AcceptedReviewPublication) => void): AcceptedReviewPublication {
    const host = this.requireHost(input.roomId, input.principalId);
    const point = this.options.reviewPoints.get(input);
    const publication = this.publicationsById.get(input.publicationId);
    if (!publication || publication.roomId !== input.roomId || publication.reviewPointId !== input.reviewPointId) {
      throw new CollabError("SNAPSHOT_NOT_FOUND", "Review publication does not exist");
    }
    const findings = publication.findingIds.map((id) => this.byId.get(id)!);
    if (publication.state === "accepted") {
      const accepted = { publication: structuredClone(publication), findings: structuredClone(findings) };
      commitIntegrationRequest(structuredClone(accepted));
      return accepted;
    }
    this.requireOpenRoom(input.roomId);
    this.requireOpenReviewPoint(point);
    if (findings.some((finding) => finding.state !== "open")) {
      throw new CollabError("REQUEST_CONFLICT", "Review publication findings already have a decision");
    }
    const decidedAt = this.now();
    const prepared: AcceptedReviewPublication = {
      publication: {
        ...structuredClone(publication),
        state: "accepted",
        acceptedBy: host.memberId,
        acceptedAt: decidedAt,
        integrationRequestId: integrationRequestId(input.roomId, publication.publicationId),
      },
      findings: findings.map((finding) => ({
        ...structuredClone(finding),
        state: "accepted",
        decidedBy: host.memberId,
        decidedAt,
      })),
    };
    commitIntegrationRequest(structuredClone(prepared));
    for (const finding of findings) {
      finding.state = "accepted";
      finding.decidedBy = host.memberId;
      finding.decidedAt = decidedAt;
    }
    publication.state = "accepted";
    publication.acceptedBy = host.memberId;
    publication.acceptedAt = decidedAt;
    publication.integrationRequestId = prepared.publication.integrationRequestId;
    this.emit();
    return { publication: structuredClone(publication), findings: structuredClone(findings) };
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
    if (this.publicationByFindingId.has(finding.findingId)) {
      throw new CollabError("REQUEST_CONFLICT", "Published SideTask findings must be decided as one publication");
    }
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
    return { version: 1, findings: structuredClone(this.findings), publications: structuredClone(this.publications) };
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

  private addPublication(publication: ReviewPublication): void {
    this.publications.push(publication);
    this.publicationsById.set(publication.publicationId, publication);
    const publications = this.publicationsByPoint.get(publication.reviewPointId) ?? [];
    publications.push(publication);
    this.publicationsByPoint.set(publication.reviewPointId, publications);
    for (const findingId of publication.findingIds) this.publicationByFindingId.set(findingId, publication);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
