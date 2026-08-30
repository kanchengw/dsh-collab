import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { StagedChangeSet } from "./change-set-staging.js";
import type { ChangeSetDraftBundle, ChangeSetDraftFile } from "./change-sets.js";
import css from "./collab-changes.module.css";
import { defaultCollabTranslate, type CollabTranslate } from "./locales.js";

export type CollabChangesWorkspaceSnapshot =
  | { kind: "owner"; latestVersionId?: string }
  | { kind: "unavailable"; latestVersionId?: string }
  | { kind: "ready"; path: string; baseVersionId: string; latestVersionId?: string; dirtyPaths: readonly string[] };

export interface CollabChangesSnapshot {
  roomId: string;
  role: "owner" | "participant";
  connection: "online" | "offline";
  workspace: CollabChangesWorkspaceSnapshot;
  draft?: ChangeSetDraftBundle;
  staged: readonly { changeSet: StagedChangeSet; patch?: string }[];
  selectedChangeSetId?: string;
  error?: string;
}

export interface CollabChangesPort {
  getSnapshot(): CollabChangesSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  sync(): Promise<void>;
  discardAndSync(): Promise<void>;
  createDraft(input: { title: string; summary: string }): Promise<void>;
  submitDraft(): Promise<void>;
  selectChangeSet(changeSetId: string): Promise<void>;
}

export function validateCollabChangesSnapshot(snapshot: CollabChangesSnapshot): CollabChangesSnapshot {
  if (!snapshot || typeof snapshot.roomId !== "string" || snapshot.roomId.trim() === "") throw new Error("Collab Changes room is invalid");
  if (snapshot.role !== "owner" && snapshot.role !== "participant") throw new Error("Collab Changes role is invalid");
  if (snapshot.connection !== "online" && snapshot.connection !== "offline") throw new Error("Collab Changes connection is invalid");
  if (!snapshot.workspace || !["owner", "unavailable", "ready"].includes(snapshot.workspace.kind)) throw new Error("Collab Changes workspace is invalid");
  if ((snapshot.role === "owner") !== (snapshot.workspace.kind === "owner")) throw new Error("Collab Changes workspace does not match its role");
  if (snapshot.workspace.kind === "ready"
    && (snapshot.workspace.path.trim() === "" || snapshot.workspace.baseVersionId.trim() === ""
      || !Array.isArray(snapshot.workspace.dirtyPaths) || snapshot.workspace.dirtyPaths.some((path) => typeof path !== "string" || path.trim() === ""))) {
    throw new Error("Collab Changes workspace is invalid");
  }
  if (snapshot.draft?.draft.roomId !== undefined && snapshot.draft.draft.roomId !== snapshot.roomId) {
    throw new Error("Collab Changes draft belongs to another room");
  }
  const seen = new Set<string>();
  for (const item of snapshot.staged) {
    if (item.changeSet.draft.roomId !== snapshot.roomId) throw new Error("Collab Changes staged ChangeSet belongs to another room");
    if (seen.has(item.changeSet.changeSetId)) throw new Error("Collab Changes contains a duplicate staged ChangeSet");
    seen.add(item.changeSet.changeSetId);
  }
  if (snapshot.selectedChangeSetId !== undefined && !seen.has(snapshot.selectedChangeSetId)) {
    throw new Error("Collab Changes selected ChangeSet does not belong to this room state");
  }
  return snapshot;
}

function shortId(value: string | undefined): string {
  return value ? value.slice(0, 10) : "-";
}

function operationLabel(file: ChangeSetDraftFile, t: CollabTranslate): string {
  return t(`changes.operation.${file.operation}`);
}

function FileList(props: { files: readonly ChangeSetDraftFile[]; t: CollabTranslate }): ReactNode {
  return <ul className={css.files} aria-label={props.t("changes.files")}>
    {props.files.map((file) => <li key={`${file.operation}:${file.previousPath ?? ""}:${file.path}`}>
      <span className={css.operation}>{operationLabel(file, props.t)}</span>
      <code>{file.previousPath ? `${file.previousPath} -> ${file.path}` : file.path}</code>
      <span className={css.stats}><span>+{file.additions}</span><span>-{file.deletions}</span></span>
    </li>)}
  </ul>;
}

function Diff(props: { patch?: string; t: CollabTranslate }): ReactNode {
  return <details className={css.diff} open>
    <summary>{props.t("changes.immutableDiff")}</summary>
    {props.patch === undefined ? <p>{props.t("changes.diffUnavailable")}</p> : <pre><code>{props.patch}</code></pre>}
  </details>;
}

