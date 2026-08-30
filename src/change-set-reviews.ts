import { createHash } from "node:crypto";
import type { StagedChangeSet } from "./change-set-staging.js";
import type { CollaborationEvent, ReviewFinding, ReviewFindingLocation } from "./collaboration-types.js";
import { CollabError, invalidInput } from "./errors.js";
import type { RoomStore } from "./room.js";
import type { RoomMember } from "./types.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const MAX_FINDINGS_PER_ROOM = 1_000;

export interface ChangeSetReviewAssignment {
  assignmentId: string;
  roomId: string;
  changeSetId: string;
  assignedBy: string;
  reviewerId: string;
  previousReviewerId?: string;
  createdAt: number;
}

export interface ChangeSetReviewFinding {
  findingId: string;
  roomId: string;
  changeSetId: string;
  authorId: string;
  severity: ReviewFinding["severity"];
  location: ReviewFindingLocation;
  body: string;
  createdAt: number;
}

export type ChangeSetReviewStatus = "submitted" | "in-review" | "changes-requested" | "approved" | "superseded";

export interface ChangeSetReviewDecision {
  decisionId: string;
  roomId: string;
  changeSetId: string;
  reviewerId: string;
  outcome: "approved" | "changes-requested";
  note?: string;
  createdAt: number;
}

export interface ChangeSetRevisionLink {
  revisionLinkId: string;
  roomId: string;
  changeSetId: string;
  supersedesChangeSetId: string;
  linkedBy: string;
  createdAt: number;
}

export interface ChangeSetReview {
  version: 1;
  roomId: string;
  changeSetId: string;
  authorId: string;
  status: ChangeSetReviewStatus;
  requiredReviewerId?: string;
  decision?: ChangeSetReviewDecision;
  supersedesChangeSetId?: string;
  supersededByChangeSetId?: string;
  assignmentCount: number;
  findingCount: number;
}

export interface ChangeSetReviewFindingPage {
  findings: ChangeSetReviewFinding[];
  nextCursor?: string;
}

export interface ChangeSetReviewPage {
  reviews: ChangeSetReview[];
  nextCursor?: string;
}

export interface ChangeSetReviewServiceSnapshot {
  version: 1;
  reviews: Array<{
    version: 1;
    roomId: string;
    changeSetId: string;
    authorId: string;
    assignments: ChangeSetReviewAssignment[];
    findings: ChangeSetReviewFinding[];
    decisions?: ChangeSetReviewDecision[];
    revision?: ChangeSetRevisionLink;
  }>;
}

export interface StagedChangeSetReader {
  get(roomId: string, changeSetId: string): Promise<StagedChangeSet | undefined>;
}

interface ChangeSetReviewServiceOptions {
  rooms: RoomStore;
  changeSets: StagedChangeSetReader;
  now?: () => number;
}

type SnapshotReviewRecord = ChangeSetReviewServiceSnapshot["reviews"][number];
type ReviewRecord = Omit<SnapshotReviewRecord, "decisions"> & { decisions: ChangeSetReviewDecision[] };

function hashId(kind: "assignment" | "finding" | "decision" | "revision", roomId: string, principalId: string, clientRequestId: string): string {
  return createHash("sha256").update(`${roomId}\0${principalId}\0changeset-review-${kind}\0${clientRequestId}`).digest("hex");
}

function requiredText(value: string, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.trim().length > maxLength) {
    throw invalidInput(`${field} must contain between 1 and ${String(maxLength)} characters`, { field });
  }
  return value.trim();
}

function severity(value: ReviewFinding["severity"]): ReviewFinding["severity"] {
  if (!["critical", "high", "medium", "low", "note"].includes(value)) throw invalidInput("finding severity is invalid");
  return value;
}

function location(value: ReviewFindingLocation, changeSet: StagedChangeSet): ReviewFindingLocation {
  if (!value || typeof value !== "object" || !["general", "file", "line"].includes(value.kind)) {
    throw invalidInput("finding location is invalid");
  }
  if (value.kind === "general") return { kind: "general" };
  if (typeof value.path !== "string" || !changeSet.draft.files.some((file) => file.path === value.path)) {
    throw invalidInput("finding path is not part of the ChangeSet", { path: value.path });
  }
  if (value.kind === "file") return { kind: "file", path: value.path };
  if (!Number.isSafeInteger(value.line) || value.line < 1) throw invalidInput("finding line must be a positive integer");
  return { kind: "line", path: value.path, line: value.line };
}

