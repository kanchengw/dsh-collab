import { CollabError, invalidInput } from "./errors.js";
import type {
  CollaborationTask,
  TaskEvent,
  TaskEventPayload,
  TaskEventType,
  TaskMember,
  TaskStatus,
} from "./collaboration-types.js";

export interface TaskStoreSnapshot {
  version: 1;
  events: TaskEvent[];
}

export interface CreateTaskInput {
  taskId: string;
  roomId: string;
  title: string;
  description?: string;
  actor: TaskMember;
  eventId: string;
  now?: number;
}

export interface TaskMutationInput {
  taskId: string;
  actor: TaskMember;
  eventId: string;
  now?: number;
}

interface ReducedTasks {
  tasks: CollaborationTask[];
  events: TaskEvent[];
}

const STATUS_ORDER: TaskStatus[] = ["open", "doing", "in-review", "done"];

function copy<T>(value: T): T {
  return structuredClone(value);
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw invalidInput(field + " must not be blank", { field });
  return value.trim();
}

function normalizeMember(value: TaskMember): TaskMember {
  return {
    memberId: requiredText(value.memberId, "actor.memberId"),
    principalId: requiredText(value.principalId, "actor.principalId"),
  };
}

function eventSort(a: TaskEvent, b: TaskEvent): number {
  return a.seq - b.seq || a.createdAt - b.createdAt || a.eventId.localeCompare(b.eventId);
}

function addUnique(values: string[], value: string): string[] {
  return values.includes(value) ? [...values] : [...values, value];
}

function validateTask(task: CollaborationTask): void {
  if (task.participantIds.length !== new Set(task.participantIds).size) throw new Error("Task participants must be unique");
  if (task.changeSetIds.length !== new Set(task.changeSetIds).size) throw new Error("Task ChangeSets must be unique");
  if (task.assigneeId !== undefined && !task.participantIds.includes(task.assigneeId)) {
    throw new Error("Task assignee must be a participant");
  }
}

function isValidTransition(from: TaskStatus, to: TaskStatus): boolean {
  return from !== "cancelled" && to !== "cancelled" && STATUS_ORDER.indexOf(to) === STATUS_ORDER.indexOf(from) + 1;
}

export function reduceTaskEvents(input: readonly TaskEvent[]): ReducedTasks {
  const events = [...input].sort(eventSort);
  const accepted: TaskEvent[] = [];
  const seen = new Map<string, TaskEvent>();
  const tasks = new Map<string, CollaborationTask>();

  for (const event of events) {
    const previous = seen.get(event.eventId);
    if (previous) {
      if (JSON.stringify(previous) !== JSON.stringify(event)) throw new CollabError("EVENT_CONFLICT", "event conflict");
      continue;
    }
    seen.set(event.eventId, copy(event));
    const payload = event.payload;
    const current = tasks.get(payload.taskId);

    if (event.type === "task.created") {
      if (current) continue;
      const created = payload as Extract<TaskEventPayload, { createdBy: string }>;
      const task: CollaborationTask = {
        taskId: created.taskId,
        roomId: event.roomId,
        title: created.title,
        ...(created.description === undefined ? {} : { description: created.description }),
        status: "open",
        blocked: false,
        assigneeId: undefined,
        participantIds: [...new Set(created.participantIds)],
        changeSetIds: [],
        createdBy: created.createdBy,
        createdAt: event.createdAt,
        updatedAt: event.createdAt,
      };
      validateTask(task);
      tasks.set(task.taskId, task);
      accepted.push(copy(event));
      continue;
    }

    if (!current) continue;
    if (event.type === "task.updated") {
      const updated = payload as { taskId: string; title?: string; description?: string; blocked?: boolean; participantIds?: string[]; changeSetIds?: string[] };
      if (updated.title !== undefined) current.title = updated.title;
      if (updated.description !== undefined) current.description = updated.description;
      if (updated.blocked !== undefined) current.blocked = updated.blocked;
      if (updated.participantIds !== undefined) current.participantIds = [...new Set(updated.participantIds)];
      if (updated.changeSetIds !== undefined) current.changeSetIds = [...new Set(updated.changeSetIds)];
      current.updatedAt = event.createdAt;
    } else if (event.type === "task.assigned") {
      const assigned = payload as Extract<TaskEventPayload, { assigneeId: string | undefined }>;
      current.assigneeId = assigned.assigneeId;
      if (assigned.assigneeId !== undefined) current.participantIds = addUnique(current.participantIds, assigned.assigneeId);
      current.updatedAt = event.createdAt;
    } else if (event.type === "task.status-changed") {
      const changed = payload as { taskId: string; from: TaskStatus; to: TaskStatus; cancelledBy?: string };
      if (current.status !== changed.from || (!isValidTransition(changed.from, changed.to) && changed.to !== "cancelled")) continue;
      current.status = changed.to;
      if (changed.to === "cancelled") {
        current.cancelledAt = event.createdAt;
        current.cancelledBy = changed.cancelledBy;
      }
      current.updatedAt = event.createdAt;
    } else if (event.type === "task.completed") {
      const completed = payload as Extract<TaskEventPayload, { completedBy: string }>;
      current.status = "done";
      current.completedAt = event.createdAt;
      current.completedBy = completed.completedBy;
      current.updatedAt = event.createdAt;
    }
    validateTask(current);
    accepted.push(copy(event));
  }

  return { tasks: [...tasks.values()].map(copy), events: accepted.sort(eventSort).map(copy) };
}

