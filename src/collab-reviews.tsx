import { useEffect, useId, useState, type FormEvent, type ReactNode } from "react";
import type { StagedChangeSet } from "./change-set-staging.js";
import type { ChangeSetReview, ChangeSetReviewFinding, ChangeSetReviewStatus } from "./change-set-reviews.js";
import type { ReviewFindingLocation } from "./collaboration-types.js";
import css from "./collab-changes.module.css";
import { defaultCollabTranslate, type CollabTranslate } from "./locales.js";

export interface CollabReviewMember {
  memberId: string;
  displayName: string;
}

export interface CollabReviewItem {
  review: ChangeSetReview;
  changeSet: StagedChangeSet;
  findings: readonly ChangeSetReviewFinding[];
}

export interface CollabReviewsSnapshot {
  roomId: string;
  role: "owner" | "participant";
  currentMemberId: string;
  connection: "online" | "offline";
  members: readonly CollabReviewMember[];
  reviews: readonly CollabReviewItem[];
  selectedChangeSetId?: string;
  error?: string;
}

export interface CollabReviewsPort {
  getSnapshot(): CollabReviewsSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  selectReview(changeSetId: string): Promise<void>;
  assignReviewer(changeSetId: string, reviewerId: string): Promise<void>;
  createFinding(changeSetId: string, input: {
    severity: ChangeSetReviewFinding["severity"];
    location: ReviewFindingLocation;
    body: string;
  }): Promise<void>;
  decide(changeSetId: string, outcome: "approved" | "changes-requested", note?: string): Promise<void>;
  apply?(changeSetId: string): Promise<void>;
}

const STATUSES = new Set<ChangeSetReviewStatus>(["submitted", "in-review", "changes-requested", "approved", "applied", "superseded"]);

export function validateCollabReviewsSnapshot(snapshot: CollabReviewsSnapshot): CollabReviewsSnapshot {
  if (!snapshot || typeof snapshot.roomId !== "string" || snapshot.roomId.trim() === "") throw new Error("Collab Reviews room is invalid");
  if (snapshot.role !== "owner" && snapshot.role !== "participant") throw new Error("Collab Reviews role is invalid");
  if (snapshot.connection !== "online" && snapshot.connection !== "offline") throw new Error("Collab Reviews connection is invalid");
  const members = new Set<string>();
  for (const member of snapshot.members) {
    if (!member || member.memberId.trim() === "" || member.displayName.trim() === "" || members.has(member.memberId)) throw new Error("Collab Reviews member list is invalid");
    members.add(member.memberId);
  }
  if (!members.has(snapshot.currentMemberId)) throw new Error("Collab Reviews current member is invalid");
  const changeSetIds = new Set<string>();
  for (const item of snapshot.reviews) {
    const { review, changeSet } = item;
    if (review.roomId !== snapshot.roomId || changeSet.draft.roomId !== snapshot.roomId) throw new Error("Collab Reviews item belongs to another room");
    if (review.changeSetId !== changeSet.changeSetId || changeSetIds.has(review.changeSetId)) throw new Error("Collab Reviews ChangeSet identity is invalid");
    if (!STATUSES.has(review.status)) throw new Error("Collab Reviews status is invalid");
    for (const finding of item.findings) {
      if (finding.roomId !== snapshot.roomId || finding.changeSetId !== review.changeSetId) throw new Error("Collab Reviews Finding belongs to another room");
    }
    changeSetIds.add(review.changeSetId);
  }
  if (snapshot.selectedChangeSetId !== undefined && !changeSetIds.has(snapshot.selectedChangeSetId)) throw new Error("Collab Reviews selected ChangeSet is invalid");
  return snapshot;
}

function shortId(value: string): string {
  return value.slice(0, 10);
}

function memberName(snapshot: CollabReviewsSnapshot, memberId: string | undefined): string {
  if (!memberId) return "-";
  return snapshot.members.find((member) => member.memberId === memberId)?.displayName ?? memberId;
}

