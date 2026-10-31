import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
      linked: false,
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
    setWorkspaceSharing: vi.fn(),
    sync: vi.fn(),
    discardAndSync: vi.fn(),
    createDraft: vi.fn(),
    submitDraft: vi.fn(),
    selectChangeSet: vi.fn(),
  };
}

describe("Collab Changes", () => {
  it("uses compact grouped surfaces for Changes and Reviews inside the Collab Bar", () => {
    const css = readFileSync(resolve(process.cwd(), "src/collab-changes.module.css"), "utf8");
    expect(css).toMatch(/\.changes\s*\{[^}]*display:\s*flex[^}]*gap:/s);
    expect(css).toMatch(/\.card\s*\{[^}]*border:\s*1px solid[^}]*border-radius:/s);
    expect(css).not.toMatch(/\.card\s*\{[^}]*border-bottom:/s);
  });

  it("offers a task link before the Participant submits a ChangeSet draft", () => {
    const html = renderToStaticMarkup(createElement(CollabChanges, {
      port: port(participantSnapshot({
        draft: { draft: draft(), patch: "diff --git a/a b/a\n" },
        workspace: { kind: "ready", path: "C:/collab/room-1/workspace", baseVersionId: "version-1", dirtyPaths: ["src/reconnect.ts"], linked: true },
      })),
      tasks: [{ taskId: "task-1", title: "Fix reconnect", status: "doing" }],
      t,
    }));

    expect(html).toContain("关联任务");
    expect(html).toContain("不关联任务");
    expect(html).toContain("Fix reconnect");
  });

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
    expect(html).toContain("The change operation failed. Try again.");
    expect(html).not.toContain("The Host cannot be reached");
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
        workspaceSharingEnabled: false,
        workspace: { kind: "owner", latestVersionId: "version-2" },
        staged: [{ changeSet: staged(), patch: "diff --git a/src/reconnect.ts b/src/reconnect.ts\n" }],
        selectedChangeSetId: "a".repeat(64),
      }),
    }));

    expect(html).toContain("Staged ChangeSets");
    expect(html).toContain("Enable workspace sharing");
    expect(html).not.toContain(">Publish current workspace version</button>");
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
          linked: false,
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

  it("offers explicit refresh and native DSH opening until the Room Workspace Session is linked", () => {
    const unlinked = renderToStaticMarkup(createElement(CollabChanges, {
      port: { ...port(participantSnapshot()), openWorkspace: vi.fn() },
    }));
    const linked = renderToStaticMarkup(createElement(CollabChanges, {
      port: { ...port(participantSnapshot({
        workspace: {
          kind: "ready",
          path: "C:/collab/room-1/workspace",
          baseVersionId: "version-1",
          latestVersionId: "version-1",
          dirtyPaths: [],
          linked: true,
        },
      })), openWorkspace: vi.fn() },
    }));

    expect(unlinked).toContain("Refresh");
    expect(unlinked).toContain("Open Room Workspace in DSH");
    expect(linked).toContain("Refresh");
    expect(linked).not.toContain("Open Room Workspace in DSH");
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
