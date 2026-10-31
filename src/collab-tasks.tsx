import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { CollaborationDecision, CollaborationTask, TaskStatus } from "./collaboration-types.js";
import css from "./collab-tasks.module.css";
import { defaultCollabTranslate, type CollabLocaleKey, type CollabTranslate } from "./locales.js";

export interface CollabTaskMember {
  memberId: string;
  displayName: string;
}

export interface CollabTaskDecision extends CollaborationDecision {}

export interface CollabTaskChangeSet {
  changeSetId: string;
  roomId: string;
  title: string;
  status: string;
}

export interface CollabTaskDiscussionMessage {
  messageId: string;
  authorId: string;
  text: string;
}

export interface CollabTaskItem {
  task: CollaborationTask;
  decisions: readonly CollabTaskDecision[];
  changeSets: readonly CollabTaskChangeSet[];
  discussion?: readonly CollabTaskDiscussionMessage[];
}

export interface CollabTasksSnapshot {
  roomId: string;
  role: "owner" | "participant";
  currentMemberId: string;
  connection: "online" | "offline";
  members: readonly CollabTaskMember[];
  tasks: readonly CollabTaskItem[];
  selectedTaskId?: string;
  roomDecisions?: readonly CollabTaskDecision[];
  availableMessageIds?: readonly string[];
  error?: string;
}

export interface CollabTasksPort {
  getSnapshot(): CollabTasksSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  createTask(input: { title: string; description?: string }): Promise<void>;
  selectTask(taskId: string): Promise<void>;
  claimTask(taskId: string): Promise<void>;
  unassignTask?(taskId: string): Promise<void>;
  setTaskStatus(taskId: string, status: TaskStatus): Promise<void>;
  addTaskParticipant(taskId: string, memberId: string): Promise<void>;
  sendDiscussion(taskId: string, text: string): Promise<void>;
  proposeDecision?(input: { scope: string; conclusion: string; sourceMessageIds: string[] }): Promise<void>;
  acceptDecision?(decisionId: string): Promise<void>;
  forRoom?(roomId: string): CollabTasksPort | undefined;
}