function statusKey(status: ChangeSetReviewStatus): Parameters<CollabTranslate>[0] {
  return `reviews.status.${status}` as Parameters<CollabTranslate>[0];
}

function FindingList(props: { snapshot: CollabReviewsSnapshot; findings: readonly ChangeSetReviewFinding[]; t: CollabTranslate }): ReactNode {
  if (props.findings.length === 0) return <p className={css.hint}>{props.t("reviews.findingsEmpty")}</p>;
  return <ul className={css.files} aria-label={props.t("reviews.findings")}>
    {props.findings.map((finding) => <li key={finding.findingId}>
      <span className={css.operation}>{props.t(`reviews.severity.${finding.severity}`)}</span>
      <span className={css.summary}>
        {finding.location.kind === "general" ? props.t("reviews.location.general")
          : finding.location.kind === "file" ? finding.location.path
            : `${finding.location.path}:${String(finding.location.line)}`}
        {` · ${memberName(props.snapshot, finding.authorId)} · ${finding.body}`}
      </span>
    </li>)}
  </ul>;
}

function AssignmentForm(props: {
  item: CollabReviewItem;
  snapshot: CollabReviewsSnapshot;
  busy?: string;
  run(name: string, action: () => Promise<void>): void;
  port: CollabReviewsPort;
  t: CollabTranslate;
}): ReactNode {
  const id = useId();
  const [reviewerId, setReviewerId] = useState(props.item.review.requiredReviewerId ?? props.snapshot.members[0]?.memberId ?? "");
  const canAssign = props.snapshot.role === "owner" || props.snapshot.currentMemberId === props.item.review.authorId;
  if (!canAssign || props.item.review.decision) return null;
  return <form className={css.form} onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    props.run("assign", () => props.port.assignReviewer(props.item.changeSet.changeSetId, reviewerId));
  }}>
    <label htmlFor={`${id}-reviewer`}>{props.t("reviews.requiredReviewer")}</label>
    <select id={`${id}-reviewer`} value={reviewerId} onChange={(event) => { setReviewerId(event.target.value); }}>
      {props.snapshot.members.map((member) => <option key={member.memberId} value={member.memberId}>{member.displayName}</option>)}
    </select>
    <button type="submit" className={css.primary} disabled={props.snapshot.connection === "offline" || props.busy !== undefined || reviewerId === ""}>{props.t("reviews.assign")}</button>
  </form>;
}

function FindingForm(props: {
  item: CollabReviewItem;
  snapshot: CollabReviewsSnapshot;
  busy?: string;
  run(name: string, action: () => Promise<void>): void;
  port: CollabReviewsPort;
  t: CollabTranslate;
}): ReactNode {
  const id = useId();
  const [severity, setSeverity] = useState<ChangeSetReviewFinding["severity"]>("medium");
  const [kind, setKind] = useState<ReviewFindingLocation["kind"]>("general");
  const [path, setPath] = useState(props.item.changeSet.draft.files[0]?.path ?? "");
  const [line, setLine] = useState("1");
  const [body, setBody] = useState("");
  return <form className={css.form} onSubmit={(event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const location: ReviewFindingLocation = kind === "general" ? { kind }
      : kind === "file" ? { kind, path }
        : { kind, path, line: Number(line) };
    props.run("finding", () => props.port.createFinding(props.item.changeSet.changeSetId, { severity, location, body: body.trim() }));
  }}>
    <h3>{props.t("reviews.addFinding")}</h3>
    <label htmlFor={`${id}-severity`}>{props.t("reviews.severity")}</label>
    <select id={`${id}-severity`} value={severity} onChange={(event) => { setSeverity(event.target.value as ChangeSetReviewFinding["severity"]); }}>
      {(["critical", "high", "medium", "low", "note"] as const).map((value) => <option key={value} value={value}>{props.t(`reviews.severity.${value}`)}</option>)}
    </select>
    <label htmlFor={`${id}-location`}>{props.t("reviews.location")}</label>
    <select id={`${id}-location`} value={kind} onChange={(event) => { setKind(event.target.value as ReviewFindingLocation["kind"]); }}>
      <option value="general">{props.t("reviews.location.general")}</option>
      <option value="file">{props.t("reviews.location.file")}</option>
      <option value="line">{props.t("reviews.location.line")}</option>
    </select>
    {kind !== "general" ? <select aria-label={props.t("reviews.file")} value={path} onChange={(event) => { setPath(event.target.value); }}>
      {props.item.changeSet.draft.files.map((file) => <option key={file.path} value={file.path}>{file.path}</option>)}
    </select> : null}
    {kind === "line" ? <input aria-label={props.t("reviews.line")} type="number" min="1" step="1" value={line} onChange={(event) => { setLine(event.target.value); }} /> : null}
    <label htmlFor={`${id}-finding`}>{props.t("reviews.findingBody")}</label>
    <textarea id={`${id}-finding`} value={body} maxLength={4000} rows={3} onChange={(event) => { setBody(event.target.value); }} />
    <button type="submit" className={css.primary} disabled={props.snapshot.connection === "offline" || props.busy !== undefined || body.trim() === "" || (kind !== "general" && path === "") || (kind === "line" && (!Number.isSafeInteger(Number(line)) || Number(line) < 1))}>{props.t("reviews.addFinding")}</button>
  </form>;
}

