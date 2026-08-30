import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  CollabChanges,
  validateCollabChangesSnapshot,
  type CollabChangesPort,
  type CollabChangesSnapshot,
} from "../../src/collab-changes.js";
import type { ChangeSetDraft } from "../../src/change-sets.js";
import type { StagedChangeSet } from "../../src/change-set-staging.js";
import { zh, type CollabTranslate } from "../../src/locales.js";

const t: CollabTranslate = (key, params) => {
  const template = zh[key];
  return params
    ? template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
    : template;
};

function draft(overrides: Partial<ChangeSetDraft> = {}): ChangeSetDraft {
  return {
    version: 1,
    draftId: "a".repeat(64),
    roomId: "room-1",
    authorId: "member-1",
    baseWorkspaceVersionId: "version-1",
    title: "Fix reconnect",
    summary: "Keep the local draft after a network failure.",
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
      artifactId: "a".repeat(64),
      manifestHash: "d".repeat(64),
      patchHash: "e".repeat(64),
      patchBytes: 48,
      resultBytes: 12,
    },
    createdAt: 100,
    ...overrides,
  };
}

function staged(overrides: Partial<StagedChangeSet> = {}): StagedChangeSet {
  const changeSetDraft = draft();
  return {
    version: 1,
    changeSetId: changeSetDraft.draftId,
    draft: changeSetDraft,
    submittedAt: 200,
    ...overrides,
  };
}

function participantSnapshot(overrides: Partial<CollabChangesSnapshot> = {}): CollabChangesSnapshot {
  return {
    roomId: "room-1",
    role: "participant",
    connection: "online",
    workspace: {
      kind: "ready",
      path: "C:/collab/room-1/workspace",
      baseVersionId: "version-1",
      latestVersionId: "version-2",
      dirtyPaths: ["src/reconnect.ts", "tests/reconnect.test.ts"],
    },
    staged: [],
    ...overrides,
  };
}

function port(snapshot: CollabChangesSnapshot): CollabChangesPort {
  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => {},
    refresh: vi.fn(),
    sync: vi.fn(),
    discardAndSync: vi.fn(),
    createDraft: vi.fn(),
    submitDraft: vi.fn(),
    selectChangeSet: vi.fn(),
  };
}

describe("Collab Changes", () => {
  it("fails closed instead of projecting draft or staged state from another room", () => {
    expect(() => validateCollabChangesSnapshot(participantSnapshot({
      draft: { draft: draft({ roomId: "room-2" }), patch: "diff --git a/a b/a\n" },
    }))).toThrow(/room/i);

    expect(() => validateCollabChangesSnapshot(participantSnapshot({
      staged: [{ changeSet: staged({ draft: draft({ roomId: "room-2" }) }), patch: "diff" }],
    }))).toThrow(/room/i);

    expect(() => validateCollabChangesSnapshot(participantSnapshot({
      workspace: { kind: "owner", latestVersionId: "version-2" },
    }))).toThrow(/role/i);
  });

  it("keeps a persisted Participant draft visible while offline and offers explicit recovery", () => {
    const html = renderToStaticMarkup(createElement(CollabChanges, {
      port: port(participantSnapshot({
        connection: "offline",
        draft: {
          draft: draft(),
          patch: "diff --git a/src/reconnect.ts b/src/reconnect.ts\n+<script>safe</script>\n",
        },
        error: "The Host cannot be reached",
      })),
    }));

    expect(html).toContain("Changes");
    expect(html).toContain("Upstream available");
    expect(html).toContain("2 local files changed");
    expect(html).toContain("Fix reconnect");
    expect(html).toContain("The Host cannot be reached");
    expect(html).toContain("Retry");
    expect(html).toContain("&lt;script&gt;safe&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("type=\"file\"");
  });

  it("renders Owner staging artifacts and immutable diff without Participant workspace write controls", () => {
    const html = renderToStaticMarkup(createElement(CollabChanges, {
      port: port({
        roomId: "room-1",
        role: "owner",
        connection: "online",
        workspace: { kind: "owner", latestVersionId: "version-2" },
        staged: [{ changeSet: staged(), patch: "diff --git a/src/reconnect.ts b/src/reconnect.ts\n" }],
        selectedChangeSetId: "a".repeat(64),
      }),
    }));

    expect(html).toContain("Staged ChangeSets");
    expect(html).toContain("Fix reconnect");
    expect(html).toContain("Immutable diff");
    expect(html).not.toContain("Create draft");
    expect(html).not.toContain("Discard local changes");
    expect(html).not.toContain("<textarea");
  });

  it("shows clean fast-forward separately from the destructive dirty-workspace path", () => {
    const clean = renderToStaticMarkup(createElement(CollabChanges, {
      port: port(participantSnapshot({
        workspace: {
          kind: "ready",
          path: "C:/collab/room-1/workspace",
          baseVersionId: "version-1",
          latestVersionId: "version-2",
          dirtyPaths: [],
        },
      })),
    }));
    const dirty = renderToStaticMarkup(createElement(CollabChanges, {
      port: port(participantSnapshot()),
    }));

    expect(clean).toContain("Sync latest version");
    expect(clean).not.toContain("Discard local changes");
    expect(dirty).toContain("Create draft");
    expect(dirty).toContain("Discard local changes and sync");
  });

  it("renders the complete Changes slice in Simplified Chinese", () => {
    const html = renderToStaticMarkup(createElement(CollabChanges, {
      port: port(participantSnapshot()),
      t,
    }));

    expect(html).toContain("变更");
    expect(html).toContain("上游有新版本");
    expect(html).toContain("本地有 2 个文件变更");
    expect(html).toContain("创建草稿");
  });
});
