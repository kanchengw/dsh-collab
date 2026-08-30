import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CollabReviews,
  validateCollabReviewsSnapshot,
  type CollabReviewsPort,
  type CollabReviewsSnapshot,
} from "../../src/collab-reviews.js";
import type { StagedChangeSet } from "../../src/change-set-staging.js";
import type { ChangeSetReview } from "../../src/change-set-reviews.js";
import { zh, type CollabTranslate } from "../../src/locales.js";

const t: CollabTranslate = (key, params) => {
  const template = zh[key];
  return params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
    : template;
};

function changeSet(id = "a".repeat(64), title = "Fix reconnect"): StagedChangeSet {
  return {
    version: 1,
    changeSetId: id,
    submittedAt: 20,
    draft: {
      version: 1,
      draftId: id,
      roomId: "room-1",
      authorId: "member-author",
      baseWorkspaceVersionId: "version-1",
      title,
      summary: "Keep state when the stream reconnects.",
      files: [{
        path: "src/reconnect.ts",
        operation: "modify",
        baseContentHash: "b".repeat(64),
        resultContentHash: "c".repeat(64),
        baseSize: 10,
        resultSize: 12,
        additions: 2,
        deletions: 1,
      }],
      artifact: {
        kind: "changeset-draft.v1",
        artifactId: id,
        manifestHash: id,
        patchHash: "d".repeat(64),
        patchBytes: 40,
        resultBytes: 12,
      },
      createdAt: 10,
    },
  };
}

function review(overrides: Partial<ChangeSetReview> = {}): ChangeSetReview {
  return {
    version: 1,
    roomId: "room-1",
    changeSetId: "a".repeat(64),
    authorId: "member-author",
    status: "in-review",
    requiredReviewerId: "member-reviewer",
    assignmentCount: 1,
    findingCount: 1,
    ...overrides,
  };
}

function snapshot(overrides: Partial<CollabReviewsSnapshot> = {}): CollabReviewsSnapshot {
  return {
    roomId: "room-1",
    role: "participant",
    currentMemberId: "member-reviewer",
    connection: "online",
    members: [
      { memberId: "member-author", displayName: "Author" },
      { memberId: "member-reviewer", displayName: "Reviewer" },
      { memberId: "member-other", displayName: "Other" },
    ],
    reviews: [{
      review: review(),
      changeSet: changeSet(),
      findings: [{
        findingId: "e".repeat(64),
        roomId: "room-1",
        changeSetId: "a".repeat(64),
        authorId: "member-other",
        severity: "high",
        location: { kind: "line", path: "src/reconnect.ts", line: 3 },
        body: "Reconnect can overtake restore.",
        createdAt: 30,
      }],
    }],
    selectedChangeSetId: "a".repeat(64),
    ...overrides,
  };
}

function port(value: CollabReviewsSnapshot): CollabReviewsPort {
  return {
    getSnapshot: () => value,
    subscribe: () => () => {},
    refresh: vi.fn(),
    selectReview: vi.fn(),
    assignReviewer: vi.fn(),
    createFinding: vi.fn(),
    decide: vi.fn(),
    apply: vi.fn(),
  };
}

describe("Collab Reviews", () => {
  it("fails closed on cross-room reviews, findings, or selected state", () => {
    expect(() => validateCollabReviewsSnapshot(snapshot({
      reviews: [{ review: review({ roomId: "room-2" }), changeSet: changeSet(), findings: [] }],
    }))).toThrow(/room/i);
    expect(() => validateCollabReviewsSnapshot(snapshot({
      reviews: [{ review: review(), changeSet: changeSet(), findings: [{ ...snapshot().reviews[0]!.findings[0]!, roomId: "room-2" }] }],
    }))).toThrow(/room/i);
    expect(() => validateCollabReviewsSnapshot(snapshot({ selectedChangeSetId: "f".repeat(64) }))).toThrow(/selected/i);
  });

  it("renders the review queue, immutable detail, Findings, and revision history without claiming approved is applied", () => {
    const approved = review({
      status: "approved",
      decision: {
        decisionId: "d".repeat(64),
        roomId: "room-1",
        changeSetId: "a".repeat(64),
        reviewerId: "member-reviewer",
        outcome: "approved",
        note: "Ready for Owner preflight.",
        createdAt: 40,
      },
      supersedesChangeSetId: "f".repeat(64),
    });
    const html = renderToStaticMarkup(createElement(CollabReviews, { port: port(snapshot({ reviews: [{ ...snapshot().reviews[0]!, review: approved }] })) }));

    expect(html).toContain("Reviews");
    expect(html).toContain("Fix reconnect");
    expect(html).toContain("Approved");
    expect(html).toContain("Awaiting Owner apply");
    expect(html).toContain("Reconnect can overtake restore.");
    expect(html).toContain("Supersedes");
    expect(html).not.toContain(">Applied<");
  });

  it("shows decision controls only to the current required reviewer while keeping Finding available to active members", () => {
    const reviewerHtml = renderToStaticMarkup(createElement(CollabReviews, { port: port(snapshot()) }));
    const otherHtml = renderToStaticMarkup(createElement(CollabReviews, { port: port(snapshot({ currentMemberId: "member-other" })) }));

    expect(reviewerHtml).toContain("Approve");
    expect(reviewerHtml).toContain("Request changes");
    expect(reviewerHtml).toContain("Add Finding");
    expect(otherHtml).not.toContain(">Approve<");
    expect(otherHtml).not.toContain("Request changes");
    expect(otherHtml).toContain("Add Finding");
  });

  it("renders the complete Reviews slice in Simplified Chinese", () => {
    const html = renderToStaticMarkup(createElement(CollabReviews, { port: port(snapshot()), t }));
    expect(html).toContain("审阅");
    expect(html).toContain("审阅中");
    expect(html).toContain("添加审阅意见");
    expect(html).toContain("要求修改");
  });

  it("keeps Owner apply explicit and renders the durable applied state", () => {
    const ownerPort = port(snapshot({ role: "owner", currentMemberId: "member-author", reviews: [{
      ...snapshot().reviews[0]!,
      review: review({
        status: "approved",
        decision: {
          decisionId: "d".repeat(64), roomId: "room-1", changeSetId: "a".repeat(64),
          reviewerId: "member-reviewer", outcome: "approved", createdAt: 40,
        },
      }),
    }] }));
    const approved = renderToStaticMarkup(createElement(CollabReviews, { port: ownerPort }));

    expect(approved).toContain(">Apply<");
    expect(approved).toContain("Awaiting Owner apply");

    const applied = renderToStaticMarkup(createElement(CollabReviews, { port: port(snapshot({ reviews: [{
      ...snapshot().reviews[0]!, review: review({
        status: "applied",
        application: {
          version: 1, applicationId: "e".repeat(64), roomId: "room-1", changeSetId: "a".repeat(64),
          appliedBy: "member-author", workspaceVersionId: "f".repeat(64), integrationId: "1".repeat(64), createdAt: 50,
        },
      }),
    }] })) }));

    expect(applied).toContain("Applied");
    expect(applied).not.toContain(">Apply<");
  });
});