function DecisionForm(props: {
  item: CollabReviewItem;
  snapshot: CollabReviewsSnapshot;
  busy?: string;
  run(name: string, action: () => Promise<void>): void;
  port: CollabReviewsPort;
  t: CollabTranslate;
}): ReactNode {
  const id = useId();
  const [note, setNote] = useState("");
  if (props.item.review.status !== "in-review" || props.item.review.requiredReviewerId !== props.snapshot.currentMemberId) return null;
  const decide = (outcome: "approved" | "changes-requested"): void => {
    props.run("decision", () => props.port.decide(props.item.changeSet.changeSetId, outcome, note.trim() || undefined));
  };
  return <div className={css.form}>
    <label htmlFor={`${id}-decision`}>{props.t("reviews.decisionNote")}</label>
    <textarea id={`${id}-decision`} value={note} maxLength={4000} rows={3} onChange={(event) => { setNote(event.target.value); }} />
    <div className={css.actions}>
      <button type="button" className={css.primary} disabled={props.snapshot.connection === "offline" || props.busy !== undefined} onClick={() => { decide("approved"); }}>{props.t("reviews.approve")}</button>
      <button type="button" className={css.danger} disabled={props.snapshot.connection === "offline" || props.busy !== undefined} onClick={() => { decide("changes-requested"); }}>{props.t("reviews.requestChanges")}</button>
    </div>
  </div>;
}

function ReviewDetail(props: {
  item: CollabReviewItem;
  snapshot: CollabReviewsSnapshot;
  busy?: string;
  run(name: string, action: () => Promise<void>): void;
  port: CollabReviewsPort;
  t: CollabTranslate;
}): ReactNode {
  const { review, changeSet } = props.item;
  return <section className={css.card} aria-label={props.t("reviews.detail")}>
    <div className={css.cardHeader}><h3>{changeSet.draft.title}</h3><span className={css.badge} data-tone={review.status === "approved" ? "current" : review.status === "changes-requested" ? "warn" : undefined}>{props.t(statusKey(review.status))}</span></div>
    <p className={css.summary}>{changeSet.draft.summary}</p>
    <dl className={css.versions}>
      <div><dt>{props.t("reviews.author")}</dt><dd>{memberName(props.snapshot, review.authorId)}</dd></div>
      <div><dt>{props.t("reviews.requiredReviewer")}</dt><dd>{memberName(props.snapshot, review.requiredReviewerId)}</dd></div>
    </dl>
    {review.status === "approved" ? <p className={css.hint}>{props.t("reviews.awaitingApply")}</p> : null}
    {review.status === "approved" && props.snapshot.role === "owner" && props.port.apply ? <div className={css.actions}>
      <button type="button" className={css.primary} disabled={props.snapshot.connection === "offline" || props.busy !== undefined} onClick={() => { props.run("apply", () => props.port.apply!(changeSet.changeSetId)); }}>{props.t("reviews.apply")}</button>
    </div> : null}
    {review.supersedesChangeSetId ? <p className={css.hint}>{props.t("reviews.supersedes")} <code>{shortId(review.supersedesChangeSetId)}</code></p> : null}
    {review.supersededByChangeSetId ? <p className={css.hint}>{props.t("reviews.supersededBy")} <code>{shortId(review.supersededByChangeSetId)}</code></p> : null}
    {review.decision?.note ? <p className={css.summary}>{review.decision.note}</p> : null}
    <details className={css.diff}><summary>{props.t("reviews.changedFiles", { count: changeSet.draft.files.length })}</summary>
      <ul className={css.files}>{changeSet.draft.files.map((file) => <li key={`${file.operation}:${file.path}`}><span className={css.operation}>{file.operation}</span><code>{file.path}</code><span className={css.stats}><span>+{file.additions}</span><span>-{file.deletions}</span></span></li>)}</ul>
    </details>
    <h3>{props.t("reviews.findings")}</h3>
    <FindingList snapshot={props.snapshot} findings={props.item.findings} t={props.t} />
    <AssignmentForm {...props} />
    <FindingForm {...props} />
    <DecisionForm {...props} />
  </section>;
}

