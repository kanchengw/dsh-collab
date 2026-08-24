import { renderComposer, renderTimeline, type ComposerState, type HostRoomMemberView, type TimelineItem } from "./ui.js";

export interface CollabSessionViewState {
  roomTitle: string;
  roomId: string;
  hostDisplayName: string;
  role: "host" | "participant";
  connection: "connecting" | "online" | "offline";
  memberCount: number;
  members: HostRoomMemberView[];
  timeline: TimelineItem[];
  composer: ComposerState;
  loading?: boolean;
  error?: string;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}

function renderMembers(members: HostRoomMemberView[]): string {
  return members.map((member) => `<li data-member-id="${escapeHtml(member.memberId)}" data-status="${member.status}"><span>${escapeHtml(member.displayName)}</span><small>${member.role} | ${member.status}</small></li>`).join("");
}

/** Token layer for the standalone HTML adapter; DSH skins may override variables. */
export const COLLAB_SESSION_CSS = ".collab-session{--collab-ink:#17211b;--collab-muted:#627066;--collab-line:#d8e0d8;--collab-paper:#f7faf5;--collab-accent:#e56b3f;color:var(--collab-ink);background:var(--collab-paper);display:grid;grid-template-columns:12rem minmax(0,1fr) 15rem;min-height:32rem;font:14px/1.45 ui-sans-serif,system-ui,sans-serif}.collab-session__rail,.collab-session__members{padding:1rem;border-right:1px solid var(--collab-line)}.collab-session__members{border-right:0;border-left:1px solid var(--collab-line)}.collab-session__main{min-width:0;display:flex;flex-direction:column}.collab-session__header{display:flex;align-items:center;gap:.6rem;padding:1rem;border-bottom:1px solid var(--collab-line);background:#fff}.collab-session__header h1{margin:0;font-size:1.05rem}.collab-session__badge{border-radius:999px;padding:.2rem .55rem;background:#e9f0e8;font-size:.75rem;font-weight:700}.collab-session__connection{margin-left:auto;color:var(--collab-muted)}.collab-session__timeline{flex:1;padding:1rem;overflow:auto}.collab-session__composer{padding:1rem;border-top:1px solid var(--collab-line);background:#fff}.collab-session__members ul{padding:0;list-style:none}.collab-session__members li{display:flex;flex-direction:column;padding:.55rem 0;border-bottom:1px solid var(--collab-line)}.collab-session__members small{color:var(--collab-muted)}.collab-session__error{color:#9f2d1e;background:#fff0ed;padding:.6rem 1rem}.collab-session__status{padding:.35rem 1rem;color:var(--collab-muted);font-size:.8rem}@media(max-width:800px){.collab-session{display:block}.collab-session__rail,.collab-session__members{display:none}.collab-session__header{position:sticky;top:0;z-index:1}.collab-session__timeline{min-height:18rem}}";

export function renderCollabSession(state: CollabSessionViewState): string {
  const roomTitle = escapeHtml(state.roomTitle);
  const roomId = escapeHtml(state.roomId);
  const host = escapeHtml(state.hostDisplayName);
  const stateLabel = state.loading ? "loading" : state.connection;
  const status = state.loading ? `<div class="collab-session__status" data-state="loading" role="status">Loading room...</div>` : "";
  const offline = state.connection === "offline" ? `<div class="collab-session__status" data-state="offline" role="status">Offline - reconnecting</div>` : "";
  const error = state.error ? `<p class="collab-session__error" role="alert">${escapeHtml(state.error)}</p>` : "";
  const hostControls = state.role === "host" ? `<button type="button" data-action="invite">Invite</button>` : "";
  return [
    `<section class="collab-session" data-collab-mode="${state.role}" data-room-id="${roomId}" data-state="${stateLabel}">`,
    `<aside class="collab-session__rail" aria-label="Room navigation"><strong>Room</strong><p>${roomTitle}</p><small>${state.memberCount} members</small></aside>`,
    `<main class="collab-session__main">`,
    `<header class="collab-session__header"><h1>${roomTitle}</h1><span class="collab-session__badge">${state.role === "host" ? "Host" : "Participant"}</span><span>Hosted by ${host}</span><span class="collab-session__connection" data-connection="${state.connection}">${state.connection}</span>${hostControls}</header>`,
    status,
    offline,
    error,
    `<div class="collab-session__timeline" aria-live="polite">${renderTimeline(state.timeline)}</div>`,
    `<div class="collab-session__composer">${renderComposer(state.composer)}</div>`,
    `</main>`,
    `<aside class="collab-session__members" aria-label="Collaborators"><h2>Collaborators</h2><ul>${renderMembers(state.members)}</ul></aside>`,
    `</section>`,
  ].join("");
}
