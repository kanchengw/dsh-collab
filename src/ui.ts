import type { MessageInput, MessageTarget } from "./types.js";

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