function WorkspaceCard(props: {
  snapshot: CollabChangesSnapshot;
  busy?: string;
  run(name: string, action: () => Promise<void>): void;
  port: CollabChangesPort;
  t: CollabTranslate;
}): ReactNode {
  const { workspace, role, connection } = props.snapshot;
  if (role === "owner") return <section className={css.card} aria-label={props.t("changes.workspaceTitle")}>
    <div className={css.cardHeader}><h3>{props.t("changes.workspaceTitle")}</h3><span className={css.badge}>{props.t("changes.ownerWorkspace")}</span></div>
    <p className={css.hint}>{props.t("changes.ownerWorkspaceHint")}</p>
    <dl className={css.versions}><div><dt>{props.t("changes.latestVersion")}</dt><dd><code>{shortId(workspace.latestVersionId)}</code></dd></div></dl>
  </section>;

  if (workspace.kind === "unavailable") return <section className={css.card} aria-label={props.t("changes.workspaceTitle")}>
    <div className={css.cardHeader}><h3>{props.t("changes.workspaceTitle")}</h3><span className={css.badge}>{props.t("changes.notDownloaded")}</span></div>
    <p className={css.hint}>{props.t("changes.notDownloadedHint")}</p>
    <button type="button" className={css.primary} disabled={connection === "offline" || props.busy !== undefined} onClick={() => { props.run("sync", () => props.port.sync()); }}>
      {props.t(props.busy === "sync" ? "changes.syncing" : "changes.downloadWorkspace")}
    </button>
  </section>;

  if (workspace.kind === "owner") throw new Error("Participant Collab Changes cannot use an Owner workspace");

  const upstream = workspace.latestVersionId !== undefined && workspace.latestVersionId !== workspace.baseVersionId;
  const dirty = workspace.dirtyPaths.length > 0;
  return <section className={css.card} aria-label={props.t("changes.workspaceTitle")}>
    <div className={css.cardHeader}>
      <h3>{props.t("changes.workspaceTitle")}</h3>
      <span className={css.badge} data-tone={upstream ? "warn" : dirty ? "dirty" : "current"}>
        {props.t(upstream ? "changes.upstreamAvailable" : dirty ? "changes.localChanges" : "changes.current")}
      </span>
    </div>
    <dl className={css.versions}>
      <div><dt>{props.t("changes.baseVersion")}</dt><dd><code>{shortId(workspace.baseVersionId)}</code></dd></div>
      <div><dt>{props.t("changes.latestVersion")}</dt><dd><code>{shortId(workspace.latestVersionId ?? workspace.baseVersionId)}</code></dd></div>
    </dl>
    <p className={css.hint}>{dirty
      ? props.t("changes.dirtyFiles", { count: workspace.dirtyPaths.length })
      : props.t("changes.cleanWorkspace")}</p>
    {upstream ? <div className={css.actions}>
      {!dirty ? <button type="button" className={css.primary} disabled={connection === "offline" || props.busy !== undefined} onClick={() => { props.run("sync", () => props.port.sync()); }}>{props.t(props.busy === "sync" ? "changes.syncing" : "changes.syncLatest")}</button> : null}
      {dirty ? <p className={css.warning}>{props.t("changes.upstreamDirtyHint")}</p> : null}
      {dirty ? <button type="button" className={css.danger} disabled={connection === "offline" || props.busy !== undefined} onClick={() => { props.run("discard", () => props.port.discardAndSync()); }}>{props.t(props.busy === "discard" ? "changes.syncing" : "changes.discardAndSync")}</button> : null}
    </div> : null}
  </section>;
}

function DraftCard(props: {
  snapshot: CollabChangesSnapshot;
  busy?: string;
  run(name: string, action: () => Promise<void>): void;
  port: CollabChangesPort;
  t: CollabTranslate;
}): ReactNode {
  const id = useId();
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const dirty = props.snapshot.workspace.kind === "ready" && props.snapshot.workspace.dirtyPaths.length > 0;
  if (props.snapshot.role !== "participant") return null;
  if (!props.snapshot.draft) return <section className={css.card} aria-label={props.t("changes.draftTitle")}>
    <div className={css.cardHeader}><h3>{props.t("changes.draftTitle")}</h3><span className={css.badge}>{props.t("changes.localOnly")}</span></div>
    {!dirty ? <p className={css.hint}>{props.t("changes.draftEmpty")}</p> : <form className={css.form} onSubmit={(event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      props.run("draft", () => props.port.createDraft({ title: title.trim(), summary: summary.trim() }));
    }}>
      <label htmlFor={`${id}-title`}>{props.t("changes.titleLabel")}</label>
      <input id={`${id}-title`} value={title} maxLength={160} onChange={(event) => { setTitle(event.target.value); }} />
      <label htmlFor={`${id}-summary`}>{props.t("changes.summaryLabel")}</label>
      <textarea id={`${id}-summary`} value={summary} maxLength={4000} rows={3} onChange={(event) => { setSummary(event.target.value); }} />
      <button type="submit" className={css.primary} disabled={props.snapshot.connection === "offline" || props.busy !== undefined || title.trim() === "" || summary.trim() === ""}>
        {props.t(props.busy === "draft" ? "changes.creatingDraft" : "changes.createDraft")}
      </button>
    </form>}
  </section>;

  const bundle = props.snapshot.draft;
  return <section className={css.card} aria-label={props.t("changes.draftTitle")}>
    <div className={css.cardHeader}><h3>{bundle.draft.title}</h3><span className={css.badge}>{props.t("changes.localDraft")}</span></div>
    <p className={css.summary}>{bundle.draft.summary}</p>
    <FileList files={bundle.draft.files} t={props.t} />
    <Diff patch={bundle.patch} t={props.t} />
    <div className={css.actions}><button type="button" className={css.primary} disabled={props.snapshot.connection === "offline" || props.busy !== undefined} onClick={() => { props.run("submit", () => props.port.submitDraft()); }}>
      {props.t(props.busy === "submit" ? "changes.submitting" : "changes.submit")}
    </button></div>
  </section>;
}

