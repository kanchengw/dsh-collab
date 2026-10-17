import type { AgentOutputFrame, AgentQueueItem, MessageInput, MessageTarget, RoomEvent } from "./types.js";

export type ComposerTarget = MessageTarget;

export interface ComposerMentionMember {
  memberId: string;
  displayName: string;
}

export interface CollabUnreadCounts {
  personal: number;
  total: number;
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

function mentionQuery(draft: string, cursorPosition = draft.length): string | undefined {
  const beforeCursor = draft.slice(0, cursorPosition);
  const match = beforeCursor.match(/(?:^|[^A-Za-z0-9_@])@([^\s@]*)$/);
  return match?.[1];
}

export function shouldSuggestMemberMention(draft: string, cursorPosition = draft.length): boolean {
  return mentionQuery(draft, cursorPosition) !== undefined;
}

export function composerMentionSuggestions(draft: string, members: readonly ComposerMentionMember[], cursorPosition = draft.length): ComposerMentionMember[] {
  const query = mentionQuery(draft, cursorPosition)?.toLocaleLowerCase();
  if (query === undefined) return [];
  return members.filter((member) => member.displayName.toLocaleLowerCase().startsWith(query));
}

export function composerMentionMenuKeyAction(input: { key: string; selectedIndex: number; optionCount: number }):
  { kind: "move"; selectedIndex: number } | { kind: "select"; selectedIndex: number } | { kind: "close" } | { kind: "native" } {
  if (input.optionCount === 0) return { kind: "native" };
  if (input.key === "ArrowDown") return { kind: "move", selectedIndex: (input.selectedIndex + 1) % input.optionCount };
  if (input.key === "ArrowUp") return { kind: "move", selectedIndex: (input.selectedIndex - 1 + input.optionCount) % input.optionCount };
  if (input.key === "Enter") return { kind: "select", selectedIndex: Math.max(0, Math.min(input.selectedIndex, input.optionCount - 1)) };
  if (input.key === "Escape") return { kind: "close" };
  return { kind: "native" };
}

export function insertMemberMention(draft: string, member: ComposerMentionMember, cursorPosition = draft.length): string {
  const query = mentionQuery(draft, cursorPosition);
  if (query === undefined) return draft;
  const start = cursorPosition - query.length - 1;
  return `${draft.slice(0, start)}@${member.displayName} ${draft.slice(cursorPosition)}`;
}

function escapedRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractComposerMentionIds(text: string, members: readonly ComposerMentionMember[]): string[] {
  return members
    .map((member) => ({ member, match: new RegExp(`(?:^|[^A-Za-z0-9_@])@${escapedRegExp(member.displayName)}(?![A-Za-z0-9_])`, "iu").exec(text) }))
    .filter((entry): entry is { member: ComposerMentionMember; match: RegExpExecArray } => entry.match !== null)
    .sort((left, right) => left.match.index - right.match.index)
    .map((entry) => entry.member.memberId);
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
  mentions?: string[];
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
    ...(!agentTarget && input.mentions && input.mentions.length > 0 ? { mentions: [...input.mentions] } : {}),
  };
}

export function composerTargetForGesture(text: string, agentBusy: boolean, shiftKey: boolean): ComposerTarget {
  if (shiftKey && agentBusy && composerTargetForText(text) === "dsh") return "dsh-steer";
  return composerTargetForText(text);
}

export function projectCollabUnread(events: readonly RoomEvent[], currentMemberId?: string): CollabUnreadCounts {
  let personal = 0;
  let total = 0;
  for (const event of events) {
    if (currentMemberId !== undefined && event.actor.memberId === currentMemberId) continue;
    total += 1;
    const payload = objectPayload(event.payload);
    if (currentMemberId !== undefined && Array.isArray(payload.mentions) && payload.mentions.includes(currentMemberId)) personal += 1;
  }
  return { personal, total };
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
