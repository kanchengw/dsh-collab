import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { EventLedger } from "../../src/events.js";
import { ReviewPointService } from "../../src/review-points.js";
import { ReviewService } from "../../src/reviews.js";
import { RoomStore } from "../../src/room.js";

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

function fixture() {
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Release", hostDisplayName: "Host", now: 1 });
  rooms.addMember("room-1", { memberId: "member-bob", principalId: "bob", displayName: "Bob", now: 2 });
  rooms.addMember("room-1", { memberId: "member-carol", principalId: "carol", displayName: "Carol", now: 3 });
  const ledger = new EventLedger();
  const files = [{ path: "src/parser.ts", contentHash: hash("line 1\nline 2\n"), size: 14, source: "tracked" as const }];
  const snapshot: WorkspaceSnapshotPackage = {
    snapshotId: "snapshot-1", roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 0,
    headOid: "a".repeat(40), manifestHash: hash(JSON.stringify(files)), files, createdAt: 10,
  };
  const reviewPoints = new ReviewPointService({ rooms, ledger, snapshots: { load: async () => snapshot }, now: () => 20 });
  const point = reviewPoints.create({
    roomId: "room-1", principalId: "host", clientRequestId: "point-1", title: "Parser review", snapshot,
    files: [{ path: "src/parser.ts", status: "modified", additions: 2, deletions: 1 }],
    diffs: [{ path: "src/parser.ts", kind: "text", oldText: "line 1\n", newText: "line 1\nline 2\n" }],
  });
  const reviews = new ReviewService({ rooms, reviewPoints, now: () => 30 });
  return { rooms, reviewPoints, reviews, point };
}

