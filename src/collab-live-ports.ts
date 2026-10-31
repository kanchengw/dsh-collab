import type { DshCollabClientPort } from "./dsh-client.js";
import { reduceTaskEvents, TaskStore } from "./tasks.js";
import { reduceDecisionEvents, DecisionStore } from "./decisions.js";
import type { DecisionEvent, TaskEvent } from "./collaboration-types.js";
import type { RoomEvent } from "./types.js";
import type { CollabActivityItem } from "./collab-activity.js";
import { projectCollabActivity } from "./collab-activity.js";
import type { CollabDiscussionMessage, CollabDiscussionScope, CollabDiscussionViewPort } from "./collab-discussion.js";
import type { CollabTaskItem, CollabTasksPort, CollabTasksSnapshot } from "./collab-tasks.js";

function taskEvents(events: readonly RoomEvent[]): TaskEvent[] {
  return TaskStore.fromRoomEvents(events).events();
}

function decisionEvents(events: readonly RoomEvent[]): DecisionEvent[] {
  return events
    .filter((event): event is RoomEvent & { type: DecisionEvent["type"] } => event.type === "decision.proposed" || event.type === "decision.accepted" || event.type === "decision.superseded")
    .map((event) => ({ eventId: event.eventId, roomId: event.roomId, seq: event.seq, type: event.type, actor: event.actor, createdAt: event.createdAt, payload: event.payload as DecisionEvent["payload"] }));
}

function roomMatches(client: DshCollabClientPort, roomId: string): boolean {
  return client.getSnapshot().roomId === roomId;
}

function decisionMatchesTask(scope: string, taskId: string): boolean {
  return scope.startsWith("task:") && scope.slice("task:".length).split(",").includes(taskId);
}

function linkedChangeSets(events: readonly RoomEvent[]): Map<string, { changeSetId: string; roomId: string; title: string; status: string }> {
  const result = new Map<string, { changeSetId: string; roomId: string; title: string; status: string }>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const payload = event.payload as { changeSetId?: unknown; title?: unknown; outcome?: unknown; application?: { changeSetId?: unknown } };
    const id = typeof payload.changeSetId === "string" ? payload.changeSetId : payload.application?.changeSetId;
    if (typeof id !== "string") continue;
    const current = result.get(id);
    if (event.type === "changeset.submitted") {
      result.set(id, { changeSetId: id, roomId: event.roomId, title: typeof payload.title === "string" ? payload.title : id, status: "submitted" });
    } else if (event.type === "changeset.review-assigned" && current) {
      current.status = "in-review";
    } else if (event.type === "changeset.review-decided" && current) {
      current.status = payload.outcome === "approved" ? "approved" : "changes-requested";
    } else if (event.type === "changeset.applied" && current) {
      current.status = "applied";
    }
  }
  return result;
}

