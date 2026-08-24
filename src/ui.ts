export type ParticipantConnection = "connecting" | "online" | "offline";

export interface ParticipantShellState {
  roomId: string;
  roomTitle: string;
  hostDisplayName: string;
  connection: ParticipantConnection;
  memberCount: number;
  error?: string;
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