export class TaskStore {
  private readonly allEvents: TaskEvent[];

  constructor(events: readonly TaskEvent[] = []) {
    this.allEvents = events.map(copy);
    reduceTaskEvents(this.allEvents);
  }

  create(input: CreateTaskInput): CollaborationTask {
    requiredText(input.taskId, "taskId");
    requiredText(input.roomId, "roomId");
    const title = requiredText(input.title, "title");
    if (this.get(input.taskId, false)) throw new CollabError("EVENT_CONFLICT", "task already exists");
    const actor = normalizeMember(input.actor);
    this.append({
      eventId: input.eventId,
      roomId: input.roomId,
      type: "task.created",
      actor,
      createdAt: input.now,
      payload: { taskId: input.taskId, title, ...(input.description === undefined ? {} : { description: input.description }), participantIds: [actor.memberId], createdBy: actor.memberId },
    });
    return this.get(input.taskId);
  }

  update(input: TaskMutationInput & { title?: string; description?: string; blocked?: boolean }): CollaborationTask {
    const task = this.get(input.taskId);
    this.append({
      eventId: input.eventId,
      roomId: task.roomId,
      type: "task.updated",
      actor: normalizeMember(input.actor),
      createdAt: input.now,
      payload: {
        taskId: task.taskId,
        ...(input.title === undefined ? {} : { title: requiredText(input.title, "title") }),
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.blocked === undefined ? {} : { blocked: input.blocked }),
      },
    });
    return this.get(input.taskId);
  }

  assign(input: TaskMutationInput & { assigneeId: string | undefined }): CollaborationTask {
    const task = this.get(input.taskId);
    this.append({ eventId: input.eventId, roomId: task.roomId, type: "task.assigned", actor: normalizeMember(input.actor), createdAt: input.now, payload: { taskId: task.taskId, assigneeId: input.assigneeId } });
    return this.get(input.taskId);
  }

  addParticipant(input: TaskMutationInput & { memberId: string }): CollaborationTask {
    const task = this.get(input.taskId);
    this.append({ eventId: input.eventId, roomId: task.roomId, type: "task.updated", actor: normalizeMember(input.actor), createdAt: input.now, payload: { taskId: task.taskId, participantIds: addUnique(task.participantIds, requiredText(input.memberId, "memberId")) } });
    return this.get(input.taskId);
  }

  recordComment(input: TaskMutationInput): CollaborationTask {
    const task = this.get(input.taskId);
    const actor = normalizeMember(input.actor);
    this.append({ eventId: input.eventId, roomId: task.roomId, type: "task.updated", actor, createdAt: input.now, payload: { taskId: task.taskId, participantIds: addUnique(task.participantIds, actor.memberId) } });
    return this.get(input.taskId);
  }

  claim(input: TaskMutationInput): CollaborationTask {
    return this.assign({ ...input, assigneeId: normalizeMember(input.actor).memberId });
  }

  linkChangeSet(input: TaskMutationInput & { changeSetId: string }): CollaborationTask {
    const task = this.get(input.taskId);
    const actor = normalizeMember(input.actor);
    this.append({ eventId: input.eventId, roomId: task.roomId, type: "task.updated", actor, createdAt: input.now, payload: { taskId: task.taskId, participantIds: addUnique(task.participantIds, actor.memberId), changeSetIds: addUnique(task.changeSetIds, requiredText(input.changeSetId, "changeSetId")) } });
    return this.get(input.taskId);
  }

  setStatus(input: TaskMutationInput & { status: TaskStatus }): CollaborationTask {
    const task = this.get(input.taskId);
    if (!isValidTransition(task.status, input.status)) throw invalidInput("Task status transition is invalid", { field: "status" });
    this.append({ eventId: input.eventId, roomId: task.roomId, type: "task.status-changed", actor: normalizeMember(input.actor), createdAt: input.now, payload: { taskId: task.taskId, from: task.status, to: input.status } });
    return this.get(input.taskId);
  }

  complete(input: TaskMutationInput): CollaborationTask {
    const task = this.get(input.taskId);
    if (task.status === "done" || task.status === "cancelled") throw invalidInput("Task is already terminal", { field: "taskId" });
    if (task.status === "open") throw invalidInput("Task status must leave open before completion", { field: "status" });
    const actor = normalizeMember(input.actor);
    this.append({ eventId: input.eventId, roomId: task.roomId, type: "task.completed", actor, createdAt: input.now, payload: { taskId: task.taskId, completedBy: actor.memberId } });
    return this.get(input.taskId);
  }

  cancel(input: TaskMutationInput): CollaborationTask {
    const task = this.get(input.taskId);
    if (task.status === "done" || task.status === "cancelled") throw invalidInput("Task is already terminal", { field: "taskId" });
    const actor = normalizeMember(input.actor);
    this.append({ eventId: input.eventId, roomId: task.roomId, type: "task.status-changed", actor, createdAt: input.now, payload: { taskId: task.taskId, from: task.status, to: "cancelled", cancelledBy: actor.memberId } });
    const reduced = reduceTaskEvents(this.allEvents);
    const updated = reduced.tasks.find((entry) => entry.taskId === input.taskId);
    if (!updated) throw new CollabError("INVALID_INPUT", "task was not found");
    updated.cancelledAt = input.now ?? Date.now();
    updated.cancelledBy = actor.memberId;
    return copy(updated);
  }

  get(taskId: string, required = true): CollaborationTask {
    const task = reduceTaskEvents(this.allEvents).tasks.find((entry) => entry.taskId === taskId);
    if (!task && required) throw new CollabError("INVALID_INPUT", "task was not found");
    return copy(task as CollaborationTask);
  }

  events(roomId?: string): TaskEvent[] {
    return this.allEvents.filter((event) => roomId === undefined || event.roomId === roomId).sort(eventSort).map(copy);
  }

  snapshot(): TaskStoreSnapshot {
    return { version: 1, events: this.events() };
  }

  static fromSnapshot(snapshot: TaskStoreSnapshot): TaskStore {
    if (snapshot.version !== 1 || !Array.isArray(snapshot.events)) throw invalidInput("Task snapshot is invalid", { field: "snapshot" });
    return new TaskStore(snapshot.events);
  }

  private append(input: { eventId: string; roomId: string; type: TaskEventType; actor: TaskMember; createdAt?: number; payload: TaskEventPayload }): void {
    const existing = this.allEvents.find((event) => event.eventId === input.eventId);
    if (existing) {
      if (JSON.stringify(existing.payload) === JSON.stringify(input.payload) && existing.type === input.type && existing.roomId === input.roomId) return;
      throw new CollabError("EVENT_CONFLICT", "event conflict");
    }
    const roomEvents = this.allEvents.filter((event) => event.roomId === input.roomId);
    this.allEvents.push({ eventId: requiredText(input.eventId, "eventId"), roomId: input.roomId, seq: roomEvents.length + 1, type: input.type, actor: normalizeMember(input.actor), createdAt: input.createdAt ?? Date.now(), payload: copy(input.payload) });
  }
}
