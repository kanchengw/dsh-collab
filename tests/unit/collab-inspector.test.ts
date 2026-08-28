import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { beginInspectorRefresh, DshCollabInspector, inspectorRoomState, mergePolledSideTask, reviewPointFilesFromInspection, type CollabInspectorState } from "../../src/collab-inspector.js";
import type { DshCollabClientSnapshot } from "../../src/dsh-client.js";

const room: DshCollabClientSnapshot = {
  roomId: "room-1",
  roomTitle: "Release",
  hostDisplayName: "Host",
  role: "host",
  connection: "online",
  onlineCount: 2,
  canSteer: true,
};

function render(state: CollabInspectorState, role: "host" | "participant" = "host", activeTab: "changes" | "reviews" | "tasks" = "changes"): string {
  return renderToStaticMarkup(createElement(DshCollabInspector, {
    open: true,
    roomId: room.roomId,
    role,
    state,
    onClose: vi.fn(),
    onRefresh: vi.fn(),
    onSetSharing: vi.fn(),
    onLoadSnapshot: vi.fn(),
    onLoadDiff: vi.fn(),
    activeTab,
    onSelectTab: vi.fn(),
    onCreateReviewPoint: vi.fn(async () => true),
    onReloadReviewPoints: vi.fn(),
    onLoadMoreReviewPoints: vi.fn(),
    onRefreshReviewPoints: vi.fn(),
    members: [{ memberId: "member-host", displayName: "Host" }, { memberId: "member-bob", displayName: "Bob" }],
    onSelectReviewPoint: vi.fn(),
    onCreateReviewFinding: vi.fn(async () => true),
    onSetReviewers: vi.fn(),
    onSetReviewLifecycle: vi.fn(),
    onSetReviewFindingState: vi.fn(),
    onLoadReviewPointDiff: vi.fn(),
    timeline: [
      { eventId: "event-1", contextEventId: "event-1", seq: 1, kind: "human", authorMemberId: "member-host", text: "The retry uses a stable key." },
      { eventId: "event-2", contextEventId: "event-2", seq: 2, kind: "agent", authorMemberId: "agent", text: "The key is room-scoped." },
    ],
    onStartLocalExplain: vi.fn(async () => true),
    onStartLocalReview: vi.fn(async () => true),
    onPublishLocalReview: vi.fn(async () => true),
    onAcceptReviewPublication: vi.fn(),
    onCancelLocalSideTask: vi.fn(),
  }));
}