describe("ReviewService", () => {
  it("lets active members publish immutable, idempotent findings on Review Point anchors", () => {
    const { reviews, point } = fixture();
    const input = {
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, clientRequestId: "finding-1",
      severity: "high" as const, location: { kind: "line" as const, path: "src/parser.ts", line: 2 }, body: "Recovery skips the token.",
    };
    const finding = reviews.createFinding(input);

    expect(reviews.createFinding(input)).toEqual(finding);
    expect(reviews.listFindings({ roomId: "room-1", principalId: "carol", reviewPointId: point.reviewPointId })).toEqual({ findings: [finding] });
    expect(() => reviews.createFinding({ ...input, body: "Different payload" })).toThrow("conflicts");
    expect(() => reviews.createFinding({ ...input, clientRequestId: "finding-2", location: { kind: "file", path: "src/missing.ts" } })).toThrow("path");
    expect(() => reviews.createFinding({ ...input, clientRequestId: "finding-3", location: { kind: "line", path: "src/parser.ts", line: 0 } })).toThrow("line");
    const second = reviews.createFinding({ ...input, clientRequestId: "finding-4", body: "Second finding." });
    const firstPage = reviews.listFindings({ roomId: "room-1", principalId: "carol", reviewPointId: point.reviewPointId, limit: 1 });
    expect(firstPage).toEqual({ findings: [second], nextCursor: second.findingId });
    expect(reviews.listFindings({ roomId: "room-1", principalId: "carol", reviewPointId: point.reviewPointId, after: firstPage.nextCursor }))
      .toEqual({ findings: [finding] });
  });

  it("returns an already-created finding after closure but rejects new writes", () => {
    const { rooms, reviews, point } = fixture();
    const input = {
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, clientRequestId: "finding-1",
      severity: "note" as const, location: { kind: "general" as const }, body: "Keep this note.",
    };
    const finding = reviews.createFinding(input);
    rooms.setRoomState("room-1", "closed");

    expect(reviews.createFinding(input)).toEqual(finding);
    expect(() => reviews.createFinding({ ...input, clientRequestId: "finding-2" })).toThrow("not open");
  });

  it("returns the current finding state when a lost create response is retried after a Host decision", () => {
    const { reviews, point } = fixture();
    const input = {
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, clientRequestId: "finding-1",
      severity: "high" as const, location: { kind: "line" as const, path: "src/parser.ts", line: 2 }, body: "Recovery skips the token.",
    };
    const finding = reviews.createFinding(input);
    const accepted = reviews.setFindingState({
      roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId,
      findingId: finding.findingId, state: "accepted",
    });

    expect(reviews.createFinding(input)).toEqual(accepted);
    expect(() => reviews.createFinding({ ...input, severity: "low" })).toThrow("conflicts");
    expect(() => reviews.createFinding({ ...input, location: { kind: "file", path: "src/parser.ts" } })).toThrow("conflicts");
    expect(() => reviews.createFinding({ ...input, body: "Different payload" })).toThrow("conflicts");
  });

  it("treats reviewer assignment as workflow metadata and keeps Host decisions one-way", () => {
    const { rooms, reviews, point } = fixture();
    const finding = reviews.createFinding({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, clientRequestId: "finding-1",
      severity: "medium", location: { kind: "general" }, body: "Please add a regression test.",
    });

    expect(() => reviews.setReviewers({ roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, reviewerIds: ["member-bob"] })).toThrow("Host");
    expect(reviews.setReviewers({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, reviewerIds: ["member-bob", "member-carol"] })).toMatchObject({ reviewerIds: ["member-bob", "member-carol"] });
    rooms.setMemberStatus("room-1", "member-carol", "suspended");
    expect(() => reviews.setReviewers({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, reviewerIds: ["member-carol"] })).toThrow("active");

    expect(() => reviews.setFindingState({ roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, findingId: finding.findingId, state: "accepted" })).toThrow("Host");
    expect(reviews.setFindingState({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, findingId: finding.findingId, state: "accepted" })).toMatchObject({ state: "accepted", decidedBy: expect.any(String) });
    expect(() => reviews.setFindingState({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, findingId: finding.findingId, state: "dismissed" })).toThrow("terminal");

    expect(reviews.setLifecycle({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, lifecycle: "changes-requested" })).toMatchObject({ lifecycle: "changes-requested" });
    expect(() => reviews.setLifecycle({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, lifecycle: "open" })).toThrow("transition");
    expect(reviews.setLifecycle({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, lifecycle: "approved" })).toMatchObject({ lifecycle: "approved" });
    expect(reviews.setLifecycle({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, lifecycle: "closed" })).toMatchObject({ lifecycle: "closed" });
    expect(() => reviews.createFinding({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, clientRequestId: "after-close",
      severity: "note", location: { kind: "general" }, body: "Too late.",
    })).toThrow("not open");
  });

  it("blocks new workflow mutations after the room closes while preserving idempotent retries", () => {
    const { rooms, reviews, point } = fixture();
    const finding = reviews.createFinding({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, clientRequestId: "finding-1",
      severity: "medium", location: { kind: "general" }, body: "Please add a regression test.",
    });
    const accepted = reviews.setFindingState({
      roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId,
      findingId: finding.findingId, state: "accepted",
    });
    rooms.setRoomState("room-1", "closed");

    expect(() => reviews.setReviewers({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, reviewerIds: ["member-bob"] })).toThrow("not open");
    expect(() => reviews.setLifecycle({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, lifecycle: "approved" })).toThrow("not open");
    expect(() => reviews.setFindingState({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, findingId: finding.findingId, state: "dismissed" })).toThrow("not open");
    expect(reviews.setFindingState({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, findingId: finding.findingId, state: "accepted" })).toEqual(accepted);
  });

  it("treats a closed Review Point as terminal for reviewer and finding mutations", () => {
    const { reviews, point } = fixture();
    const finding = reviews.createFinding({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, clientRequestId: "finding-1",
      severity: "medium", location: { kind: "general" }, body: "Please add a regression test.",
    });
    reviews.setLifecycle({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, lifecycle: "closed" });

    expect(() => reviews.setReviewers({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, reviewerIds: ["member-bob"] })).toThrow("Review Point is closed");
    expect(() => reviews.setFindingState({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, findingId: finding.findingId, state: "accepted" })).toThrow("Review Point is closed");
  });

  it("bounds persisted findings per room", () => {
    const { reviews, point } = fixture();
    for (let index = 0; index < 1_000; index += 1) {
      reviews.createFinding({
        roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, clientRequestId: `finding-${String(index)}`,
        severity: "note", location: { kind: "general" }, body: "Finding.",
      });
    }

    expect(() => reviews.createFinding({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, clientRequestId: "finding-over-limit",
      severity: "note", location: { kind: "general" }, body: "One too many.",
    })).toThrow("limit");
  });

  it("restores findings, decisions and workflow state without duplicating them", () => {
    const { rooms, reviewPoints, reviews, point } = fixture();
    const finding = reviews.createFinding({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, clientRequestId: "finding-1",
      severity: "note", location: { kind: "file", path: "src/parser.ts" }, body: "Naming could be clearer.",
    });
    reviews.setFindingState({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, findingId: finding.findingId, state: "dismissed" });
    reviews.setReviewers({ roomId: "room-1", principalId: "host", reviewPointId: point.reviewPointId, reviewerIds: ["member-bob"] });

    const restored = ReviewService.fromSnapshot({ rooms, reviewPoints, now: () => 40 }, reviews.snapshot());
    expect(restored.listFindings({ roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId })).toMatchObject({
      findings: [{ findingId: finding.findingId, state: "dismissed", decidedAt: 30 }],
    });
  });

  it("rejects malformed or over-limit persisted findings as invalid snapshots", () => {
    const { rooms, reviewPoints, reviews, point } = fixture();
    const finding = reviews.createFinding({
      roomId: "room-1", principalId: "bob", reviewPointId: point.reviewPointId, clientRequestId: "finding-1",
      severity: "note", location: { kind: "general" }, body: "Keep this note.",
    });
    const options = { rooms, reviewPoints };
    const invalidSeverity = { ...reviews.snapshot(), findings: [{ ...finding, severity: "urgent" as "note" }] };

    expect(() => ReviewService.fromSnapshot(options, invalidSeverity)).toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
    expect(() => ReviewService.fromSnapshot(options, {
      version: 1,
      findings: [{ ...finding, state: "accepted", decidedBy: "member-bob", decidedAt: 31 }],
    })).toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
    expect(() => ReviewService.fromSnapshot(options, {
      version: 1,
      findings: Array.from({ length: 1_001 }, (_, index) => ({ ...finding, findingId: hash(`finding-${String(index)}`) })),
    })).toThrow(expect.objectContaining({ code: "SNAPSHOT_INVALID" }));
  });
});
