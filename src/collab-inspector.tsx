import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { DiffBlock, type DiffHunk } from "@deepseek-ai/dsh-client-ui-primitives";
import type { ReviewPointCreateInput, ReviewPointProjection, WorkspaceSharingState, WorkspaceSnapshotPackage } from "./collaboration-types.js";
import type { DshCollabSettingsPort } from "./dsh-client.js";
import type { CollabTranslate } from "./locales.js";
import { defaultCollabTranslate } from "./locales.js";
import type { RepositoryChange, RepositoryDiff, RepositoryInspection } from "./repository-inspector.js";
import css from "./collab-inspector.module.css";

export interface CollabInspectorState {
  status: "idle" | "loading" | "ready" | "error";
  sharing?: WorkspaceSharingState;
  repository?: RepositoryInspection;
  snapshot?: WorkspaceSnapshotPackage;
  diff?: RepositoryDiff;
  reviewPoints?: ReviewPointProjection[];
  error?: string;
}

export type CollabInspectorTab = "changes" | "reviews";

export function inspectorRoomState(roomId: string, sharing?: WorkspaceSharingState): CollabInspectorState {
  return { status: "idle", ...(sharing?.roomId === roomId ? { sharing } : {}) };
}

export function beginInspectorRefresh(current: CollabInspectorState): CollabInspectorState {
  const { diff: _diff, ...state } = current;
  return { ...state, status: "loading", error: undefined };
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
  refreshReviewPoints(): Promise<void>;
} {
  const [open, setOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<CollabInspectorTab>("changes");
  const [state, setState] = useState<CollabInspectorState>(() => inspectorRoomState(input.roomId, input.sharing));
  const roomIdRef = useRef(input.roomId);
  roomIdRef.current = input.roomId;
  const updateCurrentRoom = (roomId: string, update: (current: CollabInspectorState) => CollabInspectorState): void => {
    if (roomIdRef.current === roomId) setState(update);
  };

  useEffect(() => {
    setOpen(false);
    setActiveTab("changes");
    setState(inspectorRoomState(input.roomId, input.sharing));
  }, [input.roomId, input.role]);
  useEffect(() => {
    if (!input.sharing || input.sharing.roomId !== input.roomId) return;
    setState((current) => ({ ...current, sharing: input.sharing }));
  }, [input.roomId, input.sharing]);

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
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "ready", reviewPoints: page.reviewPoints, error: undefined }));
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
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "ready", ...(page ? { reviewPoints: page.reviewPoints } : {}), error: undefined }));
      return true;
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
      return false;
    }
  };
  const refreshReviewPoints = async (): Promise<void> => {
    if (!input.port?.refreshReviewPoints || input.roomId === "") return;
    const roomId = input.roomId;
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      await input.port.refreshReviewPoints(roomId);
      const page = await input.port.listReviewPoints?.(roomId);
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "ready", ...(page ? { reviewPoints: page.reviewPoints } : {}), error: undefined }));
    } catch (cause) {
      updateCurrentRoom(roomId, (current) => ({ ...current, status: "error", error: cause instanceof Error ? cause.message : String(cause) }));
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
    selectTab: (tab) => { setActiveTab(tab); if (tab === "reviews") void reloadReviewPoints(); },
    createReviewPoint,
    reloadReviewPoints,
    refreshReviewPoints,
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

function ReviewPoints(props: { points: readonly ReviewPointProjection[]; t: CollabTranslate }): ReactNode {
  if (props.points.length === 0) return <div className={css.empty}><strong>{props.t("inspector.noReviews")}</strong><p>{props.t("inspector.noReviewsHint")}</p></div>;
  return <ul className={css.reviewList}>{props.points.map(({ reviewPoint, freshness, progress }) => <li key={reviewPoint.reviewPointId} className={css.reviewCard}>
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
  </li>)}</ul>;
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
  onRefreshReviewPoints(): void;
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
      {(["changes", "reviews"] as const).map((tab) => <button key={tab} type="button" role="tab" aria-selected={props.activeTab === tab} onClick={() => { props.onSelectTab(tab); }}>{t(`inspector.${tab}`)}</button>)}
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
      </> : <section className={css.reviews} aria-labelledby="collab-review-points-title">
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
        <ReviewPoints points={props.state.reviewPoints ?? []} t={t} />
      </section>}
    </div>
  </aside>;
}