function sameLocation(left: ReviewFindingLocation, right: ReviewFindingLocation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function key(roomId: string, changeSetId: string): string {
  return `${roomId}\0${changeSetId}`;
}

function memberById(rooms: RoomStore, roomId: string, memberId: string): RoomMember {
  const member = rooms.listMembers(roomId).find((candidate) => candidate.memberId === memberId);
  if (!member) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review member does not exist", { roomId, memberId });
  return member;
}

function validateRestoredLocation(value: ReviewFindingLocation): void {
  if (!value || typeof value !== "object" || !["general", "file", "line"].includes(value.kind)) {
    throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review Finding location is invalid");
  }
  if (value.kind !== "general" && (typeof value.path !== "string" || value.path.trim() === "")) {
    throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review Finding path is invalid");
  }
  if (value.kind === "line" && (!Number.isSafeInteger(value.line) || value.line < 1)) {
    throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review Finding line is invalid");
  }
}

function validateRestoredRecord(value: SnapshotReviewRecord, rooms: RoomStore): ReviewRecord {
  if (!value || value.version !== 1 || typeof value.roomId !== "string" || !HASH_PATTERN.test(value.changeSetId)
    || typeof value.authorId !== "string" || !Array.isArray(value.assignments) || !Array.isArray(value.findings)) {
    throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review snapshot is invalid");
  }
  rooms.getRoom(value.roomId);
  memberById(rooms, value.roomId, value.authorId);
  let reviewerId: string | undefined;
  const assignmentIds = new Set<string>();
  for (const assignment of value.assignments) {
    if (!assignment || !HASH_PATTERN.test(assignment.assignmentId) || assignment.roomId !== value.roomId
      || assignment.changeSetId !== value.changeSetId || typeof assignment.assignedBy !== "string"
      || typeof assignment.reviewerId !== "string" || assignment.previousReviewerId !== reviewerId
      || !Number.isSafeInteger(assignment.createdAt) || assignment.createdAt < 0 || assignmentIds.has(assignment.assignmentId)) {
      throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review assignment snapshot is invalid");
    }
    memberById(rooms, value.roomId, assignment.assignedBy);
    memberById(rooms, value.roomId, assignment.reviewerId);
    assignmentIds.add(assignment.assignmentId);
    reviewerId = assignment.reviewerId;
  }
  const findingIds = new Set<string>();
  for (const finding of value.findings) {
    if (!finding || !HASH_PATTERN.test(finding.findingId) || finding.roomId !== value.roomId
      || finding.changeSetId !== value.changeSetId || typeof finding.authorId !== "string"
      || !Number.isSafeInteger(finding.createdAt) || finding.createdAt < 0 || findingIds.has(finding.findingId)) {
      throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review Finding snapshot is invalid");
    }
    memberById(rooms, value.roomId, finding.authorId);
    severity(finding.severity);
    requiredText(finding.body, "body", 4_000);
    validateRestoredLocation(finding.location);
    findingIds.add(finding.findingId);
  }
  const decisions = value.decisions ?? [];
  if (!Array.isArray(decisions) || decisions.length > 1) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review decision snapshot is invalid");
  for (const decision of decisions) {
    if (!decision || !HASH_PATTERN.test(decision.decisionId) || decision.roomId !== value.roomId
      || decision.changeSetId !== value.changeSetId || decision.reviewerId !== reviewerId
      || (decision.outcome !== "approved" && decision.outcome !== "changes-requested")
      || (decision.note !== undefined && (typeof decision.note !== "string" || decision.note.trim() === "" || decision.note.length > 4_000))
      || !Number.isSafeInteger(decision.createdAt) || decision.createdAt < 0) {
      throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review decision snapshot is invalid");
    }
    memberById(rooms, value.roomId, decision.reviewerId);
  }
  const revision = value.revision;
  if (revision && (!HASH_PATTERN.test(revision.revisionLinkId) || revision.roomId !== value.roomId
    || revision.changeSetId !== value.changeSetId || !HASH_PATTERN.test(revision.supersedesChangeSetId)
    || revision.supersedesChangeSetId === value.changeSetId || revision.linkedBy !== value.authorId
    || !Number.isSafeInteger(revision.createdAt) || revision.createdAt < 0)) {
    throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review revision snapshot is invalid");
  }
  if (revision) memberById(rooms, value.roomId, revision.linkedBy);
  return structuredClone({ ...value, decisions });
}

export class ChangeSetReviewService {
  private readonly records = new Map<string, ReviewRecord>();
  private readonly assignmentsById = new Map<string, ChangeSetReviewAssignment>();
  private readonly findingsById = new Map<string, ChangeSetReviewFinding>();
  private readonly decisionsById = new Map<string, ChangeSetReviewDecision>();
  private readonly revisionLinksById = new Map<string, ChangeSetRevisionLink>();
  private readonly successorByChangeSetId = new Map<string, string>();
  private readonly listeners = new Set<(event: CollaborationEvent) => void>();
  private readonly now: () => number;

  constructor(private readonly options: ChangeSetReviewServiceOptions) {
    this.now = options.now ?? (() => Date.now());
  }

  static fromSnapshot(options: ChangeSetReviewServiceOptions, snapshot: ChangeSetReviewServiceSnapshot): ChangeSetReviewService {
    if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.reviews)) {
      throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review snapshot is invalid");
    }
    const service = new ChangeSetReviewService(options);
    for (const raw of snapshot.reviews) {
      let record: ReviewRecord;
      try {
        record = validateRestoredRecord(raw, options.rooms);
      } catch (error) {
        if (error instanceof CollabError && error.code === "SNAPSHOT_INVALID") throw error;
        throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review snapshot is invalid");
      }
      const recordKey = key(record.roomId, record.changeSetId);
      if (service.records.has(recordKey)) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review snapshot contains duplicate reviews");
      for (const assignment of record.assignments) {
        if (service.assignmentsById.has(assignment.assignmentId)) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review snapshot contains duplicate assignments");
        service.assignmentsById.set(assignment.assignmentId, assignment);
      }
      for (const finding of record.findings) {
        if (service.findingsById.has(finding.findingId)) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review snapshot contains duplicate Findings");
        service.findingsById.set(finding.findingId, finding);
      }
      for (const decision of record.decisions) {
        if (service.decisionsById.has(decision.decisionId)) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review snapshot contains duplicate decisions");
        service.decisionsById.set(decision.decisionId, decision);
      }
      if (record.revision) {
        if (service.revisionLinksById.has(record.revision.revisionLinkId)) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review snapshot contains duplicate revision links");
        service.revisionLinksById.set(record.revision.revisionLinkId, record.revision);
      }
      service.records.set(recordKey, record);
    }
    for (const record of service.records.values()) {
      if (!record.revision) continue;
      const previous = service.records.get(key(record.roomId, record.revision.supersedesChangeSetId));
      if (!previous || previous.authorId !== record.authorId || previous.decisions.at(-1)?.outcome !== "changes-requested"
        || service.successorByChangeSetId.has(record.revision.supersedesChangeSetId)) {
        throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review revision chain is invalid");
      }
      service.successorByChangeSetId.set(record.revision.supersedesChangeSetId, record.changeSetId);
    }
    const visited = new Set<string>();
    for (const start of service.successorByChangeSetId.keys()) {
      if (visited.has(start)) continue;
      const path = new Set<string>();
      let current: string | undefined = start;
      while (current !== undefined && !visited.has(current)) {
        if (path.has(current)) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review revision chain contains a cycle");
        path.add(current);
        current = service.successorByChangeSetId.get(current);
      }
      for (const changeSetId of path) visited.add(changeSetId);
    }
    return service;
  }

  subscribe(listener: (event: CollaborationEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  async getReview(input: { roomId: string; principalId: string; changeSetId: string }): Promise<ChangeSetReview> {
    this.options.rooms.authorize(input.roomId, input.principalId, "read");
    const changeSet = await this.requireChangeSet(input.roomId, input.changeSetId);
    const record = this.records.get(key(input.roomId, input.changeSetId));
    if (record) this.assertRecord(record, changeSet);
    return this.view(changeSet, record);
  }

  async assignReviewer(input: {
    roomId: string;
    principalId: string;
    changeSetId: string;
    reviewerId: string;
    clientRequestId: string;
  }): Promise<{ review: ChangeSetReview; assignment: ChangeSetReviewAssignment }> {
    const actor = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    const changeSet = await this.requireChangeSet(input.roomId, input.changeSetId);
    if (actor.role !== "host" && actor.memberId !== changeSet.draft.authorId) {
      throw new CollabError("ACTION_FORBIDDEN", "only the ChangeSet author or Host can assign its reviewer");
    }
    const reviewerId = requiredText(input.reviewerId, "reviewerId", 128);
    const assignmentId = hashId("assignment", input.roomId, input.principalId, requiredText(input.clientRequestId, "clientRequestId", 128));
    const existing = this.assignmentsById.get(assignmentId);
    if (existing) {
      if (existing.roomId !== input.roomId || existing.changeSetId !== input.changeSetId
        || existing.assignedBy !== actor.memberId || existing.reviewerId !== reviewerId) {
        throw new CollabError("REQUEST_CONFLICT", "ChangeSet reviewer request conflicts with an existing request");
      }
      const record = this.records.get(key(input.roomId, input.changeSetId));
      if (!record) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review assignment has no review record");
      return { review: this.view(changeSet, record), assignment: structuredClone(existing) };
    }
    const record = this.records.get(key(input.roomId, input.changeSetId));
    if (record && record.decisions.length > 0) throw new CollabError("REQUEST_STATE", "ChangeSet already has a review decision");
    this.requireOpenRoom(input.roomId);
    const reviewer = this.options.rooms.listMembers(input.roomId).find((candidate) => candidate.memberId === reviewerId && candidate.status === "active");
    if (!reviewer) throw new CollabError("ACTION_FORBIDDEN", "required reviewer must be an active room member", { reviewerId });
    const previousReviewerId = record?.assignments.at(-1)?.reviewerId;
    const createdAt = this.timestamp();
    const assignment: ChangeSetReviewAssignment = {
      assignmentId,
      roomId: input.roomId,
      changeSetId: input.changeSetId,
      assignedBy: actor.memberId,
      reviewerId: reviewer.memberId,
      ...(previousReviewerId ? { previousReviewerId } : {}),
      createdAt,
    };
    const target = record ?? this.createRecord(changeSet);
    target.assignments.push(assignment);
    this.assignmentsById.set(assignment.assignmentId, assignment);
    const event = this.assignmentEvent(assignment);
    this.emit(event);
    return { review: this.view(changeSet, target), assignment: structuredClone(assignment) };
  }

  async listReviews(input: {
    roomId: string;
    principalId: string;
    after?: string;
    limit?: number;
  }): Promise<ChangeSetReviewPage> {
    this.options.rooms.authorize(input.roomId, input.principalId, "read");
    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw invalidInput("limit must be between 1 and 100");
    const ordered = [...this.records.values()]
      .filter((record) => record.roomId === input.roomId)
      .sort((left, right) => this.lastActivity(right) - this.lastActivity(left) || left.changeSetId.localeCompare(right.changeSetId));
    const start = input.after === undefined ? 0 : ordered.findIndex((record) => record.changeSetId === input.after) + 1;
    if (input.after !== undefined && start === 0) throw invalidInput("ChangeSet Review cursor is invalid");
    const page = ordered.slice(start, start + limit);
    const reviews = await Promise.all(page.map(async (record) => {
      const changeSet = await this.requireChangeSet(record.roomId, record.changeSetId);
      this.assertRecord(record, changeSet);
      return this.view(changeSet, record);
    }));
    const nextCursor = start + page.length < ordered.length ? page.at(-1)?.changeSetId : undefined;
    return { reviews, ...(nextCursor ? { nextCursor } : {}) };
  }

  async createFinding(input: {
    roomId: string;
    principalId: string;
    changeSetId: string;
    clientRequestId: string;
    severity: ReviewFinding["severity"];
    location: ReviewFindingLocation;
    body: string;
  }): Promise<{ finding: ChangeSetReviewFinding }> {
    const actor = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    const changeSet = await this.requireChangeSet(input.roomId, input.changeSetId);
    const findingId = hashId("finding", input.roomId, input.principalId, requiredText(input.clientRequestId, "clientRequestId", 128));
    const existing = this.findingsById.get(findingId);
    const candidate = {
      findingId,
      roomId: input.roomId,
      changeSetId: input.changeSetId,
      authorId: actor.memberId,
      severity: severity(input.severity),
      location: location(input.location, changeSet),
      body: requiredText(input.body, "body", 4_000),
      createdAt: existing?.createdAt ?? this.timestamp(),
    } satisfies ChangeSetReviewFinding;
    if (existing) {
      if (existing.roomId !== candidate.roomId || existing.changeSetId !== candidate.changeSetId
        || existing.authorId !== candidate.authorId || existing.severity !== candidate.severity
        || !sameLocation(existing.location, candidate.location) || existing.body !== candidate.body) {
        throw new CollabError("REQUEST_CONFLICT", "ChangeSet Finding request conflicts with an existing request");
      }
      return { finding: structuredClone(existing) };
    }
    this.requireOpenRoom(input.roomId);
    const roomFindingCount = [...this.records.values()]
      .filter((record) => record.roomId === input.roomId)
      .reduce((total, record) => total + record.findings.length, 0);
    if (roomFindingCount >= MAX_FINDINGS_PER_ROOM) throw new CollabError("RESOURCE_LIMIT", "ChangeSet Finding limit reached for this room");
    const record = this.records.get(key(input.roomId, input.changeSetId)) ?? this.createRecord(changeSet);
    record.findings.push(candidate);
    this.findingsById.set(candidate.findingId, candidate);
    const event = this.findingEvent(candidate);
    this.emit(event);
    return { finding: structuredClone(candidate) };
  }

  async decide(input: {
    roomId: string;
    principalId: string;
    changeSetId: string;
    clientRequestId: string;
    outcome: ChangeSetReviewDecision["outcome"];
    note?: string;
  }): Promise<{ review: ChangeSetReview; decision: ChangeSetReviewDecision }> {
    const actor = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    const changeSet = await this.requireChangeSet(input.roomId, input.changeSetId);
    const record = this.records.get(key(input.roomId, input.changeSetId));
    if (!record) throw new CollabError("REQUEST_STATE", "ChangeSet requires a reviewer before a decision");
    this.assertRecord(record, changeSet);
    const requiredReviewerId = record.assignments.at(-1)?.reviewerId;
    if (!requiredReviewerId || actor.memberId !== requiredReviewerId) {
      throw new CollabError("ACTION_FORBIDDEN", "only the required reviewer can decide this ChangeSet");
    }
    if (input.outcome !== "approved" && input.outcome !== "changes-requested") throw invalidInput("review outcome is invalid");
    const note = input.note === undefined ? undefined : requiredText(input.note, "note", 4_000);
    const decisionId = hashId("decision", input.roomId, input.principalId, requiredText(input.clientRequestId, "clientRequestId", 128));
    const existing = this.decisionsById.get(decisionId);
    if (existing) {
      if (existing.roomId !== input.roomId || existing.changeSetId !== input.changeSetId || existing.reviewerId !== actor.memberId
        || existing.outcome !== input.outcome || existing.note !== note) {
        throw new CollabError("REQUEST_CONFLICT", "ChangeSet decision request conflicts with an existing request");
      }
      return { review: this.view(changeSet, record), decision: structuredClone(existing) };
    }
    if (record.decisions.length > 0) throw new CollabError("REQUEST_STATE", "ChangeSet already has a review decision");
    this.requireOpenRoom(input.roomId);
    const decision: ChangeSetReviewDecision = {
      decisionId,
      roomId: input.roomId,
      changeSetId: input.changeSetId,
      reviewerId: actor.memberId,
      outcome: input.outcome,
      ...(note ? { note } : {}),
      createdAt: this.timestamp(),
    };
    record.decisions.push(decision);
    this.decisionsById.set(decisionId, decision);
    this.emit({ type: "changeset.review-decided", roomId: input.roomId, decision: structuredClone(decision) });
    return { review: this.view(changeSet, record), decision: structuredClone(decision) };
  }

  async linkRevision(input: {
    roomId: string;
    principalId: string;
    changeSetId: string;
    supersedesChangeSetId: string;
    clientRequestId: string;
  }): Promise<{ review: ChangeSetReview; revision: ChangeSetRevisionLink }> {
    const actor = this.options.rooms.authorize(input.roomId, input.principalId, "read");
    const [changeSet, previousChangeSet] = await Promise.all([
      this.requireChangeSet(input.roomId, input.changeSetId),
      this.requireChangeSet(input.roomId, input.supersedesChangeSetId),
    ]);
    if (actor.memberId !== changeSet.draft.authorId) throw new CollabError("ACTION_FORBIDDEN", "only the revision author can link its predecessor");
    if (changeSet.draft.authorId !== previousChangeSet.draft.authorId) throw new CollabError("ACTION_FORBIDDEN", "ChangeSet revision must keep the same author");
    const revisionLinkId = hashId("revision", input.roomId, input.principalId, requiredText(input.clientRequestId, "clientRequestId", 128));
    const existing = this.revisionLinksById.get(revisionLinkId);
    if (existing) {
      if (existing.roomId !== input.roomId || existing.changeSetId !== input.changeSetId
        || existing.supersedesChangeSetId !== input.supersedesChangeSetId || existing.linkedBy !== actor.memberId) {
        throw new CollabError("REQUEST_CONFLICT", "ChangeSet revision request conflicts with an existing request");
      }
      const record = this.records.get(key(input.roomId, input.changeSetId));
      if (!record) throw new CollabError("SNAPSHOT_INVALID", "ChangeSet revision has no review record");
      return { review: this.view(changeSet, record), revision: structuredClone(existing) };
    }
    const previous = this.records.get(key(input.roomId, input.supersedesChangeSetId));
    if (!previous || previous.decisions.at(-1)?.outcome !== "changes-requested") {
      throw new CollabError("REQUEST_STATE", "the previous ChangeSet must have changes requested");
    }
    if (this.successorByChangeSetId.has(input.supersedesChangeSetId)) throw new CollabError("REQUEST_STATE", "the previous ChangeSet already has a revision");
    const record = this.records.get(key(input.roomId, input.changeSetId)) ?? this.createRecord(changeSet);
    if (record.revision || record.decisions.length > 0) throw new CollabError("REQUEST_STATE", "the new ChangeSet already has review history");
    this.requireOpenRoom(input.roomId);
    const revision: ChangeSetRevisionLink = {
      revisionLinkId,
      roomId: input.roomId,
      changeSetId: input.changeSetId,
      supersedesChangeSetId: input.supersedesChangeSetId,
      linkedBy: actor.memberId,
      createdAt: this.timestamp(),
    };
    record.revision = revision;
    this.revisionLinksById.set(revisionLinkId, revision);
    this.successorByChangeSetId.set(input.supersedesChangeSetId, input.changeSetId);
    this.emit({ type: "changeset.revision-linked", roomId: input.roomId, revision: structuredClone(revision) });
    return { review: this.view(changeSet, record), revision: structuredClone(revision) };
  }

  async listFindings(input: {
    roomId: string;
    principalId: string;
    changeSetId: string;
    after?: string;
    limit?: number;
  }): Promise<ChangeSetReviewFindingPage> {
    await this.getReview(input);
    const limit = input.limit ?? DEFAULT_PAGE_SIZE;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) throw invalidInput("limit must be between 1 and 100");
    const findings = [...(this.records.get(key(input.roomId, input.changeSetId))?.findings ?? [])].reverse();
    const start = input.after === undefined ? 0 : findings.findIndex((finding) => finding.findingId === input.after) + 1;
    if (input.after !== undefined && start === 0) throw invalidInput("ChangeSet Finding cursor is invalid");
    const page = findings.slice(start, start + limit);
    const nextCursor = start + page.length < findings.length ? page.at(-1)?.findingId : undefined;
    return { findings: structuredClone(page), ...(nextCursor ? { nextCursor } : {}) };
  }

  snapshot(): ChangeSetReviewServiceSnapshot {
    return { version: 1, reviews: structuredClone([...this.records.values()]) };
  }

  private async requireChangeSet(roomId: string, changeSetId: string): Promise<StagedChangeSet> {
    if (!HASH_PATTERN.test(changeSetId)) throw invalidInput("changeSetId is invalid");
    const changeSet = await this.options.changeSets.get(roomId, changeSetId);
    if (!changeSet || changeSet.draft.roomId !== roomId || changeSet.changeSetId !== changeSetId) {
      throw new CollabError("CHANGE_SET_NOT_FOUND", "ChangeSet does not exist");
    }
    return changeSet;
  }

  private assertRecord(record: ReviewRecord, changeSet: StagedChangeSet): void {
    if (record.roomId !== changeSet.draft.roomId || record.changeSetId !== changeSet.changeSetId || record.authorId !== changeSet.draft.authorId) {
      throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review identity does not match its immutable ChangeSet");
    }
    try {
      for (const finding of record.findings) location(finding.location, changeSet);
    } catch {
      throw new CollabError("SNAPSHOT_INVALID", "ChangeSet Review Finding does not match its immutable ChangeSet");
    }
  }

  private createRecord(changeSet: StagedChangeSet): ReviewRecord {
    const record: ReviewRecord = {
      version: 1,
      roomId: changeSet.draft.roomId,
      changeSetId: changeSet.changeSetId,
      authorId: changeSet.draft.authorId,
      assignments: [],
      findings: [],
      decisions: [],
    };
    this.records.set(key(record.roomId, record.changeSetId), record);
    return record;
  }

  private view(changeSet: StagedChangeSet, record?: ReviewRecord): ChangeSetReview {
    const requiredReviewerId = record?.assignments.at(-1)?.reviewerId;
    const decision = record?.decisions.at(-1);
    const supersededByChangeSetId = this.successorByChangeSetId.get(changeSet.changeSetId);
    const status: ChangeSetReviewStatus = supersededByChangeSetId
      ? "superseded"
      : decision?.outcome ?? (requiredReviewerId ? "in-review" : "submitted");
    return {
      version: 1,
      roomId: changeSet.draft.roomId,
      changeSetId: changeSet.changeSetId,
      authorId: changeSet.draft.authorId,
      status,
      ...(requiredReviewerId ? { requiredReviewerId } : {}),
      ...(decision ? { decision: structuredClone(decision) } : {}),
      ...(record?.revision ? { supersedesChangeSetId: record.revision.supersedesChangeSetId } : {}),
      ...(supersededByChangeSetId ? { supersededByChangeSetId } : {}),
      assignmentCount: record?.assignments.length ?? 0,
      findingCount: record?.findings.length ?? 0,
    };
  }

  private assignmentEvent(assignment: ChangeSetReviewAssignment): CollaborationEvent {
    return {
      type: "changeset.review-assigned",
      roomId: assignment.roomId,
      assignment: {
        assignmentId: assignment.assignmentId,
        changeSetId: assignment.changeSetId,
        assignedBy: assignment.assignedBy,
        reviewerId: assignment.reviewerId,
        ...(assignment.previousReviewerId ? { previousReviewerId: assignment.previousReviewerId } : {}),
        createdAt: assignment.createdAt,
      },
    };
  }

  private findingEvent(finding: ChangeSetReviewFinding): CollaborationEvent {
    return {
      type: "changeset.finding-created",
      roomId: finding.roomId,
      finding: {
        findingId: finding.findingId,
        changeSetId: finding.changeSetId,
        authorId: finding.authorId,
        severity: finding.severity,
        location: structuredClone(finding.location),
        body: finding.body,
        createdAt: finding.createdAt,
      },
    };
  }

  private requireOpenRoom(roomId: string): void {
    if (this.options.rooms.getRoom(roomId).state !== "open") {
      throw new CollabError("ACTION_FORBIDDEN", "room is not open for ChangeSet Review changes");
    }
  }

  private timestamp(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("ChangeSet Review timestamp is invalid");
    return value;
  }

  private lastActivity(record: ReviewRecord): number {
    return Math.max(record.assignments.at(-1)?.createdAt ?? -1, record.findings.at(-1)?.createdAt ?? -1,
      record.decisions.at(-1)?.createdAt ?? -1, record.revision?.createdAt ?? -1);
  }

  private emit(event: CollaborationEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
