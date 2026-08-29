import type { AgentOutputFrame, AgentQueueItem, MemberRole, MemberStatus, MessageInput, MessageTarget, RoomEvent, RoomState } from "./types.js";

export type ParticipantConnection = "connecting" | "online" | "offline";
export type ComposerTarget = MessageTarget;

export interface ParticipantShellState {
  roomId: string;
  roomTitle: string;
  hostDisplayName: string;
  connection: ParticipantConnection;
  memberCount: number;
  error?: string;
}

export interface ComposerState {
  target?: ComposerTarget;
  canSteer?: boolean;
  draft: string;
}

export type TimelineAgentStatus = "accepted" | "queued" | "running" | "completed" | "failed" | "cancelled" | "withdrawn";

export interface TimelineItem {
  eventId: string;
  contextEventId?: string;
  seq: number;
  kind: "human" | "agent-request" | "agent";
  authorMemberId: string;
  text?: string;
  requestId?: string;
  status?: TimelineAgentStatus;
  state?: string;
  streaming?: boolean;
}

export interface HostRoomMemberView {
  memberId: string;
  displayName: string;
  role: MemberRole;
  status: MemberStatus;
}

export interface HostRoomManagementState {
  roomId: string;
  roomTitle: string;
  roomState: RoomState;
  hostSessionId: string;
  canManage: boolean;
  members: HostRoomMemberView[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

export function renderParticipantShell(state: ParticipantShellState): string {
  const title = escapeHtml(state.roomTitle);
  const host = escapeHtml(state.hostDisplayName);
  const roomId = escapeHtml(state.roomId);
  const memberLabel = state.memberCount === 0 ? "No collaborators yet" : `${String(state.memberCount)} members`;
  const error = state.error ? `<p class="collab-error" role="alert">${escapeHtml(state.error)}</p>` : "";
  return [
    `<section class="collab-shell" data-collab-mode="participant" data-room-id="${roomId}" data-connection="${state.connection}">`,
    `<header class="collab-shell__header"><h1>${title}</h1><p>Hosted by ${host}</p><span>${state.connection}</span></header>`,
    `<div class="collab-shell__members" aria-label="Collaborators">${memberLabel}</div>`,
    `<div class="collab-shell__timeline" data-empty="${state.memberCount === 0 ? "true" : "false"}"></div>`,
    error,
    "</section>",
  ].join("");
}

export function getComposerTargets(canSteer: boolean): ComposerTarget[] {
  return canSteer ? ["room", "dsh", "dsh-steer"] : ["room", "dsh"];
}

export const AGENT_MENTION = "@agent";

/** Resolve the shared composer route without treating email-like text as a mention. */
export function composerTargetForText(text: string): Exclude<ComposerTarget, "dsh-steer"> {
  return /(?:^|[^A-Za-z0-9_])@agent(?![A-Za-z0-9_])/.test(text) ? "dsh" : "room";
}

export function shouldSuggestAgentMention(draft: string): boolean {
  return /(?:^|[^A-Za-z0-9_])@$/.test(draft);
}

export function insertAgentMention(draft: string): string {
  return shouldSuggestAgentMention(draft) ? `${draft.slice(0, -1)}${AGENT_MENTION} ` : draft;
}

export function composerKeyAction(input: {
  key: string;
  shiftKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
  repeat?: boolean;
}): "native" | "submit" | "suppress" {
  if (input.key !== "Enter" || input.shiftKey || input.isComposing || input.keyCode === 229) return "native";
  return input.repeat ? "suppress" : "submit";
}

export function createComposerSubmission(input: {
  messageId: string;
  roomId: string;
  authorMemberId: string;
  text: string;
  target: ComposerTarget;
  canSteer?: boolean;
  sourceMessageId?: string;
  contextRefs?: string[];
}): MessageInput {
  if (input.target === "dsh-steer" && input.canSteer !== true) {
    throw new Error("steer target requires capability");
  }
  const agentTarget = input.target === "dsh" || input.target === "dsh-steer";
  return {
    messageId: input.messageId,
    roomId: input.roomId,
    authorMemberId: input.authorMemberId,
    text: input.text,
    target: input.target,
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(agentTarget && input.contextRefs && input.contextRefs.length > 0 ? { contextRefs: [...input.contextRefs] } : {}),
  };
}

export function composerTargetForGesture(text: string, agentBusy: boolean, shiftKey: boolean): ComposerTarget {
  if (shiftKey && agentBusy && composerTargetForText(text) === "dsh") return "dsh-steer";
  return composerTargetForText(text);
}

export function renderComposer(state: ComposerState): string {
  const suggestion = shouldSuggestAgentMention(state.draft) ? `<button type="button" data-mention="${AGENT_MENTION}">${AGENT_MENTION}</button>` : "";
  return `<form class="collab-composer" data-target="${composerTargetForText(state.draft)}"><textarea name="text" placeholder="Message the room or mention @agent to ask the Host Agent">${escapeHtml(state.draft)}</textarea>${suggestion}</form>`;
}

function objectPayload(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function payloadText(payload: Record<string, unknown>): string | undefined {
  return typeof payload.text === "string" ? payload.text : undefined;
}

function payloadRequestId(payload: Record<string, unknown>): string | undefined {
  return typeof payload.requestId === "string" ? payload.requestId : undefined;
}

export function projectTimeline(events: RoomEvent[], activeAgentOutputs: readonly AgentOutputFrame[] = []): TimelineItem[] {
  const seen = new Set<string>();
  const items: TimelineItem[] = [];
  const requests = new Map<string, TimelineItem>();
  const outputs = new Map<string, TimelineItem>();
  const settledRequests = new Set<string>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const payload = objectPayload(event.payload);
    if (event.type === "human.message") {
      const item: TimelineItem = {
        eventId: event.eventId,
        contextEventId: event.eventId,
        seq: event.seq,
        kind: "human",
        authorMemberId: event.actor.memberId,
        text: payloadText(payload),
      };
      items.push(item);
      continue;
    }
    if (event.type === "agent.state.changed") {
      const requestId = payloadRequestId(payload) ?? "state:" + event.eventId;
      settledRequests.add(requestId);
      const item = outputs.get(requestId) ?? {
        eventId: event.eventId,
        seq: event.seq,
        kind: "agent" as const,
        authorMemberId: event.actor.memberId,
        requestId,
      };
      item.seq = event.seq;
      item.state = typeof payload.state === "string" ? payload.state : undefined;
      const text = payloadText(payload);
      if (text !== undefined) {
        item.text = text;
        item.contextEventId = event.eventId;
      }
      item.streaming = false;
      if (!outputs.has(requestId)) {
        outputs.set(requestId, item);
        items.push(item);
      }
      continue;
    }
    if (event.type === "agent.request.edited") {
      const requestId = payloadRequestId(payload);
      const item = requestId ? requests.get(requestId) : undefined;
      if (item) {
        item.seq = event.seq;
        item.text = payloadText(payload);
        item.contextEventId = event.eventId;
      }
      continue;
    }
    const statusByType: Partial<Record<RoomEvent["type"], TimelineAgentStatus>> = {
      "agent.request.created": "accepted",
      "agent.request.queued": "queued",
      "agent.request.claimed": "running",
      "agent.request.completed": "completed",
      "agent.request.failed": "failed",
      "agent.request.rejected": "failed",
      "agent.request.cancelled": "cancelled",
      "agent.request.withdrawn": "withdrawn",
    };
    const status = statusByType[event.type];
    if (!status) continue;
    const requestId = payloadRequestId(payload) ?? event.eventId;
    if (status === "completed" || status === "failed" || status === "cancelled") settledRequests.add(requestId);
    const item = requests.get(requestId) ?? {
      eventId: event.eventId,
      seq: event.seq,
      kind: "agent-request" as const,
      authorMemberId: event.actor.memberId,
      requestId,
    };
    item.status = status;
    const text = payloadText(payload);
    if (text !== undefined) {
      item.text = text;
      item.contextEventId = event.eventId;
    }
    if (!requests.has(requestId)) {
      requests.set(requestId, item);
      items.push(item);
    }
    if (status === "failed" && typeof payload.error === "string") {
      const failureKey = requestId + ":failure";
      const failure = outputs.get(failureKey) ?? {
        eventId: event.eventId + ":detail",
        contextEventId: event.eventId,
        seq: event.seq,
        kind: "agent" as const,
        authorMemberId: event.actor.memberId,
        requestId,
      };
      failure.seq = event.seq;
      failure.state = "failed";
      failure.text = payload.error;
      failure.streaming = false;
      if (!outputs.has(failureKey)) {
        outputs.set(failureKey, failure);
        items.push(failure);
      }
    }
  }
  let streamSeq = 0;
  for (const event of events) streamSeq = Math.max(streamSeq, event.seq);
  const roomId = events[0]?.roomId;
  for (const output of activeAgentOutputs) {
    if (roomId !== undefined && output.roomId !== roomId) continue;
    if (!output.streaming || settledRequests.has(output.requestId)) continue;
    streamSeq += 1;
    items.push({
      eventId: "stream:" + output.requestId,
      seq: streamSeq,
      kind: "agent",
      authorMemberId: "agent",
      requestId: output.requestId,
      state: "output",
      text: output.text,
      streaming: true,
    });
  }
  return items.sort((left, right) => left.seq - right.seq).map((item) => ({ ...item }));
}

export function projectAgentQueue(events: RoomEvent[]): AgentQueueItem[] {
  const queue = new Map<string, Omit<AgentQueueItem, "position">>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const payload = objectPayload(event.payload);
    const requestId = payloadRequestId(payload);
    if (!requestId) continue;
    if (event.type === "agent.request.created") {
      if (typeof payload.text !== "string" || typeof payload.messageId !== "string" || (payload.deliveryMode !== "followup" && payload.deliveryMode !== "steer")) continue;
      queue.set(requestId, {
        requestId,
        messageId: payload.messageId,
        roomId: event.roomId,
        authorMemberId: event.actor.memberId,
        text: payload.text,
        deliveryMode: payload.deliveryMode,
        status: "queued",
        queueSeq: Number.MAX_SAFE_INTEGER,
        priority: payload.priority === "host" ? "host" : "participant",
      });
      continue;
    }
    const item = queue.get(requestId);
    if (!item) continue;
    if (event.type === "agent.request.queued") {
      if (typeof payload.queueSeq === "number" && Number.isSafeInteger(payload.queueSeq)) item.queueSeq = payload.queueSeq;
    } else if (event.type === "agent.request.claimed") {
      item.status = "running";
    } else if (event.type === "agent.request.edited") {
      if (typeof payload.text === "string") item.text = payload.text;
    } else if (event.type === "agent.request.completed" || event.type === "agent.request.failed"
      || event.type === "agent.request.rejected" || event.type === "agent.request.cancelled" || event.type === "agent.request.withdrawn") {
      queue.delete(requestId);
    }
  }
  return [...queue.values()]
    .sort((left, right) => ((right.priority === "host" ? 1 : 0) - (left.priority === "host" ? 1 : 0)) || left.queueSeq - right.queueSeq)
    .map((item, index) => ({ ...item, position: index + 1 }));
}

export function renderTimeline(items: TimelineItem[]): string {
  return `<div class="collab-timeline">${items.map((item) => {
    const status = item.status ? ` data-status="${item.status}"` : "";
    const state = item.state ? ` data-state="${escapeHtml(item.state)}"` : "";
    const text = item.text ? escapeHtml(item.text) : "";
    return `<article class="collab-timeline__item" data-kind="${item.kind}" data-seq="${String(item.seq)}"${status}${state}>${text}</article>`;
  }).join("")}</div>`;
}

export function renderHostRoomManagement(state: HostRoomManagementState): string {
  const members = state.members.map((member) => {
    const controls = state.canManage && member.role !== "host"
      ? `<button data-action="suspend" data-member-id="${escapeHtml(member.memberId)}">Suspend</button><button data-action="remove" data-member-id="${escapeHtml(member.memberId)}">Remove</button>`
      : "";
    return `<li data-member-id="${escapeHtml(member.memberId)}" data-status="${member.status}"><span>${escapeHtml(member.displayName)}</span><small>${member.role} · ${member.status}</small>${controls}</li>`;
  }).join("");
  const invite = state.canManage ? `<button data-action="invite">Invite</button>` : "";
  return `<section class="collab-host-management" data-room-id="${escapeHtml(state.roomId)}" data-room-state="${state.roomState}"><header><h2>${escapeHtml(state.roomTitle)}</h2><p>Host Agent session: <code>${escapeHtml(state.hostSessionId)}</code></p>${invite}</header><ul>${members}</ul></section>`;
}