describe("Collab Changes Inspector", () => {
  it("does not carry sharing or diff state across room changes and refreshes", () => {
    const sharing = { roomId: "room-1", enabled: true, enabledBy: "host", enabledAt: 10, revision: 1 } as const;
    expect(inspectorRoomState("room-2", sharing)).toEqual({ status: "idle" });
    expect(inspectorRoomState("room-1", sharing)).toEqual({ status: "idle", sharing });
    expect(beginInspectorRefresh({
      status: "ready",
      sharing,
      repository: { kind: "repository", root: "C:/repo", files: [], summary: { stagedFiles: 0, unstagedFiles: 0, additions: 0, deletions: 0, binaryFiles: 0 } },
      diff: { path: "src/old.ts", layer: "unstaged", patch: "old patch" },
    })).toEqual({
      status: "loading",
      sharing,
      repository: { kind: "repository", root: "C:/repo", files: [], summary: { stagedFiles: 0, unstagedFiles: 0, additions: 0, deletions: 0, binaryFiles: 0 } },
      error: undefined,
    });
  });

  it("shows Host workspace controls and current staged/unstaged changes", () => {
    const html = render({
      status: "ready",
      sharing: { roomId: room.roomId, enabled: true, enabledBy: "host", enabledAt: 10, revision: 1 },
      repository: {
        kind: "repository",
        root: "C:/private/repository",
        files: [
          { path: "src/changed.ts", staged: { kind: "modified", additions: 5, deletions: 2, binary: false } },
          { path: "README.md", unstaged: { kind: "modified", additions: 1, deletions: 0, binary: false } },
        ],
        summary: { stagedFiles: 1, unstagedFiles: 1, additions: 6, deletions: 2, binaryFiles: 0 },
      },
      diff: {
        path: "src/changed.ts",
        layer: "staged",
        patch: "diff --git a/src/changed.ts b/src/changed.ts\n--- a/src/changed.ts\n+++ b/src/changed.ts\n@@ -1 +1 @@\n-old line\n+new line\n",
      },
    });

    expect(html).toContain('data-collab-inspector="changes"');
    expect(html).toContain("Workspace sharing");
    expect(html).toContain('role="switch" aria-labelledby="collab-workspace-sharing-title"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain("2 files");
    expect(html).toContain("+6");
    expect(html).toContain("-2");
    expect(html).toContain("src/changed.ts");
    expect(html).toContain("Staged");
    expect(html).toContain("Unstaged");
    expect(html).toContain("old line");
    expect(html).toContain("new line");
    expect(html).not.toContain("C:/private/repository");
  });

  it("explains disabled sharing and renders an immutable Participant snapshot after loading", () => {
    const unknown = render({ status: "loading" }, "participant");
    expect(unknown).toContain("Checking workspace access");
    expect(unknown).not.toContain("The Host has not shared this workspace");

    const disabled = render({ status: "ready", sharing: { roomId: room.roomId, enabled: false, revision: 0 } }, "participant");
    expect(disabled).toContain("The Host has not shared this workspace");
    expect(disabled).not.toContain('role="switch"');
    expect(disabled).not.toContain("Load latest snapshot");

    const loaded = render({
      status: "ready",
      sharing: { roomId: room.roomId, enabled: true, enabledBy: "host", enabledAt: 10, revision: 1 },
      snapshot: {
        snapshotId: "a".repeat(64),
        roomId: room.roomId,
        hostSessionId: "session-private",
        roomEventSeq: 7,
        manifestHash: "b".repeat(64),
        files: [{ path: "src/changed.ts", contentHash: "c".repeat(64), size: 42, source: "tracked" }],
        createdAt: 20,
      },
    }, "participant");
    expect(loaded).toContain("Immutable snapshot");
    expect(loaded).toContain("src/changed.ts");
    expect(loaded).toContain("42 B");
    expect(loaded).not.toContain("session-private");
  });

  it("maps the current repository projection into one Review Point file per path", () => {
    expect(reviewPointFilesFromInspection({
      kind: "repository",
      root: "C:/private/repository",
      files: [
        { path: "src/new.ts", staged: { kind: "added", additions: 4, deletions: 0 }, unstaged: { kind: "modified", additions: 1, deletions: 1 } },
        { path: "src/untracked.ts", unstaged: { kind: "added" } },
        { path: "src/old.ts", unstaged: { kind: "deleted", additions: 0, deletions: 6 } },
        { path: "src/conflict.ts", unstaged: { kind: "unmerged" } },
      ],
      summary: { stagedFiles: 1, unstagedFiles: 3, additions: 5, deletions: 7, binaryFiles: 0 },
    })).toEqual([
      { path: "src/new.ts", status: "added", additions: 5, deletions: 1 },
      { path: "src/untracked.ts", status: "added", additions: 0, deletions: 0 },
      { path: "src/old.ts", status: "deleted", additions: 0, deletions: 6 },
      { path: "src/conflict.ts", status: "modified", additions: 0, deletions: 0 },
    ]);
  });

  it("renders Review Point lifecycle, freshness and progress as independent status", () => {
    const reviewPoint = {
      reviewPointId: "d".repeat(64), roomId: room.roomId, title: "Parser review", focus: "Check recovery", createdBy: "host", reviewerIds: [], lifecycle: "open" as const,
      roomEventSeq: 3, mainAgentSessionId: "session-1", workspaceSnapshotId: "a".repeat(64), headOid: "b".repeat(40),
      files: [{ path: "src/parser.ts", status: "modified" as const, snapshotContentHash: "c".repeat(64), additions: 4, deletions: 1 }], createdAt: 20,
    };
    const state: CollabInspectorState = {
      status: "ready",
      sharing: { roomId: room.roomId, enabled: true, enabledBy: "host", enabledAt: 10, revision: 1 },
      repository: { kind: "repository", root: "C:/private/repository", files: [], summary: { stagedFiles: 0, unstagedFiles: 0, additions: 0, deletions: 0, binaryFiles: 0 } },
      reviewPoints: [{ reviewPoint, freshness: "stale", progress: { roomEventDelta: 5, workspaceChangedFileCount: 2 } }],
    };
    const host = render(state, "host", "reviews");
    expect(host).toContain("Create review point");
    expect(host).toContain("Parser review");
    expect(host).toContain("Open");
    expect(host).toContain("Stale");
    expect(host).toContain("5 room events since capture");
    expect(host).toContain("2 workspace files changed");
    expect(host).not.toContain("C:/private/repository");

    const participant = render(state, "participant", "reviews");
    expect(participant).toContain("Reload reviews");
    expect(participant).not.toContain("Create review point");
    expect(participant).not.toContain("Refresh comparison");

    expect(render({ ...state, status: "error", error: "Review failed" }, "host", "reviews")).toContain("Review failed");
  });

  it("keeps older Review Points reachable when the list has another page", () => {
    const html = render({ status: "ready", reviewPoints: [], reviewNextCursor: "d".repeat(64) }, "participant", "reviews");
    expect(html).toContain("Load older reviews");
  });

  it("lets both roles publish findings while reserving assignments and decisions for the Host", () => {
    const reviewPoint = {
      reviewPointId: "d".repeat(64), roomId: room.roomId, title: "Parser review", createdBy: "member-host", reviewerIds: ["member-bob"], lifecycle: "open" as const,
      roomEventSeq: 3, mainAgentSessionId: "session-1", workspaceSnapshotId: "a".repeat(64), headOid: "b".repeat(40),
      files: [{ path: "src/parser.ts", status: "modified" as const, snapshotContentHash: "c".repeat(64), additions: 4, deletions: 1 }], createdAt: 20,
    };
    const finding = {
      findingId: "e".repeat(64), roomId: room.roomId, reviewPointId: reviewPoint.reviewPointId, authorId: "member-bob", severity: "high" as const,
      location: { kind: "line" as const, path: "src/parser.ts", line: 2 }, body: "Recovery skips the token.", state: "open" as const, createdAt: 30,
    };
    const state: CollabInspectorState = {
      status: "ready",
      reviewPoints: [{ reviewPoint, freshness: "current", progress: { roomEventDelta: 0, workspaceChangedFileCount: 0 } }],
      selectedReviewPointId: reviewPoint.reviewPointId,
      reviewFindings: { [reviewPoint.reviewPointId]: [finding] },
      selectedReviewDiffPath: "src/parser.ts",
      reviewDiffs: { [reviewPoint.reviewPointId]: { "src/parser.ts": { path: "src/parser.ts", kind: "text", oldText: "old token\n", newText: "new token\n" } } },
    };

    const participant = render(state, "participant", "reviews");
    expect(participant).toContain("Add finding");
    expect(participant).toContain("Recovery skips the token.");
    expect(participant).toContain("Historical code diff");
    expect(participant).toContain("Review this point with local Agent");
    expect(participant).toContain("old token");
    expect(participant).toContain("new token");
    expect(participant).not.toContain(">Accept<");
    const host = render(state, "host", "reviews");
    expect(host).toContain("Reviewers");
    expect(host).toContain("Bob");
    expect(host).toContain(">Accept<");
    expect(host).toContain(">Dismiss<");

    const legacy = render({
      ...state,
      reviewDiffs: { [reviewPoint.reviewPointId]: { "src/parser.ts": { path: "src/parser.ts", kind: "unavailable" } } },
    }, "participant", "reviews");
    expect(legacy).toContain("predates historical diff capture");
  });

  it("gives both roles a private requester-local Explain task with explicit room context selection", () => {
    const sideTask = {
      task: {
        taskId: "task-1", roomId: room.roomId, type: "explain" as const, localPrompt: "Explain the retry", executor: "requester-local" as const,
        context: { roomEventSeq: 2, selectedRoomEventIds: ["event-1"] }, state: { status: "running" as const },
        publication: { status: "private" as const }, requestedBy: "member-bob", createdAt: 20,
      },
      output: "The retry is safe because",
      revision: 3,
    };
    const participant = render({ status: "ready", sideTask }, "participant", "tasks");

    expect(participant).toContain('data-collab-inspector="tasks"');
    expect(participant).toContain("Private Side Work");
    expect(participant).toContain("The retry uses a stable key.");
    expect(participant).toContain("The key is room-scoped.");
    expect(participant).toContain('type="checkbox"');
    expect(participant).toContain("Ask your local Agent");
    expect(participant).toContain("Read a code snapshot");
    expect(participant).toContain("The retry is safe because");
    expect(participant).toContain("Running");
    expect(participant).toContain("Cancel");
    expect(participant).not.toContain("Publish");
    expect(render({ status: "ready" }, "host", "tasks")).toContain("Private Side Work");
  });

  it("shows requester-local Review findings as private task output", () => {
    const sideTask = {
      task: {
        taskId: "task-review", roomId: room.roomId, type: "review" as const, localPrompt: "Review parser", executor: "requester-local" as const,
        context: { roomEventSeq: 2, selectedRoomEventIds: ["event-1"], reviewPointId: "d".repeat(64), workspaceSnapshotId: "a".repeat(64) }, state: { status: "completed" as const },
        publication: { status: "private" as const }, requestedBy: "member-bob", createdAt: 20,
      },
      output: "One issue found.",
      findings: [{ severity: "high" as const, location: { kind: "line" as const, path: "src/parser.ts", line: 7 }, body: "The fallback drops the token." }],
      revision: 4,
    };

    const html = render({ status: "ready", sideTask }, "participant", "tasks");

    expect(html).toContain("Private review result");
    expect(html).toContain("src/parser.ts:7");
    expect(html).toContain("The fallback drops the token.");
    expect(html).toContain("Publish selected findings");
    expect(html).toContain('type="checkbox"');
  });

  it("shows published Sidecar results in the Review Point and reserves Mainline acceptance for the Host", () => {
    const reviewPoint = {
      reviewPointId: "d".repeat(64), roomId: room.roomId, title: "Parser review", createdBy: "member-host", reviewerIds: [], lifecycle: "open" as const,
      roomEventSeq: 3, mainAgentSessionId: "session-1", workspaceSnapshotId: "a".repeat(64), headOid: "b".repeat(40),
      files: [{ path: "src/parser.ts", status: "modified" as const, snapshotContentHash: "c".repeat(64), additions: 4, deletions: 1 }], createdAt: 20,
    };
    const finding = {
      findingId: "e".repeat(64), roomId: room.roomId, reviewPointId: reviewPoint.reviewPointId, authorId: "member-bob", severity: "high" as const,
      location: { kind: "line" as const, path: "src/parser.ts", line: 7 }, body: "The fallback drops the token.", state: "open" as const, createdAt: 30,
    };
    const publication = {
      publicationId: "f".repeat(64), roomId: room.roomId, reviewPointId: reviewPoint.reviewPointId, taskId: "task-review",
      workspaceSnapshotId: reviewPoint.workspaceSnapshotId, publishedBy: "member-bob", summary: "One issue found.",
      findingIds: [finding.findingId], state: "published" as const, createdAt: 30,
    };
    const state: CollabInspectorState = {
      status: "ready",
      reviewPoints: [{ reviewPoint, freshness: "current", progress: { roomEventDelta: 0, workspaceChangedFileCount: 0 } }],
      selectedReviewPointId: reviewPoint.reviewPointId,
      reviewFindings: { [reviewPoint.reviewPointId]: [finding] },
      reviewPublications: { [reviewPoint.reviewPointId]: [publication] },
    };

    const host = render(state, "host", "reviews");
    expect(host).toContain("Published local review");
    expect(host).toContain("One issue found.");
    expect(host).toContain("Accept for Main Agent");
    expect(host).not.toContain(">Accept<");
    const participant = render(state, "participant", "reviews");
    expect(participant).toContain("Published local review");
    expect(participant).not.toContain("Accept for Main Agent");
  });

  it("does not let delayed polling replace or regress the active local SideTask", () => {
    const task = (taskId: string, revision: number, status: "running" | "completed") => ({
      task: {
        taskId, roomId: room.roomId, type: "explain" as const, localPrompt: "Explain", executor: "requester-local" as const,
        context: { roomEventSeq: 2, selectedRoomEventIds: ["event-1"] }, state: { status },
        publication: { status: "private" as const }, requestedBy: "member-bob", createdAt: 20,
      },
      output: status === "completed" ? "done" : "partial",
      revision,
    });
    const completed: CollabInspectorState = { status: "ready", sideTask: task("task-1", 4, "completed") };

    expect(mergePolledSideTask(completed, task("task-1", 3, "running"), "task-1")).toBe(completed);
    expect(mergePolledSideTask(completed, task("task-new", 1, "running"), "task-1")).toMatchObject({ sideTask: { task: { taskId: "task-new" } } });
    expect(mergePolledSideTask(completed, undefined, "task-1")).not.toHaveProperty("sideTask");
    expect(mergePolledSideTask(completed, task("task-1", 5, "completed"), "task-1")).toMatchObject({ sideTask: { revision: 5 } });
  });

  it("uses a room drawer at narrow widths instead of a floating window", () => {
    const css = readFileSync(resolve(process.cwd(), "src/collab-inspector.module.css"), "utf8");
    const narrow = css.slice(css.indexOf("@media (max-width: 760px)"));

    expect(narrow).toMatch(/\.inspector\s*{[^}]*position:\s*absolute/);
    expect(narrow).toMatch(/\.inspector\s*{[^}]*inset:/);
    expect(narrow).not.toMatch(/border-radius:\s*\d/);
    expect(css).not.toMatch(/--dsw-alias-label-inverse|--dsw-alias-state-danger|--dsw-font-family-mono/);
  });
});
