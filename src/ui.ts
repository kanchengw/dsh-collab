import type { MessageInput, MessageTarget, RoomEvent } from "./types.js";

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
  target: ComposerTarget;
  canSteer: boolean;
  draft: string;
}

export type TimelineAgentStatus = "accepted" | "queued" | "running" | "completed" | "failed" | "cancelled";

export interface TimelineItem {
  eventId: string;
  seq: number;
  kind: "human" | "agent";
  authorMemberId: string;
  text?: string;
  requestId?: string;
  status?: TimelineAgentStatus;
  state?: string;
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
  return {
    messageId: input.messageId,
    roomId: input.roomId,
    authorMemberId: input.authorMemberId,
    text: input.text,
    target: input.target,
    ...(input.sourceMessageId ? { sourceMessageId: input.sourceMessageId } : {}),
    ...(input.contextRefs ? { contextRefs: [...input.contextRefs] } : {}),
  };
}

export function renderComposer(state: ComposerState): string {
  const options = getComposerTargets(state.canSteer).map((target) => {
    const label = target === "room" ? "People" : target === "dsh" ? "DSH Agent" : "Steer Agent";
    return `<option value="${target}"${target === state.target ? " selected" : ""}>${label}</option>`;
  }).join("");
  return `<form class="collab-composer" data-target="${state.target}"><label>Send to <select name="target">${options}</select></label><textarea name="text">${escapeHtml(state.draft)}</textarea></form>`;
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

export function projectTimeline(events: RoomEvent[]): TimelineItem[] {
  const seen = new Set<string>();
  const items: TimelineItem[] = [];
  const requests = new Map<string, TimelineItem>();
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (seen.has(event.eventId)) continue;
    seen.add(event.eventId);
    const payload = objectPayload(event.payload);
    if (event.type === "human.message") {
      const item: TimelineItem = {
        eventId: event.eventId,
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
      const item = requests.get(requestId) ?? {
        eventId: event.eventId,
        seq: event.seq,
        kind: "agent" as const,
        authorMemberId: event.actor.memberId,
        requestId,
      };
      item.seq = event.seq;
      item.state = typeof payload.state === "string" ? payload.state : undefined;
      item.text = payloadText(payload) ?? item.text;
      if (!requests.has(requestId)) {
        requests.set(requestId, item);
        items.push(item);
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
    };
    const status = statusByType[event.type];
    if (!status) continue;
    const requestId = payloadRequestId(payload) ?? event.eventId;
    const item = requests.get(requestId) ?? {
      eventId: event.eventId,
      seq: event.seq,
      kind: "agent" as const,
      authorMemberId: event.actor.memberId,
      requestId,
    };
    item.seq = event.seq;
    item.status = status;
    if (!requests.has(requestId)) {
      requests.set(requestId, item);
      items.push(item);
    }
  }
  return items.sort((left, right) => left.seq - right.seq).map((item) => ({ ...item }));
}

export function renderTimeline(items: TimelineItem[]): string {
  return `<div class="collab-timeline">${items.map((item) => {
    const status = item.status ? ` data-status="${item.status}"` : "";
    const state = item.state ? ` data-state="${escapeHtml(item.state)}"` : "";
    const text = item.text ? escapeHtml(item.text) : "";
    return `<article class="collab-timeline__item" data-kind="${item.kind}" data-seq="${String(item.seq)}"${status}${state}>${text}</article>`;
  }).join("")}</div>`;
}
