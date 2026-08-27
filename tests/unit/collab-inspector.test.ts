import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { beginInspectorRefresh, DshCollabInspector, inspectorRoomState, type CollabInspectorState } from "../../src/collab-inspector.js";
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

function render(state: CollabInspectorState, role: "host" | "participant" = "host"): string {
  return renderToStaticMarkup(createElement(DshCollabInspector, {
    open: true,
    role,
    state,
    onClose: vi.fn(),
    onRefresh: vi.fn(),
    onSetSharing: vi.fn(),
    onLoadSnapshot: vi.fn(),
    onLoadDiff: vi.fn(),
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
    expect(html).toContain('role="switch"');
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

  it("uses a room drawer at narrow widths instead of a floating window", () => {
    const css = readFileSync(resolve(process.cwd(), "src/collab-inspector.module.css"), "utf8");
    const narrow = css.slice(css.indexOf("@media (max-width: 760px)"));

    expect(narrow).toMatch(/\.inspector\s*{[^}]*position:\s*absolute/);
    expect(narrow).toMatch(/\.inspector\s*{[^}]*inset:/);
    expect(narrow).not.toMatch(/border-radius:\s*\d/);
    expect(css).not.toMatch(/--dsw-alias-label-inverse|--dsw-alias-state-danger|--dsw-font-family-mono/);
  });
});