function StagingCard(props: {
  snapshot: CollabChangesSnapshot;
  busy?: string;
  run(name: string, action: () => Promise<void>): void;
  port: CollabChangesPort;
  t: CollabTranslate;
}): ReactNode {
  const selected = props.snapshot.staged.find((item) => item.changeSet.changeSetId === props.snapshot.selectedChangeSetId)
    ?? (props.snapshot.staged.length === 1 ? props.snapshot.staged[0] : undefined);
  return <section className={css.card} aria-label={props.t("changes.stagedTitle")}>
    <div className={css.cardHeader}><h3>{props.t("changes.stagedTitle")}</h3><span className={css.badge}>{props.snapshot.staged.length}</span></div>
    {props.snapshot.staged.length === 0 ? <p className={css.hint}>{props.t("changes.stagedEmpty")}</p> : <>
      <ul className={css.changeSets}>{props.snapshot.staged.map(({ changeSet }) => <li key={changeSet.changeSetId}>
        <button type="button" aria-pressed={selected?.changeSet.changeSetId === changeSet.changeSetId} disabled={props.busy !== undefined} onClick={() => { props.run("select", () => props.port.selectChangeSet(changeSet.changeSetId)); }}>
          <span>{changeSet.draft.title}</span><code>{shortId(changeSet.changeSetId)}</code>
        </button>
      </li>)}</ul>
      {selected ? <div className={css.selected}>
        <p className={css.summary}>{selected.changeSet.draft.summary}</p>
        <FileList files={selected.changeSet.draft.files} t={props.t} />
        <Diff patch={selected.patch} t={props.t} />
      </div> : null}
    </>}
  </section>;
}

export function CollabChanges(props: { port: CollabChangesPort; t?: CollabTranslate }): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const [snapshot, setSnapshot] = useState(() => validateCollabChangesSnapshot(props.port.getSnapshot()));
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  useEffect(() => {
    const update = (): void => { setSnapshot(validateCollabChangesSnapshot(props.port.getSnapshot())); };
    update();
    return props.port.subscribe(update);
  }, [props.port]);
  const run = (name: string, action: () => Promise<void>): void => {
    if (busy !== undefined) return;
    setBusy(name);
    setActionError(undefined);
    void action().catch((error: unknown) => { setActionError(error instanceof Error ? error.message : String(error)); }).finally(() => { setBusy(undefined); });
  };
  const error = actionError ?? snapshot.error;

  return <section className={css.changes} aria-label={t("changes.title")} data-role={snapshot.role} data-connection={snapshot.connection}>
    <header className={css.header}>
      <div><h2>{t("changes.title")}</h2><p>{t(snapshot.role === "owner" ? "changes.ownerDescription" : "changes.description")}</p></div>
      <span className={css.connection} role="status">{t(snapshot.connection === "online" ? "changes.online" : "changes.offline")}</span>
    </header>
    {snapshot.connection === "offline" ? <p className={css.offline} role="status">{t("changes.offlineHint")}</p> : null}
    {error ? <div className={css.error} role="alert"><span>{error}</span><button type="button" disabled={busy !== undefined} onClick={() => { run("refresh", () => props.port.refresh()); }}>{t("changes.retry")}</button></div> : null}
    <WorkspaceCard snapshot={snapshot} busy={busy} run={run} port={props.port} t={t} />
    <DraftCard snapshot={snapshot} busy={busy} run={run} port={props.port} t={t} />
    <StagingCard snapshot={snapshot} busy={busy} run={run} port={props.port} t={t} />
  </section>;
}
