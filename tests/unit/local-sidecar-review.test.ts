import { describe, expect, it, vi } from "vitest";
import type { LocalAgentFrame, LocalAgentSessionPort } from "../../src/dsh-local-agent.js";
import {
  LocalSidecarService,
  type LocalSidecarWorkspacePort,
  type LocalSideTaskSnapshot,
} from "../../src/local-sidecar.js";

function harness() {
  const listeners = new Map<string, (frame: LocalAgentFrame) => void>();
  const starts: Array<{ cwd?: string; prompt: string; readOnlyRoot?: string }> = [];
  const disposedSessions: string[] = [];
  const port: LocalAgentSessionPort = {
    async start(input) {
      starts.push(input);
      return { sessionId: `session-${String(starts.length)}` };
    },
    subscribe(sessionId, listener) {
      listeners.set(sessionId, listener);
      return () => { listeners.delete(sessionId); };
    },
    async cancel(sessionId) { listeners.get(sessionId)?.({ kind: "cancelled" }); },
    async dispose(sessionId) { disposedSessions.push(sessionId); },
  };
  const disposedWorkspaces: string[] = [];
  const preparations: Array<{ roomId: string; requestedBy: string; roomEventSeq: number; snapshotId?: string }> = [];
  const workspace: LocalSidecarWorkspacePort = {
    async prepare(input) {
      preparations.push(input);
      const snapshotId = input.snapshotId ?? "latest-snapshot";
      return {
        root: `C:\\snapshots\\${snapshotId}\\workspace`,
        snapshotId,
        dispose: async () => { disposedWorkspaces.push(snapshotId); },
      };
    },
  };
  return {
    disposedSessions,
    disposedWorkspaces,
    emit: (sessionId: string, frame: LocalAgentFrame) => { listeners.get(sessionId)?.(frame); },
    port,
    preparations,
    starts,
    workspace,
  };
}

const contextMessages = [{ eventId: "event-1", author: "Alice", text: "Please review the retry path." }];
const reviewPoint = {
  reviewPointId: "a".repeat(64),
  title: "Retry review",
  focus: "Check idempotency and error handling.",
  workspaceSnapshotId: "b".repeat(64),
  files: [{ path: "src/retry.ts", status: "modified" as const }],
};