export function createCollabTasksPort(client: DshCollabClientPort): CollabTasksPort {
  let selectedTaskId: string | undefined;
  const listeners = new Set<() => void>();
  const emit = (): void => { for (const listener of listeners) listener(); };
  const port: CollabTasksPort = {
    getSnapshot(): CollabTasksSnapshot {
      const snapshot = client.getSnapshot();
      const members = snapshot.members ?? [];
      const currentMemberId = snapshot.memberId ?? members[0]?.memberId ?? "";
      const taskProjection = reduceTaskEvents(taskEvents(snapshot.roomEvents ?? [])).tasks;
      const decisions = reduceDecisionEvents(decisionEvents(snapshot.roomEvents ?? [])).decisions;
      const discussion = (snapshot.roomEvents ?? [])
        .filter((event) => event.type === "human.message")
        .map((event) => {
          const payload = event.payload as { messageId?: string; authorMemberId?: string; text?: string; scope?: string };
          return { messageId: payload.messageId ?? event.eventId, authorId: payload.authorMemberId ?? event.actor.memberId, text: payload.text ?? "", scope: payload.scope };
        });
      const changeSetsByRoom = linkedChangeSets(snapshot.roomEvents ?? []);
      const tasks: CollabTaskItem[] = taskProjection.map((task) => ({
        task,
        decisions: decisions.filter((decision) => decisionMatchesTask(decision.scope, task.taskId)),
        changeSets: [...new Set(task.changeSetIds)].flatMap((changeSetId) => {
          const changeSet = changeSetsByRoom.get(changeSetId);
          return changeSet ? [{ changeSetId: changeSet.changeSetId, roomId: changeSet.roomId, title: changeSet.title, status: changeSet.status }] : [];
        }),
        discussion: discussion.filter((message) => message.scope === `task:${task.taskId}`).map(({ messageId, authorId, text }) => ({ messageId, authorId, text })),
      }));
      return {
        roomId: snapshot.roomId,
        role: snapshot.role === "host" ? "owner" : "participant",
        currentMemberId,
        connection: snapshot.connection === "online" ? "online" : "offline",
        members,
        onlineMemberIds: snapshot.onlineMemberIds ?? [],
        tasks,
        roomDecisions: decisions.filter((decision) => decision.scope === "room"),
        availableMessageIds: discussion.map((message) => message.messageId),
        ...(selectedTaskId && tasks.some((item) => item.task.taskId === selectedTaskId) ? { selectedTaskId } : {}),
      };
    },
    subscribe(listener) {
      listeners.add(listener);
      const unsubscribe = client.subscribe(() => { emit(); });
      return () => { listeners.delete(listener); unsubscribe(); };
    },
    async refresh() { emit(); },
    async createTask(input) { await client.createTask?.(client.getSnapshot().roomId, input); emit(); },
    async selectTask(taskId) { selectedTaskId = taskId; emit(); },
    async claimTask(taskId) { await client.claimTask?.(client.getSnapshot().roomId, taskId); emit(); },
    async unassignTask(taskId) { await client.unassignTask?.(client.getSnapshot().roomId, taskId); emit(); },
    async setTaskStatus(taskId, status) { await client.setTaskStatus?.(client.getSnapshot().roomId, taskId, status); emit(); },
    async addTaskParticipant(taskId, memberId) { await client.addTaskParticipant?.(client.getSnapshot().roomId, taskId, memberId); emit(); },
    async sendDiscussion(taskId, text) { await client.send({ text, target: "room", scope: `task:${taskId}` }); emit(); },
    async proposeDecision(input) { await client.proposeDecision?.(client.getSnapshot().roomId, input); emit(); },
    async acceptDecision(decisionId) { await client.acceptDecision?.(client.getSnapshot().roomId, decisionId); emit(); },
    forRoom(roomId) { return roomMatches(client, roomId) ? port : undefined; },
  };
  return port;
}

export function createCollabDiscussionPort(client: DshCollabClientPort): CollabDiscussionViewPort {
  const listeners = new Set<() => void>();
  const port: CollabDiscussionViewPort = {
    getSnapshot() {
      const snapshot = client.getSnapshot();
      const messages: CollabDiscussionMessage[] = (snapshot.roomEvents ?? [])
        .filter((event) => event.type === "human.message")
        .map((event) => {
          const payload = event.payload as { messageId?: string; authorMemberId?: string; text?: string; scope?: string; sourceMessageId?: string; mentions?: string[] };
          const scope = payload.scope === "general" || (typeof payload.scope === "string" && /^task:[^\s]+$/.test(payload.scope)) ? payload.scope as CollabDiscussionScope : "general";
          return { messageId: payload.messageId ?? event.eventId, authorId: payload.authorMemberId ?? event.actor.memberId, text: payload.text ?? "", scope, ...(payload.sourceMessageId ? { sourceMessageId: payload.sourceMessageId } : {}), createdAt: event.createdAt, seq: event.seq };
        });
      const memberNames = new Map((snapshot.members ?? []).map((member) => [member.memberId, member.displayName]));
      const workUpdates: CollabActivityItem[] = (snapshot.roomEvents ?? []).some((event) => event.type === "work-update.published")
        ? projectCollabActivity((snapshot.roomEvents ?? []).filter((event) => event.type === "work-update.published"))
        : [];
      const scopes: Array<{ value: CollabDiscussionScope; label: string }> = [{ value: "general", label: "General" }, ...messages.flatMap((message) => message.scope.startsWith("task:") ? [{ value: message.scope, label: message.scope }] : [])];
      return { roomId: snapshot.roomId, connection: snapshot.connection === "online" ? "online" : "offline", messages, scopes: [...new Map(scopes.map((scope) => [scope.value, scope])).values()], ...(snapshot.memberId ? { currentMemberId: snapshot.memberId } : {}), memberNames, workUpdates };
    },
    subscribe(listener) {
      listeners.add(listener);
      const unsubscribe = client.subscribe(() => { for (const current of listeners) current(); });
      return () => { listeners.delete(listener); unsubscribe(); };
    },
    async send(input) {
      await client.send({ text: input.text, target: "room", sourceMessageId: input.sourceMessageId, scope: input.scope });
    },
    forRoom(roomId) { return roomMatches(client, roomId) ? port : undefined; },
  };
  return port;
}
