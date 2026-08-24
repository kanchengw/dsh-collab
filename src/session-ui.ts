export interface CollabSessionViewState {
  roomTitle: string;
  roomId: string;
  role: "host" | "participant";
  connection: "connecting" | "online" | "offline";
}

export function renderCollabSession(state: CollabSessionViewState): string {
  return `<section data-collab-session data-role="${state.role}" data-connection="${state.connection}" data-room-id="${state.roomId}"><h1>${state.roomTitle}</h1></section>`;
}