describe("Requester-local Review Sidecar", () => {
  it("reviews the fixed Review Point snapshot and produces structured private findings", async () => {
    const runtime = harness();
    const sidecar = new LocalSidecarService(runtime.port, { workspace: runtime.workspace, taskId: () => "task-review", now: () => 100 });

    const started = await sidecar.startReview({
      roomId: "room-1",
      requestedBy: "member-bob",
      localPrompt: "Prioritize correctness.",
      roomEventSeq: 9,
      contextMessages,
      reviewPoint,
    });

    expect(runtime.preparations).toEqual([{ roomId: "room-1", requestedBy: "member-bob", roomEventSeq: 9, snapshotId: reviewPoint.workspaceSnapshotId }]);
    expect(runtime.starts[0]).toMatchObject({
      cwd: `C:\\snapshots\\${reviewPoint.workspaceSnapshotId}\\workspace`,
      readOnlyRoot: `C:\\snapshots\\${reviewPoint.workspaceSnapshotId}\\workspace`,
    });
    expect(runtime.starts[0]?.prompt).toContain("Retry review");
    expect(runtime.starts[0]?.prompt).toContain("src/retry.ts");
    expect(started.task).toMatchObject({
      type: "review",
      context: { workspaceSnapshotId: reviewPoint.workspaceSnapshotId, reviewPointId: reviewPoint.reviewPointId },
      state: { status: "running" },
      publication: { status: "private" },
    });

    runtime.emit("session-1", { kind: "completed", text: JSON.stringify({
      summary: "One retry issue found.",
      findings: [{ severity: "high", location: { kind: "line", path: "src/retry.ts", line: 42 }, body: "The retry can duplicate the write." }],
    }) });

    await vi.waitFor(() => { expect(runtime.disposedWorkspaces).toEqual([reviewPoint.workspaceSnapshotId]); });
    expect(runtime.disposedSessions).toEqual(["session-1"]);
    expect(sidecar.get("room-1")).toMatchObject({
      output: "One retry issue found.",
      findings: [{ severity: "high", location: { kind: "line", path: "src/retry.ts", line: 42 }, body: "The retry can duplicate the write." }],
      task: { state: { status: "completed" }, publication: { status: "private" } },
    });
  });

  it("uses the latest snapshot for explicitly code-aware Explain work", async () => {
    const runtime = harness();
    const sidecar = new LocalSidecarService(runtime.port, { workspace: runtime.workspace, taskId: () => "task-explain-code" });

    const started = await sidecar.startExplain({
      roomId: "room-1",
      requestedBy: "member-bob",
      localPrompt: "Explain the implementation.",
      roomEventSeq: 11,
      contextMessages,
      includeWorkspace: true,
    });

    expect(runtime.preparations).toEqual([{ roomId: "room-1", requestedBy: "member-bob", roomEventSeq: 11 }]);
    expect(started.task.context.workspaceSnapshotId).toBe("latest-snapshot");
    expect(runtime.starts[0]).toMatchObject({ readOnlyRoot: "C:\\snapshots\\latest-snapshot\\workspace" });

    runtime.emit("session-1", { kind: "completed", text: "The implementation uses a stable key." });
    await vi.waitFor(() => { expect(runtime.disposedWorkspaces).toEqual(["latest-snapshot"]); });
  });

  it("fails closed and cleans up when review output is not structured", async () => {
    const runtime = harness();
    const sidecar = new LocalSidecarService(runtime.port, { workspace: runtime.workspace, taskId: () => "task-bad-review" });
    await sidecar.startReview({ roomId: "room-1", requestedBy: "member-bob", localPrompt: "Review", roomEventSeq: 9, contextMessages, reviewPoint });

    runtime.emit("session-1", { kind: "completed", text: "Looks good to me." });

    await vi.waitFor(() => { expect(runtime.disposedWorkspaces).toEqual([reviewPoint.workspaceSnapshotId]); });
    expect(sidecar.get("room-1")).toMatchObject({ task: { state: { status: "failed", error: expect.stringMatching(/structured/i) } } });
  });

  it("restores only terminal private tasks and never persists token-stream state", async () => {
    const runtime = harness();
    const sidecar = new LocalSidecarService(runtime.port, { workspace: runtime.workspace, taskId: () => "task-persisted", now: () => 100 });
    await sidecar.startReview({ roomId: "room-1", requestedBy: "member-bob", localPrompt: "Review", roomEventSeq: 9, contextMessages, reviewPoint });

    expect(sidecar.snapshot()).toEqual({ version: 1, tasks: [] });
    runtime.emit("session-1", { kind: "completed", text: JSON.stringify({ summary: "No issues.", findings: [] }) });
    await vi.waitFor(() => { expect(sidecar.get("room-1")?.task.state.status).toBe("completed"); });
    const persisted = sidecar.snapshot();
    const restored = new LocalSidecarService(runtime.port, { snapshot: persisted });

    expect(restored.get("room-1")).toEqual(persisted.tasks[0] as LocalSideTaskSnapshot);
    expect(restored.snapshot()).toEqual(persisted);
    expect(restored.get("room-1")).not.toBe(persisted.tasks[0]);
  });

  it("never persists transient Participant credentials", async () => {
    const runtime = harness();
    const sidecar = new LocalSidecarService(runtime.port, { workspace: runtime.workspace, taskId: () => "task-private" });
    await sidecar.startReview({
      roomId: "room-1", requestedBy: "member-bob", localPrompt: "Review", roomEventSeq: 9, contextMessages, reviewPoint,
      remote: { gatewayEndpoint: "ws://192.168.1.10:4312/collab", roomToken: "secret-room-token" },
    });
    runtime.emit("session-1", { kind: "completed", text: JSON.stringify({ summary: "No issues.", findings: [] }) });
    await vi.waitFor(() => { expect(sidecar.get("room-1")?.task.state.status).toBe("completed"); });

    const serialized = JSON.stringify(sidecar.snapshot());
    expect(serialized).not.toContain("secret-room-token");
    expect(serialized).not.toContain("192.168.1.10");
  });

  it.each([
    ["unknown severity", { summary: "Bad", findings: [{ severity: "urgent", location: { kind: "general" }, body: "Bad" }] }],
    ["path outside the Review Point", { summary: "Bad", findings: [{ severity: "high", location: { kind: "file", path: "src/other.ts" }, body: "Bad" }] }],
    ["invalid line", { summary: "Bad", findings: [{ severity: "high", location: { kind: "line", path: "src/retry.ts", line: 0 }, body: "Bad" }] }],
    ["empty body", { summary: "Bad", findings: [{ severity: "high", location: { kind: "general" }, body: "" }] }],
  ])("fails closed for structured Review output with %s", async (_case, result) => {
    const runtime = harness();
    const sidecar = new LocalSidecarService(runtime.port, { workspace: runtime.workspace });
    await sidecar.startReview({ roomId: "room-1", requestedBy: "member-bob", localPrompt: "Review", roomEventSeq: 9, contextMessages, reviewPoint });

    runtime.emit("session-1", { kind: "completed", text: JSON.stringify(result) });

    await vi.waitFor(() => { expect(sidecar.get("room-1")?.task.state.status).toBe("failed"); });
  });
});
