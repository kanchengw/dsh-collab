import { useEffect, useRef, useState, type ReactNode } from "react";
import { DiffBlock, type DiffHunk } from "@deepseek-ai/dsh-client-ui-primitives";
import type { WorkspaceSharingState, WorkspaceSnapshotPackage } from "./collaboration-types.js";
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
  error?: string;
}

export function inspectorRoomState(roomId: string, sharing?: WorkspaceSharingState): CollabInspectorState {
  return { status: "idle", ...(sharing?.roomId === roomId ? { sharing } : {}) };
}

export function beginInspectorRefresh(current: CollabInspectorState): CollabInspectorState {
  const { diff: _diff, ...state } = current;
  return { ...state, status: "loading", error: undefined };
}

export function useCollabInspector(input: {
  roomId: string;
  role: "host" | "participant";
  sharing?: WorkspaceSharingState;
  port?: DshCollabSettingsPort;
}): {
  open: boolean;
  state: CollabInspectorState;
  show(): void;
  close(): void;
  refresh(): Promise<void>;
  setSharing(enabled: boolean): Promise<void>;
  loadSnapshot(): Promise<void>;
  loadDiff(path: string, layer: "staged" | "unstaged"): Promise<void>;
} {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<CollabInspectorState>(() => inspectorRoomState(input.roomId, input.sharing));
  const roomIdRef = useRef(input.roomId);
  roomIdRef.current = input.roomId;
  const updateCurrentRoom = (roomId: string, update: (current: CollabInspectorState) => CollabInspectorState): void => {
    if (roomIdRef.current === roomId) setState(update);
  };

  useEffect(() => {
    setOpen(false);
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
  return {
    open,
    state,
    show: () => { setOpen(true); void refresh(); },
    close: () => { setOpen(false); },
    refresh,
    setSharing,
    loadSnapshot,
    loadDiff,
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

export function DshCollabInspector(props: {
  open: boolean;
  role: "host" | "participant";
  state: CollabInspectorState;
  onClose(): void;
  onRefresh(): void;
  onSetSharing(enabled: boolean): void;
  onLoadSnapshot(): void;
  onLoadDiff(path: string, layer: "staged" | "unstaged"): void;
  t?: CollabTranslate;
}): ReactNode {
  if (!props.open) return null;
  const t = props.t ?? defaultCollabTranslate;
  const busy = props.state.status === "loading";
  const enabled = props.state.sharing?.enabled === true;
  return <aside className={css.inspector} data-collab-inspector="changes" aria-labelledby="collab-changes-title">
    <header className={css.header}>
      <div><h2 id="collab-changes-title">{t("inspector.changes")}</h2><p>{t("inspector.description")}</p></div>
      <button type="button" className={css.close} aria-label={t("inspector.close")} onClick={props.onClose}>×</button>
    </header>
    <div className={css.body}>
      <section className={css.sharing} aria-labelledby="collab-workspace-sharing-title">
        <div><h3 id="collab-workspace-sharing-title">{t("inspector.workspaceSharing")}</h3><p>{t(props.role === "host" ? "inspector.hostSharingHint" : "inspector.participantSharingHint")}</p></div>
        {props.role === "host" ? <button type="button" className={css.switch} role="switch" aria-checked={enabled} disabled={busy} onClick={() => { props.onSetSharing(!enabled); }}><span /></button> : <span className={enabled ? css.shared : css.notShared}>{t(props.state.sharing === undefined ? "inspector.loading" : enabled ? "inspector.shared" : "inspector.notShared")}</span>}
      </section>

      {props.state.error ? <p className={css.error} role="alert">{props.state.error}</p> : null}
      {props.role === "host" ? <section className={css.changes} aria-labelledby="collab-current-changes-title">
        <div className={css.sectionHeading}><div><h3 id="collab-current-changes-title">{t("inspector.currentChanges")}</h3><p>{t("inspector.currentChangesHint")}</p></div><button type="button" className={css.action} disabled={busy} onClick={props.onRefresh}>{t(busy ? "inspector.loading" : "inspector.refresh")}</button></div>
        {props.state.repository ? <RepositoryChanges inspection={props.state.repository} diff={props.state.diff} onLoadDiff={props.onLoadDiff} t={t} /> : <p className={css.emptyText}>{t(busy ? "inspector.loading" : "inspector.openToLoad")}</p>}
      </section> : props.state.sharing === undefined ? <div className={css.disabled} role="status"><strong>{t("inspector.checkingAccess")}</strong><p>{t("inspector.checkingAccessHint")}</p></div> : !enabled ? <div className={css.disabled}><strong>{t("inspector.notSharedTitle")}</strong><p>{t("inspector.notSharedDescription")}</p></div> : <section className={css.participantSnapshot}>
        <div><strong>{t("inspector.snapshotAccess")}</strong><p>{t("inspector.snapshotAccessHint")}</p></div>
        <button type="button" className={css.primaryAction} disabled={busy} onClick={props.onLoadSnapshot}>{t(busy ? "inspector.loading" : "inspector.loadSnapshot")}</button>
        {props.state.snapshot ? <SnapshotFiles snapshot={props.state.snapshot} t={t} /> : null}
      </section>}
    </div>
  </aside>;
}