export function CollabReviews(props: { port: CollabReviewsPort; t?: CollabTranslate }): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const [snapshot, setSnapshot] = useState(() => validateCollabReviewsSnapshot(props.port.getSnapshot()));
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  useEffect(() => {
    const update = (): void => { setSnapshot(validateCollabReviewsSnapshot(props.port.getSnapshot())); };
    update();
    return props.port.subscribe(update);
  }, [props.port]);
  const run = (name: string, action: () => Promise<void>): void => {
    if (busy !== undefined) return;
    setBusy(name);
    setActionError(undefined);
    void action().catch((error: unknown) => { console.error(error); setActionError(t("reviews.actionError")); }).finally(() => { setBusy(undefined); });
  };
  const selected = snapshot.reviews.find((item) => item.review.changeSetId === snapshot.selectedChangeSetId)
    ?? (snapshot.reviews.length === 1 ? snapshot.reviews[0] : undefined);
  const error = actionError ?? (snapshot.error ? t("reviews.actionError") : undefined);
  return <section className={css.changes} aria-label={t("reviews.title")} data-role={snapshot.role} data-connection={snapshot.connection}>
    <header className={css.header}><div><h2>{t("reviews.title")}</h2><p>{t("reviews.description")}</p></div><span className={css.connection} role="status">{t(snapshot.connection === "online" ? "reviews.online" : "reviews.offline")}</span></header>
    {snapshot.connection === "offline" ? <p className={css.offline} role="status">{t("reviews.offlineHint")}</p> : null}
    {error ? <div className={css.error} role="alert"><span>{error}</span><button type="button" disabled={busy !== undefined} onClick={() => { run("refresh", () => props.port.refresh()); }}>{t("reviews.retry")}</button></div> : null}
    <section className={css.card} aria-label={t("reviews.queue")}>
      <div className={css.cardHeader}><h3>{t("reviews.queue")}</h3><span className={css.badge}>{snapshot.reviews.length}</span></div>
      {snapshot.reviews.length === 0 ? <p className={css.hint}>{t("reviews.empty")}</p> : <ul className={css.changeSets}>{snapshot.reviews.map((item) => <li key={item.review.changeSetId}>
        <button type="button" aria-pressed={selected?.review.changeSetId === item.review.changeSetId} disabled={busy !== undefined} onClick={() => { run("select", () => props.port.selectReview(item.review.changeSetId)); }}>
          <span>{item.changeSet.draft.title}</span><span className={css.badge}>{t(statusKey(item.review.status))}</span>
        </button>
      </li>)}</ul>}
    </section>
    {selected ? <ReviewDetail item={selected} snapshot={snapshot} busy={busy} run={run} port={props.port} t={t} /> : null}
  </section>;
}