const TASK_STATUSES: readonly TaskStatus[] = ["open", "doing", "in-review"];

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must not be blank`);
  return value.trim();
}

export function validateCollabTasksSnapshot(snapshot: CollabTasksSnapshot): CollabTasksSnapshot {
  if (!snapshot || typeof snapshot.roomId !== "string" || snapshot.roomId.trim() === "") throw new Error("Collab Tasks room is invalid");
  if (snapshot.role !== "owner" && snapshot.role !== "participant") throw new Error("Collab Tasks role is invalid");
  if (snapshot.connection !== "online" && snapshot.connection !== "offline") throw new Error("Collab Tasks connection is invalid");
  const members = new Set<string>();
  for (const member of snapshot.members) {
    if (!member || member.memberId.trim() === "" || member.displayName.trim() === "" || members.has(member.memberId)) throw new Error("Collab Tasks member list is invalid");
    members.add(member.memberId);
  }
  if (!members.has(snapshot.currentMemberId)) throw new Error("Collab Tasks current member is invalid");
  const taskIds = new Set<string>();
  for (const item of snapshot.tasks) {
    const task = item.task;
    if (task.roomId !== snapshot.roomId || taskIds.has(task.taskId)) throw new Error("Collab Tasks task belongs to another room or is duplicated");
    if (!task.participantIds.every((memberId) => members.has(memberId))) throw new Error("Collab Tasks participant is not a room member");
    if (task.assigneeId !== undefined && !members.has(task.assigneeId)) throw new Error("Collab Tasks assignee is not a room member");
    for (const decision of item.decisions) {
      if (decision.roomId !== snapshot.roomId) throw new Error("Collab Tasks Decision belongs to another room");
    }
    for (const changeSet of item.changeSets) {
      if (changeSet.roomId !== snapshot.roomId) throw new Error("Collab Tasks ChangeSet belongs to another room");
    }
    for (const message of item.discussion ?? []) {
      if (!members.has(message.authorId)) throw new Error("Collab Tasks discussion author is not a room member");
    }
    taskIds.add(task.taskId);
  }
  const availableMessageIds = new Set<string>();
  for (const messageId of snapshot.availableMessageIds ?? []) {
    if (messageId.trim() === "" || availableMessageIds.has(messageId)) throw new Error("Collab Tasks message references are invalid");
    availableMessageIds.add(messageId);
  }
  for (const decision of snapshot.roomDecisions ?? []) {
    if (decision.roomId !== snapshot.roomId || decision.scope !== "room") throw new Error("Collab Tasks room Decision is invalid");
  }
  if (snapshot.selectedTaskId !== undefined && !taskIds.has(snapshot.selectedTaskId)) throw new Error("Collab Tasks selected task is invalid");
  return snapshot;
}

export function createCollabTaskActionHandlers(port: CollabTasksPort) {
  return {
    createTask: (input: { title: string; description?: string }) => port.createTask({
      title: requiredText(input.title, "title"),
      ...(input.description?.trim() ? { description: input.description.trim() } : {}),
    }),
    claimTask: (taskId: string) => port.claimTask(requiredText(taskId, "taskId")),
    unassignTask: (taskId: string) => port.unassignTask?.(requiredText(taskId, "taskId")) ?? Promise.reject(new Error("Task assignment actions are unavailable")),
    setTaskStatus: (taskId: string, status: TaskStatus) => port.setTaskStatus(requiredText(taskId, "taskId"), status),
    addTaskParticipant: (taskId: string, memberId: string) => port.addTaskParticipant(requiredText(taskId, "taskId"), requiredText(memberId, "memberId")),
    sendDiscussion: (taskId: string, text: string) => port.sendDiscussion(requiredText(taskId, "taskId"), requiredText(text, "text")),
    proposeDecision: (input: { scope: string; conclusion: string; sourceMessageIds: string[] }) => port.proposeDecision?.({
      scope: requiredText(input.scope, "scope"),
      conclusion: requiredText(input.conclusion, "conclusion"),
      sourceMessageIds: input.sourceMessageIds.map((messageId) => requiredText(messageId, "sourceMessageId")),
    }) ?? Promise.reject(new Error("Decision actions are unavailable")),
    acceptDecision: (decisionId: string) => port.acceptDecision?.(requiredText(decisionId, "decisionId")) ?? Promise.reject(new Error("Decision actions are unavailable")),
  };
}

function memberName(snapshot: CollabTasksSnapshot, memberId: string | undefined): string {
  if (!memberId) return "-";
  return snapshot.members.find((member) => member.memberId === memberId)?.displayName ?? memberId;
}

function statusLabel(status: TaskStatus, t: CollabTranslate): string {
  const keys: Record<TaskStatus, CollabLocaleKey> = {
    open: "tasks.status.open",
    doing: "tasks.status.doing",
    "in-review": "tasks.status.in-review",
    done: "tasks.status.done",
    cancelled: "tasks.status.cancelled",
  };
  return t(keys[status]);
}

function decisionStatusLabel(status: string, t: CollabTranslate): string {
  const keys: Partial<Record<string, CollabLocaleKey>> = {
    proposed: "tasks.decisionStatus.proposed",
    accepted: "tasks.decisionStatus.accepted",
    superseded: "tasks.decisionStatus.superseded",
  };
  const key = keys[status];
  return key ? t(key) : status;
}

function changeSetStatusLabel(status: string, t: CollabTranslate): string {
  const keys: Partial<Record<string, CollabLocaleKey>> = {
    submitted: "reviews.status.submitted",
    "in-review": "reviews.status.in-review",
    "changes-requested": "reviews.status.changes-requested",
    approved: "reviews.status.approved",
    applied: "reviews.status.applied",
    superseded: "reviews.status.superseded",
  };
  const key = keys[status];
  return key ? t(key) : status;
}

function DecisionComposer(props: { scope: string; sourceMessageIds: readonly string[]; port: CollabTasksPort; t: CollabTranslate; busy?: string; run: (name: string, action: () => Promise<void>) => void }): ReactNode {
  const [conclusion, setConclusion] = useState("");
  const available = props.port.proposeDecision !== undefined && props.sourceMessageIds.length > 0;
  return <form className={css.actions} onSubmit={(event) => {
    event.preventDefault();
    if (!available) return;
    props.run("decision", async () => {
      await props.port.proposeDecision!({ scope: props.scope, conclusion: requiredText(conclusion, "conclusion"), sourceMessageIds: [...props.sourceMessageIds] });
      setConclusion("");
    });
  }}><label>{props.t("tasks.decisionConclusion")}<input aria-label={props.t("tasks.decisionConclusionAria")} required value={conclusion} onChange={(event) => { setConclusion(event.currentTarget.value); }} /></label><button type="submit" disabled={!available || props.busy !== undefined}>{props.t("tasks.proposeDecision")}</button></form>;
}

function DecisionList(props: { decisions: readonly CollabTaskDecision[]; port: CollabTasksPort; snapshot: CollabTasksSnapshot; t: CollabTranslate; busy?: string; run: (name: string, action: () => Promise<void>) => void }): ReactNode {
  return <ul className={css.list}>{props.decisions.map((decision) => <li key={decision.decisionId}><strong>{decisionStatusLabel(decision.status, props.t)}</strong><span>{decision.conclusion}</span>{decision.status === "proposed" ? <button type="button" disabled={props.port.acceptDecision === undefined || props.snapshot.connection === "offline" || props.busy !== undefined} onClick={() => { props.run("accept-decision", () => props.port.acceptDecision!(decision.decisionId)); }}>{props.t("tasks.acceptDecision")}</button> : null}</li>)}</ul>;
}

function TaskDetail(props: { item: CollabTaskItem; snapshot: CollabTasksSnapshot; port: CollabTasksPort; t: CollabTranslate; busy?: string; run: (name: string, action: () => Promise<void>) => void }): ReactNode {
  const { task } = props.item;
  const [participantId, setParticipantId] = useState("");
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [discussionDraft, setDiscussionDraft] = useState("");
  const terminal = task.status === "done" || task.status === "cancelled";
  const statusOptions: readonly TaskStatus[] = terminal ? [task.status] : TASK_STATUSES;
  const sourceMessageIds = (props.item.discussion ?? []).map((message) => message.messageId);
  const sendDiscussion = (event: FormEvent): void => {
    event.preventDefault();
    if (!props.port.sendDiscussion || discussionDraft.trim() === "") return;
    props.run("discussion", async () => {
      await props.port.sendDiscussion!(task.taskId, discussionDraft.trim());
      setDiscussionDraft("");
    });
  };
  return <section className={css.detail} aria-label={props.t("tasks.detailAria")}>
    <header className={css.detailHeader}><div><h3>{task.title}</h3><p>{task.description}</p></div><span className={css.status}>{statusLabel(task.status, props.t)}</span></header>
    <dl className={css.meta}>
      <div><dt>{props.t("tasks.assignee")}</dt><dd>{memberName(props.snapshot, task.assigneeId)}</dd></div><div><dt>{props.t("tasks.participants")}</dt><dd>{task.participantIds.map((memberId) => memberName(props.snapshot, memberId)).join(", ")}</dd></div>
    </dl>
    <div className={css.actions}>
      <button type="button" disabled={props.snapshot.connection === "offline" || props.busy !== undefined || task.assigneeId === props.snapshot.currentMemberId} onClick={() => { props.run("claim", () => props.port.claimTask(task.taskId)); }}>{props.t("tasks.claim")}</button>
      {task.assigneeId && props.port.unassignTask ? <button type="button" disabled={props.snapshot.connection === "offline" || props.busy !== undefined} onClick={() => { props.run("unassign", () => props.port.unassignTask!(task.taskId)); }}>{props.t("tasks.unassign")}</button> : null}
      <select aria-label={props.t("tasks.statusAria")} value={status} disabled={terminal || props.snapshot.connection === "offline" || props.busy !== undefined} onChange={(event) => { setStatus(event.currentTarget.value as TaskStatus); }}>
        {statusOptions.map((value) => <option key={value} value={value}>{statusLabel(value, props.t)}</option>)}
      </select>
      <button type="button" disabled={terminal || props.snapshot.connection === "offline" || props.busy !== undefined || status === task.status} onClick={() => { props.run("status", () => props.port.setTaskStatus(task.taskId, status)); }}>{props.t("tasks.updateStatus")}</button>
    </div>
    <div className={css.actions}>
      <select aria-label={props.t("tasks.participantAria")} value={participantId} disabled={props.snapshot.connection === "offline" || props.busy !== undefined} onChange={(event) => { setParticipantId(event.currentTarget.value); }}>
        <option value="">{props.t("tasks.selectParticipant")}</option>
        {props.snapshot.members.filter((member) => !task.participantIds.includes(member.memberId)).map((member) => <option key={member.memberId} value={member.memberId}>{member.displayName}</option>)}
      </select>
      <button type="button" disabled={props.snapshot.connection === "offline" || props.busy !== undefined || participantId === ""} onClick={() => { props.run("participant", () => props.port.addTaskParticipant(task.taskId, participantId)); }}>{props.t("tasks.addParticipant")}</button>
    </div>
    <h4>{props.t("tasks.discussion")}</h4>
    {(props.item.discussion ?? []).length === 0 ? <p className={css.hint}>{props.t("tasks.discussionEmpty")}</p> : <ul className={css.list}>{props.item.discussion!.map((message) => <li key={message.messageId}><strong>{memberName(props.snapshot, message.authorId)}</strong><span>{message.text}</span></li>)}</ul>}
    <form className={css.actions} onSubmit={sendDiscussion}><label>{props.t("tasks.messageLabel")}<textarea aria-label={props.t("tasks.messageAria")} value={discussionDraft} rows={2} disabled={props.snapshot.connection === "offline" || props.busy !== undefined} onChange={(event) => { setDiscussionDraft(event.currentTarget.value); }} /></label><button type="submit" disabled={props.snapshot.connection === "offline" || props.busy !== undefined || discussionDraft.trim() === ""}>{props.t("tasks.sendDiscussion")}</button></form>
    <h4>{props.t("tasks.decision")}</h4>
    {props.item.decisions.length === 0 ? <p className={css.hint}>{props.t("tasks.decisionsEmpty")}</p> : <DecisionList decisions={props.item.decisions} port={props.port} snapshot={props.snapshot} t={props.t} busy={props.busy} run={props.run} />}
    <DecisionComposer scope={`task:${task.taskId}`} sourceMessageIds={sourceMessageIds} port={props.port} t={props.t} busy={props.busy} run={props.run} />
    <h4>{props.t("tasks.changeSets")}</h4>
    {props.item.changeSets.length === 0 ? <p className={css.hint}>{props.t("tasks.changeSetsEmpty")}</p> : <ul className={css.list}>{props.item.changeSets.map((changeSet) => <li key={changeSet.changeSetId}><strong>{changeSet.title}</strong><span>{changeSetStatusLabel(changeSet.status, props.t)}</span></li>)}</ul>}
  </section>;
}

export function CollabTasks(props: { port: CollabTasksPort; t?: CollabTranslate }): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const [snapshot, setSnapshot] = useState(() => validateCollabTasksSnapshot(props.port.getSnapshot()));
  const [busy, setBusy] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const actions = createCollabTaskActionHandlers(props.port);
  useEffect(() => {
    const update = (): void => { setSnapshot(validateCollabTasksSnapshot(props.port.getSnapshot())); };
    update();
    return props.port.subscribe(update);
  }, [props.port]);
  const run = (name: string, action: () => Promise<void>): void => {
    if (busy !== undefined) return;
    setBusy(name);
    setActionError(undefined);
    void action().catch((error: unknown) => { console.error(error); setActionError(t("tasks.actionError")); }).finally(() => { setBusy(undefined); });
  };
  const create = (event: FormEvent): void => {
    event.preventDefault();
    run("create", async () => { await actions.createTask({ title, description }); setTitle(""); setDescription(""); await props.port.refresh(); });
  };
  const selected = snapshot.tasks.find((item) => item.task.taskId === snapshot.selectedTaskId) ?? (snapshot.tasks.length === 1 ? snapshot.tasks[0] : undefined);
  const error = actionError ?? (snapshot.error ? t("tasks.actionError") : undefined);
  return <section className={css.tasks} aria-label={t("tasks.aria")} data-collab-tasks="true" data-role={snapshot.role} data-connection={snapshot.connection}>
    <header className={css.header}><div><h2>{t("tasks.title")}</h2><p>{t("tasks.description")}</p></div><span className={css.connection} role="status">{t(snapshot.connection === "online" ? "tasks.online" : "tasks.offline")}</span></header>
    {snapshot.connection === "offline" ? <p className={css.offline} role="status">{t("tasks.offlineHint")}</p> : null}
    <section className={css.section} aria-label={t("tasks.roomDecisionsAria")}><h3>{t("tasks.roomDecisions")}</h3>{(snapshot.roomDecisions ?? []).length === 0 ? <p className={css.hint}>{t("tasks.roomDecisionsEmpty")}</p> : <DecisionList decisions={snapshot.roomDecisions!} port={props.port} snapshot={snapshot} t={t} busy={busy} run={(name, action) => { run(name, async () => { await action(); }); }} />}<DecisionComposer scope="room" sourceMessageIds={snapshot.availableMessageIds ?? snapshot.tasks.flatMap((item) => item.discussion ?? []).map((message) => message.messageId)} port={props.port} t={t} busy={busy} run={(name, action) => { run(name, async () => { await action(); }); }} /></section>
    {error ? <div className={css.error} role="alert">{error}<button type="button" onClick={() => { run("refresh", () => props.port.refresh()); }}>{t("tasks.retry")}</button></div> : null}
    <form className={css.create} onSubmit={create}><label>{t("tasks.titleLabel")}<input required maxLength={120} value={title} onChange={(event) => { setTitle(event.currentTarget.value); }} /></label><label>{t("tasks.descriptionLabel")}<textarea value={description} onChange={(event) => { setDescription(event.currentTarget.value); }} /></label><button type="submit" disabled={snapshot.connection === "offline" || busy !== undefined}>{t("tasks.create")}</button></form>
    <section className={css.board} aria-label={t("tasks.boardAria")}>
      <h3 className={css.boardTitle}>{t("tasks.listTitle")}</h3>
      {snapshot.tasks.length === 0 ? <p className={css.hint}>{t("tasks.empty")}</p> : <ul className={css.cards}>{snapshot.tasks.map((item) => <li key={item.task.taskId}><button type="button" className={css.card} data-status={item.task.status} aria-pressed={selected?.task.taskId === item.task.taskId} disabled={busy !== undefined} onClick={() => { run("select", () => props.port.selectTask(item.task.taskId)); }}><strong>{item.task.title}</strong><span>{statusLabel(item.task.status, t)}</span></button></li>)}</ul>}
    </section>
    {selected ? <TaskDetail item={selected} snapshot={snapshot} port={props.port} t={t} busy={busy} run={(name, action) => { run(name, async () => { await action(); }); }} /> : null}
  </section>;
}
