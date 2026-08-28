import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DiffBlock, MarkdownText, type DiffHunk } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ReviewFinding, ReviewFindingCreateInput, ReviewLifecycle, ReviewPoint, ReviewPointCreateInput, ReviewPointDiff, ReviewPointProjection, WorkspaceSharingState, WorkspaceSnapshotPackage } from "./collaboration-types.js";
import type { DshCollabSettingsPort } from "./dsh-client.js";
import type { LocalSideTaskSnapshot } from "./local-sidecar.js";
import type { CollabTranslate } from "./locales.js";
import { defaultCollabTranslate } from "./locales.js";
import type { RepositoryChange, RepositoryDiff, RepositoryInspection } from "./repository-inspector.js";
import type { TimelineItem } from "./ui.js";
import css from "./collab-inspector.module.css";

export interface CollabInspectorState {
  status: "idle" | "loading" | "ready" | "error";
  sharing?: WorkspaceSharingState;
  repository?: RepositoryInspection;
  snapshot?: WorkspaceSnapshotPackage;
  diff?: RepositoryDiff;
  reviewPoints?: ReviewPointProjection[];
  reviewNextCursor?: string;
  selectedReviewPointId?: string;
  reviewFindings?: Record<string, ReviewFinding[]>;
  reviewFindingNextCursors?: Record<string, string | undefined>;
  reviewDiffs?: Record<string, Record<string, ReviewPointDiff>>;
  selectedReviewDiffPath?: string;
  sideTask?: LocalSideTaskSnapshot;
  error?: string;
}

export type CollabInspectorTab = "changes" | "reviews" | "tasks";

export function inspectorRoomState(roomId: string, sharing?: WorkspaceSharingState): CollabInspectorState {
  return { status: "idle", ...(sharing?.roomId === roomId ? { sharing } : {}) };
}

export function beginInspectorRefresh(current: CollabInspectorState): CollabInspectorState {
  const { diff: _diff, ...state } = current;
  return { ...state, status: "loading", error: undefined };
}

function replaceSideTask(current: CollabInspectorState, incoming?: LocalSideTaskSnapshot): CollabInspectorState {
  if (incoming) return { ...current, sideTask: incoming, error: undefined };
  const { sideTask: _sideTask, ...rest } = current;
  return { ...rest, error: undefined };
}

export function mergePolledSideTask(current: CollabInspectorState, incoming: LocalSideTaskSnapshot | undefined, expectedTaskId: string): CollabInspectorState {
  if (current.sideTask?.task.taskId !== expectedTaskId) return current;
  if (!incoming || incoming.task.taskId !== expectedTaskId) return replaceSideTask(current, incoming);
  if (current.sideTask?.task.taskId === expectedTaskId && current.sideTask.revision > incoming.revision) return current;
  return replaceSideTask(current, incoming);
}

export function reviewPointFilesFromInspection(inspection: RepositoryInspection): ReviewPointCreateInput["files"] {
  if (inspection.kind !== "repository") return [];
  return inspection.files.map((file) => {
    const staged = file.staged;
    const unstaged = file.unstaged;
    const status = unstaged?.kind === "deleted" || (staged?.kind === "deleted" && !unstaged)
      ? "deleted"
      : staged?.kind === "renamed" || unstaged?.kind === "renamed"
        ? "renamed"
        : staged?.kind === "added"
          ? "added"
          : "modified";
    return {
      path: file.path,
      ...(file.previousPath ? { previousPath: file.previousPath } : {}),
      status,
      additions: (staged?.additions ?? 0) + (unstaged?.additions ?? 0),
      deletions: (staged?.deletions ?? 0) + (unstaged?.deletions ?? 0),
    };
  });
}

