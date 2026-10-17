import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { CollaborationDecision, CollaborationTask, TaskStatus } from "./collaboration-types.js";
import css from "./collab-tasks.module.css";

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
  error?: string;
}

export interface CollabTasksPort {
  getSnapshot(): CollabTasksSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  createTask(input: { title: string; description?: string }): Promise<void>;
  selectTask(taskId: string): Promise<void>;
  claimTask(taskId: string): Promise<void>;
  setTaskStatus(taskId: string, status: TaskStatus): Promise<void>;
  addTaskParticipant(taskId: string, memberId: string): Promise<void>;
}

const TASK_STATUSES: readonly TaskStatus[] = ["open", "doing", "in-review", "done", "cancelled"];

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
    setTaskStatus: (taskId: string, status: TaskStatus) => port.setTaskStatus(requiredText(taskId, "taskId"), status),
    addTaskParticipant: (taskId: string, memberId: string) => port.addTaskParticipant(requiredText(taskId, "taskId"), requiredText(memberId, "memberId")),
  };
}

function memberName(snapshot: CollabTasksSnapshot, memberId: string | undefined): string {
  if (!memberId) return "-";
  return snapshot.members.find((member) => member.memberId === memberId)?.displayName ?? memberId;
}

function statusLabel(status: TaskStatus): string {
  return status === "in-review" ? "In review" : status.charAt(0).toUpperCase() + status.slice(1);
}

function TaskDetail(props: { item: CollabTaskItem; snapshot: CollabTasksSnapshot; port: CollabTasksPort; busy?: string; run: (name: string, action: () => Promise<void>) => void }): ReactNode {
  const { task } = props.item;
  const [participantId, setParticipantId] = useState("");
  const [status, setStatus] = useState<TaskStatus>(task.status);
  return <section className={css.detail} aria-label="Task details">
    <header className={css.detailHeader}><div><h3>{task.title}</h3><p>{task.description}</p></div><span className={css.status}>{statusLabel(task.status)}</span></header>
    <dl className={css.meta}>
      <div><dt>Assignee</dt><dd>{memberName(props.snapshot, task.assigneeId)}</dd></div>
      <div><dt>Participants</dt><dd>{task.participantIds.map((memberId) => memberName(props.snapshot, memberId)).join(", ")}</dd></div>
    </dl>
    <div className={css.actions}>
      <button type="button" disabled={props.snapshot.connection === "offline" || props.busy !== undefined || task.assigneeId === props.snapshot.currentMemberId} onClick={() => { props.run("claim", () => props.port.claimTask(task.taskId)); }}>Claim task</button>
      <select aria-label="Task status" value={status} disabled={props.snapshot.connection === "offline" || props.busy !== undefined} onChange={(event) => { setStatus(event.currentTarget.value as TaskStatus); }}>
        {TASK_STATUSES.map((value) => <option key={value} value={value}>{statusLabel(value)}</option>)}
      </select>
      <button type="button" disabled={props.snapshot.connection === "offline" || props.busy !== undefined || status === task.status} onClick={() => { props.run("status", () => props.port.setTaskStatus(task.taskId, status)); }}>Update status</button>
    </div>
    <div className={css.actions}>
      <select aria-label="Task participant" value={participantId} disabled={props.snapshot.connection === "offline" || props.busy !== undefined} onChange={(event) => { setParticipantId(event.currentTarget.value); }}>
        <option value="">Select participant</option>
        {props.snapshot.members.filter((member) => !task.participantIds.includes(member.memberId)).map((member) => <option key={member.memberId} value={member.memberId}>{member.displayName}</option>)}
      </select>
      <button type="button" disabled={props.snapshot.connection === "offline" || props.busy !== undefined || participantId === ""} onClick={() => { props.run("participant", () => props.port.addTaskParticipant(task.taskId, participantId)); }}>Add participant</button>
    </div>
    <h4>Discussion</h4>
    {(props.item.discussion ?? []).length === 0 ? <p className={css.hint}>No discussion yet</p> : <ul className={css.list}>{props.item.discussion!.map((message) => <li key={message.messageId}><strong>{memberName(props.snapshot, message.authorId)}</strong><span>{message.text}</span></li>)}</ul>}
    <h4>Decision</h4>
    {props.item.decisions.length === 0 ? <p className={css.hint}>No decisions linked</p> : <ul className={css.list}>{props.item.decisions.map((decision) => <li key={decision.decisionId}><strong>{statusLabel(decision.status as TaskStatus)}</strong><span>{decision.conclusion}</span></li>)}</ul>}
    <h4>ChangeSet</h4>
    {props.item.changeSets.length === 0 ? <p className={css.hint}>No ChangeSets linked</p> : <ul className={css.list}>{props.item.changeSets.map((changeSet) => <li key={changeSet.changeSetId}><strong>{changeSet.title}</strong><span>{changeSet.status}</span></li>)}</ul>}
  </section>;
}

export function CollabTasks(props: { port: CollabTasksPort }): ReactNode {
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
    void action().catch((error: unknown) => { setActionError(error instanceof Error ? error.message : String(error)); }).finally(() => { setBusy(undefined); });
  };
  const create = (event: FormEvent): void => {
    event.preventDefault();
    run("create", async () => { await actions.createTask({ title, description }); setTitle(""); setDescription(""); await props.port.refresh(); });
  };
  const selected = snapshot.tasks.find((item) => item.task.taskId === snapshot.selectedTaskId) ?? (snapshot.tasks.length === 1 ? snapshot.tasks[0] : undefined);
  const error = actionError ?? snapshot.error;
  return <section className={css.tasks} aria-label="Task board" data-collab-tasks="true" data-role={snapshot.role} data-connection={snapshot.connection}>
    <header className={css.header}><div><h2>Task board</h2><p>Create, claim, and move work through the room.</p></div><span className={css.connection} role="status">{snapshot.connection === "online" ? "Online" : "Offline"}</span></header>
    {snapshot.connection === "offline" ? <p className={css.offline} role="status">Reconnect to create or update tasks.</p> : null}
    {error ? <div className={css.error} role="alert">{error}<button type="button" onClick={() => { run("refresh", () => props.port.refresh()); }}>Retry</button></div> : null}
    <form className={css.create} onSubmit={create}><label>Title<input required maxLength={120} value={title} onChange={(event) => { setTitle(event.currentTarget.value); }} /></label><label>Description<textarea value={description} onChange={(event) => { setDescription(event.currentTarget.value); }} /></label><button type="submit" disabled={snapshot.connection === "offline" || busy !== undefined}>Create task</button></form>
    <section className={css.board} aria-label="Tasks">
      {snapshot.tasks.length === 0 ? <p className={css.hint}>No tasks yet</p> : <ul className={css.cards}>{snapshot.tasks.map((item) => <li key={item.task.taskId}><button type="button" className={css.card} aria-pressed={selected?.task.taskId === item.task.taskId} disabled={busy !== undefined} onClick={() => { run("select", () => props.port.selectTask(item.task.taskId)); }}><strong>{item.task.title}</strong><span>{statusLabel(item.task.status)}</span></button></li>)}</ul>}
    </section>
    {selected ? <TaskDetail item={selected} snapshot={snapshot} port={props.port} busy={busy} run={(name, action) => { run(name, async () => { await action(); }); }} /> : null}
  </section>;
}