export function useCollabInspector(input: {
  roomId: string;
  role: "host" | "participant";
  sharing?: WorkspaceSharingState;
  port?: DshCollabSettingsPort;
  memberId?: string;
  members: readonly { memberId: string; displayName: string }[];
  timeline: readonly TimelineItem[];
}): {
  open: boolean;
  activeTab: CollabInspectorTab;
  state: CollabInspectorState;
  show(): void;
  close(): void;
  refresh(): Promise<void>;
  setSharing(enabled: boolean): Promise<void>;
  loadSnapshot(): Promise<void>;
  loadDiff(path: string, layer: "staged" | "unstaged"): Promise<void>;
  selectTab(tab: CollabInspectorTab): void;
  createReviewPoint(input: Pick<ReviewPointCreateInput, "title" | "focus">): Promise<boolean>;
  reloadReviewPoints(): Promise<void>;
  loadMoreReviewPoints(): Promise<void>;
  refreshReviewPoints(): Promise<void>;
  selectReviewPoint(reviewPointId: string): Promise<void>;
  createReviewFinding(reviewPointId: string, input: ReviewFindingCreateInput): Promise<boolean>;
  loadMoreReviewFindings(reviewPointId: string): Promise<void>;
  setReviewers(reviewPointId: string, reviewerIds: string[]): Promise<void>;
  setReviewLifecycle(reviewPointId: string, lifecycle: ReviewLifecycle): Promise<void>;
  setReviewFindingState(reviewPointId: string, findingId: string, state: "accepted" | "dismissed"): Promise<void>;
  loadReviewPointDiff(reviewPointId: string, fileIndex: number): Promise<void>;
  startLocalExplain(localPrompt: string, selectedEventIds: string[]): Promise<boolean>;
  cancelLocalSideTask(): Promise<void>;
} {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CollabInspectorTab>("changes");
  const [state, setState] = useState<CollabInspectorState>(() => inspectorRoomState(input.roomId, input.sharing));
  const roomIdRef = useRef(input.roomId);
  const sideTaskEpochRef = useRef(0);
  const sideTaskReadSeqRef = useRef(0);
  roomIdRef.current = input.roomId;
  const updateCurrentRoom = (roomId: string, update: (current: CollabInspectorState) => CollabInspectorState): void => {
    if (roomIdRef.current === roomId) setState(update);
  };

  useEffect(() => {
    sideTaskEpochRef.current += 1;
    sideTaskReadSeqRef.current += 1;
    setOpen(false);
    setActiveTab("changes");
    setState(inspectorRoomState(input.roomId, input.sharing));
  }, [input.roomId, input.role]);
  useEffect(() => {
    if (!input.sharing || input.sharing.roomId !== input.roomId) return;
    setState((current) => ({ ...current, sharing: input.sharing }));
  }, [input.roomId, input.sharing]);
  useEffect(() => {
    const task = state.sideTask?.task;
    if (!input.port?.getLocalSideTask || !task || (task.state.status !== "queued" && task.state.status !== "running")) return;
    const roomId = input.roomId;
    const taskId = task.taskId;
    const epoch = sideTaskEpochRef.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async (): Promise<void> => {
      const readSeq = sideTaskReadSeqRef.current + 1;
      sideTaskReadSeqRef.current = readSeq;
      try {
        const sideTask = await input.port!.getLocalSideTask!(roomId);
        if (sideTaskEpochRef.current !== epoch || sideTaskReadSeqRef.current !== readSeq) return;
        if (sideTask) updateCurrentRoom(roomId, (current) => mergePolledSideTask(current, sideTask, taskId));
        else updateCurrentRoom(roomId, (current) => mergePolledSideTask(current, undefined, taskId));
      } catch (cause) {
        if (sideTaskEpochRef.current !== epoch || sideTaskReadSeqRef.current !== readSeq) return;
        updateCurrentRoom(roomId, (current) => current.sideTask?.task.taskId === taskId
          ? { ...current, error: cause instanceof Error ? cause.message : String(cause) }
          : current);
      } finally {
        if (!stopped && sideTaskEpochRef.current === epoch) timer = setTimeout(() => { void poll(); }, 400);
      }
    };
    timer = setTimeout(() => { void poll(); }, 400);
    return () => { stopped = true; if (timer) clearTimeout(timer); };
  }, [input.port, input.roomId, state.sideTask?.task.taskId, state.sideTask?.task.state.status]);

  const refresh = async (): Promise<void> => {
    if (!input.port || input.roomId === "") return;
    const roomId = input.roomId;
    setState(beginInspectorRefresh);
    try {
      const [sharing, repository] = await Promise.all([
        input.port.getWorkspaceSharing?.(input.roomId),
        input.role === "host" ? input.port.inspectRepository?.(input.roomId) : undefined,
      ]);
      updateCurrentRoom(roomId, (current) => ({
        ...current,
        status: "ready",
        ...(sharing ? { sharing } : {}),
        ...(repository ? { repository } : {}),
        error: undefined,
      }));
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const setSharing = async (enabled: boolean): Promise<void> => {
    if (!input.port?.setWorkspaceSharing) return;
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const sharing = await input.port.setWorkspaceSharing(input.roomId, enabled);
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "ready", sharing, error: undefined }));
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const loadSnapshot = async (): Promise<void> => {
    if (!input.port?.requestWorkspaceSnapshot) return;
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const snapshot = await input.port.requestWorkspaceSnapshot(input.roomId);
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "ready", snapshot, error: undefined }));
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const loadDiff = async (path: string, layer: "staged" | "unstaged"): Promise<void> => {
    if (!input.port?.inspectRepositoryDiff) return;
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const diff = await input.port.inspectRepositoryDiff(input.roomId, path, layer);
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "ready", diff, error: undefined }));
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const reloadReviewPoints = async (): Promise<void> => {
    if (!input.port?.listReviewPoints || input.roomId === "") return;
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const page = await input.port.listReviewPoints(roomId);
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "ready", reviewPoints: page.reviewPoints, reviewNextCursor: page.nextCursor, error: undefined }));
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const createReviewPoint = async (review: Pick<ReviewPointCreateInput, "title" | "focus">): Promise<boolean> => {
    if (!input.port?.createReviewPoint || input.roomId === "") return false;
    const files = reviewPointFilesFromInspection(state.repository ?? { kind: "not-git" });
    if (files.length === 0) return false;
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      await input.port.createReviewPoint(roomId, { ...review, files });
      const page = await input.port.listReviewPoints?.(roomId);
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "ready", ...(page ? { reviewPoints: page.reviewPoints, reviewNextCursor: page.nextCursor } : {}), error: undefined }));
      return roomIdRef.current === roomId;
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
      return false;
    }
  };
  const loadMoreReviewPoints = async (): Promise<void> => {
    const cursor = state.reviewNextCursor;
    if (!input.port?.listReviewPoints || input.roomId === "" || !cursor) return;
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const page = await input.port.listReviewPoints(roomId, cursor);
      updateCurrentRoom(roomId, (current) => {
        const points = [...(current.reviewPoints ?? []), ...page.reviewPoints];
        return {
          ...current,
          status: "ready",
          reviewPoints: [...new Map(points.map((point) => [point.reviewPoint.reviewPointId, point])).values()],
          reviewNextCursor: page.nextCursor,
          error: undefined,
        };
      });
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const refreshReviewPoints = async (): Promise<void> => {
    if (!input.port?.refreshReviewPoints || input.roomId === "") return;
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      await input.port.refreshReviewPoints(roomId);
      const page = await input.port.listReviewPoints?.(roomId);
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "ready", ...(page ? { reviewPoints: page.reviewPoints, reviewNextCursor: page.nextCursor } : {}), error: undefined }));
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const selectReviewPoint = async (reviewPointId: string): Promise<void> => {
    if (!input.port?.listReviewFindings || input.roomId === "") return;
    const roomId = input.roomId;
    setState((current) => ({ ...current, selectedReviewPointId: reviewPointId, status: "loading", error: undefined }));
    try {
      const page = await input.port.listReviewFindings(roomId, reviewPointId);
      updateCurrentRoom(roomId, (current) => ({
        ...current,
        status: "ready",
        reviewFindings: { ...current.reviewFindings, [reviewPointId]: page.findings },
        reviewFindingNextCursors: { ...current.reviewFindingNextCursors, [reviewPointId]: page.nextCursor },
        error: undefined,
      }));
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const createReviewFinding = async (reviewPointId: string, finding: ReviewFindingCreateInput): Promise<boolean> => {
    if (!input.port?.createReviewFinding || input.roomId === "") return false;
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      await input.port.createReviewFinding(roomId, reviewPointId, finding);
      const page = await input.port.listReviewFindings?.(roomId, reviewPointId);
      updateCurrentRoom(roomId, (current) => ({
        ...current,
        status: "ready",
        ...(page ? {
          reviewFindings: { ...current.reviewFindings, [reviewPointId]: page.findings },
          reviewFindingNextCursors: { ...current.reviewFindingNextCursors, [reviewPointId]: page.nextCursor },
        } : {}),
        error: undefined,
      }));
      return roomIdRef.current === roomId;
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
      return false;
    }
  };
  const loadMoreReviewFindings = async (reviewPointId: string): Promise<void> => {
    const cursor = state.reviewFindingNextCursors?.[reviewPointId];
    if (!input.port?.listReviewFindings || input.roomId === "" || !cursor) return;
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const page = await input.port.listReviewFindings(roomId, reviewPointId, cursor);
      updateCurrentRoom(roomId, (current) => {
        const findings = [...(current.reviewFindings?.[reviewPointId] ?? []), ...page.findings];
        return {
          ...current,
          status: "ready",
          reviewFindings: { ...current.reviewFindings, [reviewPointId]: [...new Map(findings.map((finding) => [finding.findingId, finding])).values()] },
          reviewFindingNextCursors: { ...current.reviewFindingNextCursors, [reviewPointId]: page.nextCursor },
          error: undefined,
        };
      });
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const updateReviewPoint = async (reviewPointId: string, update: () => Promise<ReviewPoint>): Promise<void> => {
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const reviewPoint = await update();
      updateCurrentRoom(roomId, (current) => ({
        ...current,
        status: "ready",
        reviewPoints: current.reviewPoints?.map((projection) => projection.reviewPoint.reviewPointId === reviewPointId ? { ...projection, reviewPoint } : projection),
        error: undefined,
      }));
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const setReviewFindingState = async (reviewPointId: string, findingId: string, findingState: "accepted" | "dismissed"): Promise<void> => {
    if (!input.port?.setReviewFindingState || input.roomId === "") return;
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const finding = await input.port.setReviewFindingState(roomId, reviewPointId, findingId, findingState);
      updateCurrentRoom(roomId, (current) => ({
        ...current,
        status: "ready",
        reviewFindings: {
          ...current.reviewFindings,
          [reviewPointId]: (current.reviewFindings?.[reviewPointId] ?? []).map((item) => item.findingId === findingId ? finding : item),
        },
        error: undefined,
      }));
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const loadReviewPointDiff = async (reviewPointId: string, fileIndex: number): Promise<void> => {
    if (!input.port?.loadReviewPointDiff || input.roomId === "") return;
    const roomId = input.roomId;
    const expectedPath = state.reviewPoints?.find((projection) => projection.reviewPoint.reviewPointId === reviewPointId)?.reviewPoint.files[fileIndex]?.path;
    if (!expectedPath) return;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const diff = await input.port.loadReviewPointDiff(roomId, reviewPointId, fileIndex);
      if (diff.path !== expectedPath) throw new Error("Review Point diff path does not match the selected file");
      updateCurrentRoom(roomId, (current) => ({
        ...current,
        status: "ready",
        selectedReviewDiffPath: diff.path,
        reviewDiffs: { ...current.reviewDiffs, [reviewPointId]: { ...current.reviewDiffs?.[reviewPointId], [diff.path]: diff } },
        error: undefined,
      }));
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
    }
  };
  const loadLocalSideTask = async (): Promise<void> => {
    if (!input.port?.getLocalSideTask || input.roomId === "") return;
    const roomId = input.roomId;
    const epoch = sideTaskEpochRef.current;
    const readSeq = sideTaskReadSeqRef.current + 1;
    sideTaskReadSeqRef.current = readSeq;
    try {
      const sideTask = await input.port.getLocalSideTask(roomId);
      if (sideTaskEpochRef.current === epoch && sideTaskReadSeqRef.current === readSeq) {
        updateCurrentRoom(roomId, (current) => current.sideTask
          ? mergePolledSideTask(current, sideTask, current.sideTask.task.taskId)
          : replaceSideTask(current, sideTask));
      }
    } catch (cause) {
      if (sideTaskEpochRef.current === epoch && sideTaskReadSeqRef.current === readSeq) {
        updateCurrentRoom(roomId, (current) => ({ ...current, error: cause instanceof Error ? cause.message : String(cause) }));
      }
    }
  };
  const startLocalExplain = async (localPrompt: string, selectedEventIds: string[]): Promise<boolean> => {
    if (!input.port?.startLocalExplain || !input.memberId || input.roomId === "") return false;
    const selected = new Set(selectedEventIds);
    const memberNames = new Map(input.members.map((member) => [member.memberId, member.displayName]));
    const stableTimeline = input.timeline.filter((item) => item.contextEventId && !item.streaming && !item.eventId.startsWith("stream:"));
    const contextMessages = stableTimeline.flatMap((item) => item.contextEventId && selected.has(item.contextEventId) && item.text?.trim()
      ? [{ eventId: item.contextEventId, author: item.kind === "agent" ? "@agent" : memberNames.get(item.authorMemberId) ?? item.authorMemberId, text: item.text }]
      : []);
    const roomId = input.roomId;
    const epoch = sideTaskEpochRef.current + 1;
    sideTaskEpochRef.current = epoch;
    sideTaskReadSeqRef.current += 1;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const sideTask = await input.port.startLocalExplain({
        roomId,
        requestedBy: input.memberId,
        localPrompt,
        roomEventSeq: stableTimeline.reduce((seq, item) => Math.max(seq, item.seq), 0),
        contextMessages,
      });
      if (sideTaskEpochRef.current === epoch) updateCurrentRoom(roomId, (current) => ({ ...current, status: "ready", sideTask, error: undefined }));
      return roomIdRef.current === roomId && sideTaskEpochRef.current === epoch;
    } catch (cause) {
      if (sideTaskEpochRef.current === epoch) updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
      return false;
    }
  };
  const cancelLocalSideTask = async (): Promise<void> => {
    const task = state.sideTask?.task;
    if (!input.port?.cancelLocalSideTask || !task) return;
    const roomId = input.roomId;
    const readSeq = sideTaskReadSeqRef.current + 1;
    sideTaskReadSeqRef.current = readSeq;
    try {
      const sideTask = await input.port.cancelLocalSideTask(roomId, task.taskId);
      if (sideTaskReadSeqRef.current === readSeq) updateCurrentRoom(roomId, (current) => mergePolledSideTask(current, sideTask, task.taskId));
    } catch (cause) {
      if (sideTaskReadSeqRef.current === readSeq) {
        updateCurrentRoom(roomId, (current) => current.sideTask?.task.taskId === task.taskId
          ? { ...current, error: cause instanceof Error ? cause.message : String(cause) }
          : current);
      }
    }
  };
  return {
    open,
    activeTab,
    state,
    show: () => { setOpen(true); void refresh(); },
    close: () => { setOpen(false); },
    refresh,
    setSharing,
    loadSnapshot,
    loadDiff,
    selectTab: (tab) => { setActiveTab(tab); if (tab === "reviews") void reloadReviewPoints(); else if (tab === "tasks") void loadLocalSideTask(); },
    createReviewPoint,
    reloadReviewPoints,
    loadMoreReviewPoints,
    refreshReviewPoints,
    selectReviewPoint,
    createReviewFinding,
    loadMoreReviewFindings,
    setReviewers: async (reviewPointId, reviewerIds) => {
      if (!input.port?.setReviewers || input.roomId === "") return;
      await updateReviewPoint(reviewPointId, () => input.port!.setReviewers!(input.roomId, reviewPointId, reviewerIds));
    },
    setReviewLifecycle: async (reviewPointId, lifecycle) => {
      if (!input.port?.setReviewLifecycle || input.roomId === "") return;
      await updateReviewPoint(reviewPointId, () => input.port!.setReviewLifecycle!(input.roomId, reviewPointId, lifecycle));
    },
    setReviewFindingState,
    loadReviewPointDiff,
    startLocalExplain,
    cancelLocalSideTask,
  };
}

function lineCount(change: RepositoryChange | undefined): { additions: number; deletions: number } {
  return { additions: change?.additions ?? 0, deletions: change?.deletions ?? 0 };
}

function bytes(value: number): string {
  if (value < 1024) return `${String(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function parseUnifiedPatch(diff: RepositoryDiff): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let removed: string[] | undefined;
  let added: string[] | undefined;
  const flush = (): void => {
    if (!removed || !added || (removed.length === 0 && added.length === 0)) return;
    hunks.push({ path: diff.path, oldText: removed.length === 0 ? null : `${removed.join("\n")}\n`, newText: added.length === 0 ? "" : `${added.join("\n")}\n` });
  };
  for (const line of diff.patch.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      flush();
      removed = [];
      added = [];
    } else if (removed && added && line.startsWith("-") && !line.startsWith("---")) {
      removed.push(line.slice(1));
    } else if (removed && added && line.startsWith("+") && !line.startsWith("+++")) {
      added.push(line.slice(1));
    }
  }
  flush();
  return hunks;
}

function RepositoryChanges(props: { inspection: RepositoryInspection; diff?: RepositoryDiff; onLoadDiff(path: string, layer: "staged" | "unstaged"): void; t: CollabTranslate }): ReactNode {
  const { inspection, t } = props;
  if (inspection.kind === "not-git") return <div className={css.empty}><strong>{t("inspector.notGit")}</strong><p>{t("inspector.notGitHint")}</p></div>;
  if (inspection.files.length === 0) return <div className={css.empty}><strong>{t("inspector.clean")}</strong><p>{t("inspector.cleanHint")}</p></div>;
  const diffHunks = props.diff ? parseUnifiedPatch(props.diff) : [];
  return <>
    <div className={css.summary} aria-label={t("inspector.changeSummary")}>
      <strong>{t("inspector.files", { count: inspection.files.length })}</strong>
      <span className={css.additions}>+{inspection.summary.additions}</span>
      <span className={css.deletions}>-{inspection.summary.deletions}</span>
    </div>
    <ul className={css.fileList}>{inspection.files.map((file) => {
      const staged = lineCount(file.staged);
      const unstaged = lineCount(file.unstaged);
      return <li key={file.path} className={css.file}>
        <div className={css.filePath}><strong>{file.path}</strong>{file.previousPath ? <small>{t("inspector.renamedFrom", { path: file.previousPath })}</small> : null}</div>
        <div className={css.fileChanges}>
          {file.staged ? <button type="button" onClick={() => { props.onLoadDiff(file.path, "staged"); }}><b>{t("inspector.staged")}</b> <i className={css.additions}>+{staged.additions}</i> <i className={css.deletions}>-{staged.deletions}</i></button> : null}
          {file.unstaged ? <button type="button" onClick={() => { props.onLoadDiff(file.path, "unstaged"); }}><b>{t("inspector.unstaged")}</b> <i className={css.additions}>+{unstaged.additions}</i> <i className={css.deletions}>-{unstaged.deletions}</i></button> : null}
        </div>
      </li>;
    })}</ul>
    {props.diff ? <section className={css.diff} aria-label={t("inspector.diffFor", { path: props.diff.path })}>
      <div className={css.diffHeading}><strong>{props.diff.path}</strong><span>{t(props.diff.layer === "staged" ? "inspector.staged" : "inspector.unstaged")}</span></div>
      {diffHunks.length > 0 ? <DiffBlock diffs={diffHunks} maxLines={24} /> : <p className={css.emptyText}>{t("inspector.diffUnavailable")}</p>}
    </section> : null}
  </>;
}

function SnapshotFiles({ snapshot, t }: { snapshot: WorkspaceSnapshotPackage; t: CollabTranslate }): ReactNode {
  const total = snapshot.files.reduce((sum, file) => sum + file.size, 0);
  return <section className={css.snapshot} aria-labelledby="collab-snapshot-title">
    <div className={css.snapshotHeading}><div><strong id="collab-snapshot-title">{t("inspector.immutableSnapshot")}</strong><small>{t("inspector.snapshotAt", { sequence: snapshot.roomEventSeq })}</small></div><span>{bytes(total)}</span></div>
    {snapshot.files.length === 0 ? <p className={css.emptyText}>{t("inspector.snapshotEmpty")}</p> : <ul className={css.snapshotFiles}>{snapshot.files.map((file) => <li key={file.path}><span>{file.path}</span><small>{bytes(file.size)}</small></li>)}</ul>}
  </section>;
}

function ReviewPoints(props: { points: readonly ReviewPointProjection[]; selectedId?: string; onSelect(reviewPointId: string): void; t: CollabTranslate }): ReactNode {
  if (props.points.length === 0) return <div className={css.empty}><strong>{props.t("inspector.noReviews")}</strong><p>{props.t("inspector.noReviewsHint")}</p></div>;
  return <ul className={css.reviewList}>{props.points.map(({ reviewPoint, freshness, progress }) => <li key={reviewPoint.reviewPointId} className={css.reviewCard} data-selected={props.selectedId === reviewPoint.reviewPointId}>
    <div className={css.reviewHeading}><div><strong>{reviewPoint.title}</strong>{reviewPoint.focus ? <p>{reviewPoint.focus}</p> : null}</div><span>{props.t(`inspector.lifecycle.${reviewPoint.lifecycle}`)}</span></div>
    <div className={css.reviewStatus}>
      <span data-freshness={freshness}>{props.t(`inspector.freshness.${freshness}`)}</span>
      <span>{props.t("inspector.reviewFiles", { count: reviewPoint.files.length })}</span>
    </div>
    <div className={css.reviewProgress} aria-label={props.t("inspector.progress")}>
      <span>{props.t("inspector.roomEventDelta", { count: progress.roomEventDelta })}</span>
      <span>{props.t("inspector.workspaceChangedFiles", { count: progress.workspaceChangedFileCount })}</span>
    </div>
    <ul className={css.reviewFiles}>{reviewPoint.files.map((file) => <li key={file.path}><span>{file.path}</span><small><i className={css.additions}>+{file.additions}</i> <i className={css.deletions}>-{file.deletions}</i></small></li>)}</ul>
    <button type="button" className={css.secondaryAction} onClick={() => { props.onSelect(reviewPoint.reviewPointId); }}>{props.t(props.selectedId === reviewPoint.reviewPointId ? "inspector.reviewSelected" : "inspector.openReview")}</button>
  </li>)}</ul>;
}

function findingLocation(finding: ReviewFinding, t: CollabTranslate): string {
  if (finding.location.kind === "general") return t("inspector.findingGeneral");
  if (finding.location.kind === "file") return finding.location.path;
  return `${finding.location.path}:${String(finding.location.line)}`;
}

function lifecycleActions(lifecycle: ReviewLifecycle): Array<Exclude<ReviewLifecycle, "open">> {
  if (lifecycle === "open") return ["changes-requested", "approved", "closed"];
  if (lifecycle === "changes-requested") return ["approved", "closed"];
  if (lifecycle === "approved") return ["closed"];
  return [];
}

function ReviewDetail(props: {
  role: "host" | "participant";
  projection: ReviewPointProjection;
  findings: readonly ReviewFinding[];
  selectedDiffPath?: string;
  diffs: Readonly<Record<string, ReviewPointDiff>>;
  findingNextCursor?: string;
  members: readonly { memberId: string; displayName: string }[];
  busy: boolean;
  onCreateFinding(input: ReviewFindingCreateInput): Promise<boolean>;
  onLoadDiff(fileIndex: number): void;
  onLoadMoreFindings(): void;
  onSetReviewers(reviewerIds: string[]): void;
  onSetLifecycle(lifecycle: ReviewLifecycle): void;
  onSetFindingState(findingId: string, state: "accepted" | "dismissed"): void;
  t: CollabTranslate;
}): ReactNode {
  const { reviewPoint } = props.projection;
  const [severity, setSeverity] = useState<ReviewFinding["severity"]>("medium");
  const [path, setPath] = useState("");
  const [line, setLine] = useState("");
  const [body, setBody] = useState("");
  useEffect(() => { setSeverity("medium"); setPath(""); setLine(""); setBody(""); }, [reviewPoint.reviewPointId]);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const normalizedBody = body.trim();
    if (normalizedBody === "") return;
    const parsedLine = line === "" ? undefined : Number(line);
    const location: ReviewFindingCreateInput["location"] = path === ""
      ? { kind: "general" }
      : parsedLine === undefined
        ? { kind: "file", path }
        : { kind: "line", path, line: parsedLine };
    if (location.kind === "line" && (!Number.isSafeInteger(location.line) || location.line < 1)) return;
    if (await props.onCreateFinding({ severity, location, body: normalizedBody })) setBody("");
  };
  const memberNames = new Map(props.members.map((member) => [member.memberId, member.displayName]));
  const selectedDiff = props.selectedDiffPath ? props.diffs[props.selectedDiffPath] : undefined;
  return <section className={css.reviewDetail} aria-labelledby="collab-review-detail-title">
    <div className={css.detailHeading}><div><h4 id="collab-review-detail-title">{reviewPoint.title}</h4><p>{props.t("inspector.reviewDetailHint")}</p></div><span>{props.t(`inspector.lifecycle.${reviewPoint.lifecycle}`)}</span></div>
    <div className={css.historicalDiffs}>
      <strong>{props.t("inspector.historicalDiff")}</strong>
      <div className={css.diffFiles}>{reviewPoint.files.map((file, index) => <button key={file.path} type="button" data-selected={props.selectedDiffPath === file.path} disabled={props.busy} onClick={() => { props.onLoadDiff(index); }}>{file.path}</button>)}</div>
      {selectedDiff?.kind === "text" ? <DiffBlock diffs={[{ path: selectedDiff.path, oldText: selectedDiff.oldText, newText: selectedDiff.newText ?? "" }]} maxLines={120} />
        : selectedDiff?.kind === "binary" ? <p className={css.emptyText}>{props.t("inspector.binaryDiff")}</p>
          : selectedDiff?.kind === "unavailable" ? <p className={css.emptyText}>{props.t("inspector.legacyDiffUnavailable")}</p>
            : <p className={css.emptyText}>{props.t("inspector.selectDiff")}</p>}
    </div>
    {props.role === "host" ? <>
      <fieldset className={css.reviewers}>
        <legend>{props.t("inspector.reviewers")}</legend>
        {props.members.map((member) => <label key={member.memberId}><input type="checkbox" checked={reviewPoint.reviewerIds.includes(member.memberId)} disabled={props.busy} onChange={(event) => {
          const reviewerIds = event.target.checked
            ? [...reviewPoint.reviewerIds, member.memberId]
            : reviewPoint.reviewerIds.filter((id) => id !== member.memberId);
          props.onSetReviewers(reviewerIds);
        }} />{member.displayName}</label>)}
      </fieldset>
      {lifecycleActions(reviewPoint.lifecycle).length > 0 ? <div className={css.lifecycleActions} aria-label={props.t("inspector.lifecycleActions")}>
        {lifecycleActions(reviewPoint.lifecycle).map((lifecycle) => <button key={lifecycle} type="button" className={css.secondaryAction} disabled={props.busy} onClick={() => { props.onSetLifecycle(lifecycle); }}>{props.t(`inspector.lifecycleAction.${lifecycle}`)}</button>)}
      </div> : null}
    </> : null}
    <form className={css.findingForm} onSubmit={(event) => { void submit(event); }}>
      <strong>{props.t("inspector.addFinding")}</strong>
      <div className={css.findingFields}>
        <label>{props.t("inspector.findingSeverity")}<select value={severity} onChange={(event) => { setSeverity(event.target.value as ReviewFinding["severity"]); }}>
          {(["critical", "high", "medium", "low", "note"] as const).map((value) => <option key={value} value={value}>{props.t(`inspector.severity.${value}`)}</option>)}
        </select></label>
        <label>{props.t("inspector.findingFile")}<select value={path} onChange={(event) => { setPath(event.target.value); setLine(""); }}><option value="">{props.t("inspector.findingGeneral")}</option>{reviewPoint.files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}</select></label>
        <label>{props.t("inspector.findingLine")}<input type="number" min={1} step={1} value={line} disabled={path === ""} onChange={(event) => { setLine(event.target.value); }} /></label>
      </div>
      <label>{props.t("inspector.findingBody")}<textarea rows={3} maxLength={4_000} value={body} onChange={(event) => { setBody(event.target.value); }} /></label>
      <button type="submit" className={css.primaryAction} disabled={props.busy || body.trim() === ""}>{props.t("inspector.publishFinding")}</button>
    </form>
    {props.findings.length === 0 ? <p className={css.emptyText}>{props.t("inspector.noFindings")}</p> : <ul className={css.findingList}>{props.findings.map((finding) => <li key={finding.findingId} className={css.findingCard} data-severity={finding.severity}>
      <div className={css.findingMeta}><span>{props.t(`inspector.severity.${finding.severity}`)}</span><span>{findingLocation(finding, props.t)}</span><span>{memberNames.get(finding.authorId) ?? finding.authorId}</span></div>
      <p>{finding.body}</p>
      <div className={css.findingDecision}><span>{props.t(`inspector.findingState.${finding.state}`)}</span>{props.role === "host" && finding.state === "open" ? <div><button type="button" disabled={props.busy} onClick={() => { props.onSetFindingState(finding.findingId, "accepted"); }}>{props.t("inspector.acceptFinding")}</button><button type="button" disabled={props.busy} onClick={() => { props.onSetFindingState(finding.findingId, "dismissed"); }}>{props.t("inspector.dismissFinding")}</button></div> : null}</div>
    </li>)}</ul>}
    {props.findingNextCursor ? <button type="button" className={css.secondaryAction} disabled={props.busy} onClick={props.onLoadMoreFindings}>{props.t("inspector.loadOlderFindings")}</button> : null}
  </section>;
}

function PrivateSideWork(props: {
  sideTask?: LocalSideTaskSnapshot;
  timeline: readonly TimelineItem[];
  busy: boolean;
  onStart(localPrompt: string, selectedEventIds: string[]): Promise<boolean>;
  onCancel(): void;
  t: CollabTranslate;
}): ReactNode {
  const [prompt, setPrompt] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const messages = props.timeline.filter((item) => item.contextEventId && item.text?.trim() && !item.streaming && !item.eventId.startsWith("stream:"));
  const running = props.sideTask?.task.state.status === "queued" || props.sideTask?.task.state.status === "running";
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const localPrompt = prompt.trim();
    if (localPrompt === "" || selected.length === 0) return;
    if (await props.onStart(localPrompt, selected)) setPrompt("");
  };
  return <section className={css.sideWork} aria-labelledby="collab-side-work-title">
    <div className={css.sideWorkHeading}>
      <div><h3 id="collab-side-work-title">{props.t("inspector.sideWork")}</h3><p>{props.t("inspector.sideWorkHint")}</p></div>
      <span>{props.t("inspector.privateLocal")}</span>
    </div>
    <fieldset className={css.contextPicker} disabled={props.busy || running}>
      <legend>{props.t("inspector.explainContext")}</legend>
      <p>{props.t("inspector.explainContextHint")}</p>
      {messages.length === 0 ? <p className={css.emptyText}>{props.t("inspector.noExplainContext")}</p> : messages.map((item) => <label key={item.eventId}>
        <input type="checkbox" checked={selected.includes(item.contextEventId!)} onChange={(event) => {
          setSelected(event.target.checked ? [...selected, item.contextEventId!] : selected.filter((eventId) => eventId !== item.contextEventId));
        }} />
        <span>{item.text}</span>
      </label>)}
    </fieldset>
    <form className={css.sideTaskForm} onSubmit={(event) => { void submit(event); }}>
      <label>{props.t("inspector.localPrompt")}<textarea rows={4} maxLength={16_000} value={prompt} disabled={props.busy || running} onChange={(event) => { setPrompt(event.target.value); }} placeholder={props.t("inspector.localPromptPlaceholder")} /></label>
      <button type="submit" className={css.primaryAction} disabled={props.busy || running || prompt.trim() === "" || selected.length === 0}>{props.t("inspector.startExplain")}</button>
    </form>
    {props.sideTask ? <section className={css.sideTaskResult} aria-live="polite">
      <div className={css.sideTaskStatus}>
        <strong>{props.t("inspector.explainResult")}</strong>
        <span>{props.t(`inspector.taskState.${props.sideTask.task.state.status}`)}</span>
      </div>
      {props.sideTask.output ? <MarkdownText text={props.sideTask.output} streaming={running} /> : <p className={css.emptyText}>{props.t(running ? "inspector.waitingForExplain" : "inspector.noExplainOutput")}</p>}
      {props.sideTask.task.state.status === "failed" ? <p className={css.error}>{props.sideTask.task.state.error}</p> : null}
      {running ? <button type="button" className={css.secondaryAction} onClick={props.onCancel}>{props.t("inspector.cancelSideTask")}</button> : null}
    </section> : null}
  </section>;
}

export function DshCollabInspector(props: {
  open: boolean;
  roomId: string;
  role: "host" | "participant";
  state: CollabInspectorState;
  onClose(): void;
  onRefresh(): void;
  onSetSharing(enabled: boolean): void;
  onLoadSnapshot(): void;
  onLoadDiff(path: string, layer: "staged" | "unstaged"): void;
  activeTab: CollabInspectorTab;
  onSelectTab(tab: CollabInspectorTab): void;
  onCreateReviewPoint(input: Pick<ReviewPointCreateInput, "title" | "focus">): Promise<boolean>;
  onReloadReviewPoints(): void;
  onLoadMoreReviewPoints(): void;
  onRefreshReviewPoints(): void;
  members: readonly { memberId: string; displayName: string }[];
  onSelectReviewPoint(reviewPointId: string): void;
  onCreateReviewFinding(reviewPointId: string, input: ReviewFindingCreateInput): Promise<boolean>;
  onLoadMoreReviewFindings?(reviewPointId: string): void;
  onSetReviewers(reviewPointId: string, reviewerIds: string[]): void;
  onSetReviewLifecycle(reviewPointId: string, lifecycle: ReviewLifecycle): void;
  onSetReviewFindingState(reviewPointId: string, findingId: string, state: "accepted" | "dismissed"): void;
  onLoadReviewPointDiff(reviewPointId: string, fileIndex: number): void;
  timeline: readonly TimelineItem[];
  onStartLocalExplain(localPrompt: string, selectedEventIds: string[]): Promise<boolean>;
  onCancelLocalSideTask(): void;
  t?: CollabTranslate;
}): ReactNode {
  const [reviewTitle, setReviewTitle] = useState("");
  const [reviewFocus, setReviewFocus] = useState("");
  useEffect(() => { setReviewTitle(""); setReviewFocus(""); }, [props.roomId]);
  if (!props.open) return null;
  const t = props.t ?? defaultCollabTranslate;
  const busy = props.state.status === "loading";
  const enabled = props.state.sharing?.enabled === true;
  const reviewFiles = reviewPointFilesFromInspection(props.state.repository ?? { kind: "not-git" });
  const createReview = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (reviewTitle.trim() === "" || reviewFiles.length === 0) return;
    const created = await props.onCreateReviewPoint({ title: reviewTitle.trim(), ...(reviewFocus.trim() ? { focus: reviewFocus.trim() } : {}) });
    if (!created) return;
    setReviewTitle("");
    setReviewFocus("");
  };
  return <aside className={css.inspector} data-collab-inspector={props.activeTab} aria-labelledby="collab-inspector-title">
    <header className={css.header}>
      <div><h2 id="collab-inspector-title">{t("inspector.title")}</h2><p>{t("inspector.description")}</p></div>
      <button type="button" className={css.close} aria-label={t("inspector.close")} onClick={props.onClose}>×</button>
    </header>
    <div className={css.tabs} role="tablist" aria-label={t("inspector.title")}>
      {(["changes", "reviews", "tasks"] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={props.activeTab === tab} onClick={() => { props.onSelectTab(tab); }}>{t(`inspector.${tab}`)}</button>)}
    </div>
    <div className={css.body}>
      {props.state.error ? <p className={css.error} role="alert">{props.state.error}</p> : null}
      {props.activeTab === "changes" ? <>
      <section className={css.sharing} aria-labelledby="collab-workspace-sharing-title">
        <div><h3 id="collab-workspace-sharing-title">{t("inspector.workspaceSharing")}</h3><p>{t(props.role === "host" ? "inspector.hostSharingHint" : "inspector.participantSharingHint")}</p></div>
        {props.role === "host" ? <button type="button" className={css.switch} role="switch" aria-checked={enabled} disabled={busy} onClick={() => { props.onSetSharing(!enabled); }}><span /></button> : <span className={enabled ? css.shared : css.notShared}>{t(props.state.sharing === undefined ? "inspector.loading" : enabled ? "inspector.shared" : "inspector.notShared")}</span>}
      </section>

      {props.role === "host" ? <section className={css.changes} aria-labelledby="collab-current-changes-title">
        <div className={css.sectionHeading}><div><h3 id="collab-current-changes-title">{t("inspector.currentChanges")}</h3><p>{t("inspector.currentChangesHint")}</p></div><button type="button" className={css.action} disabled={busy} onClick={props.onRefresh}>{t(busy ? "inspector.loading" : "inspector.refresh")}</button></div>
        {props.state.repository ? <RepositoryChanges inspection={props.state.repository} diff={props.state.diff} onLoadDiff={props.onLoadDiff} t={t} /> : <p className={css.emptyText}>{t(busy ? "inspector.loading" : "inspector.openToLoad")}</p>}
      </section> : props.state.sharing === undefined ? <div className={css.disabled} role="status"><strong>{t("inspector.checkingAccess")}</strong><p>{t("inspector.checkingAccessHint")}</p></div> : !enabled ? <div className={css.disabled}><strong>{t("inspector.notSharedTitle")}</strong><p>{t("inspector.notSharedDescription")}</p></div> : <section className={css.participantSnapshot}>
        <div><strong>{t("inspector.snapshotAccess")}</strong><p>{t("inspector.snapshotAccessHint")}</p></div>
        <button type="button" className={css.primaryAction} disabled={busy} onClick={props.onLoadSnapshot}>{t(busy ? "inspector.loading" : "inspector.loadSnapshot")}</button>
        {props.state.snapshot ? <SnapshotFiles snapshot={props.state.snapshot} t={t} /> : null}
      </section>}
      </> : props.activeTab === "reviews" ? <section className={css.reviews} aria-labelledby="collab-review-points-title">
        <div className={css.sectionHeading}><div><h3 id="collab-review-points-title">{t("inspector.reviewPoints")}</h3><p>{t("inspector.reviewPointsHint")}</p></div><button type="button" className={css.action} disabled={busy} onClick={props.onReloadReviewPoints}>{t(busy ? "inspector.loading" : "inspector.reloadReviews")}</button></div>
        {props.role === "host" ? <>
          <form className={css.reviewForm} onSubmit={(event) => { void createReview(event); }}>
            <label>{t("inspector.reviewTitle")}<input value={reviewTitle} maxLength={120} onChange={(event) => { setReviewTitle(event.target.value); }} /></label>
            <label>{t("inspector.reviewFocus")}<textarea value={reviewFocus} maxLength={2_000} rows={2} onChange={(event) => { setReviewFocus(event.target.value); }} /></label>
            <div className={css.reviewActions}><span>{t("inspector.reviewSelection", { count: reviewFiles.length })}</span><button type="submit" className={css.primaryAction} disabled={busy || !enabled || reviewTitle.trim() === "" || reviewFiles.length === 0}>{t("inspector.createReview")}</button></div>
          </form>
          <button type="button" className={css.secondaryAction} disabled={busy || !enabled || !props.state.reviewPoints?.length} onClick={props.onRefreshReviewPoints}>{t("inspector.refreshComparison")}</button>
          {!enabled ? <p className={css.reviewHint}>{t("inspector.reviewSharingRequired")}</p> : null}
        </> : null}
        <ReviewPoints points={props.state.reviewPoints ?? []} selectedId={props.state.selectedReviewPointId} onSelect={props.onSelectReviewPoint} t={t} />
        {props.state.reviewNextCursor ? <button type="button" className={css.secondaryAction} disabled={busy} onClick={props.onLoadMoreReviewPoints}>{t("inspector.loadOlderReviews")}</button> : null}
        {props.state.selectedReviewPointId ? (() => {
          const projection = props.state.reviewPoints?.find(({ reviewPoint }) => reviewPoint.reviewPointId === props.state.selectedReviewPointId);
          if (!projection) return null;
          const reviewPointId = projection.reviewPoint.reviewPointId;
          return <ReviewDetail
            role={props.role}
            projection={projection}
            findings={props.state.reviewFindings?.[reviewPointId] ?? []}
            selectedDiffPath={props.state.selectedReviewDiffPath}
            diffs={props.state.reviewDiffs?.[reviewPointId] ?? {}}
            findingNextCursor={props.state.reviewFindingNextCursors?.[reviewPointId]}
            members={props.members}
            busy={busy}
            onCreateFinding={(input) => props.onCreateReviewFinding(reviewPointId, input)}
            onLoadDiff={(fileIndex) => { props.onLoadReviewPointDiff(reviewPointId, fileIndex); }}
            onLoadMoreFindings={() => { props.onLoadMoreReviewFindings?.(reviewPointId); }}
            onSetReviewers={(reviewerIds) => { props.onSetReviewers(reviewPointId, reviewerIds); }}
            onSetLifecycle={(lifecycle) => { props.onSetReviewLifecycle(reviewPointId, lifecycle); }}
            onSetFindingState={(findingId, state) => { props.onSetReviewFindingState(reviewPointId, findingId, state); }}
            t={t}
          />;
        })() : null}
      </section> : <PrivateSideWork key={props.roomId} sideTask={props.state.sideTask} timeline={props.timeline} busy={busy} onStart={props.onStartLocalExplain} onCancel={props.onCancelLocalSideTask} t={t} />}
    </div>
  </aside>;
}
