import type { ReactNode } from "react";

export const COLLAB_PANEL_ID = "dsh-collab:room";

export interface CollabPanelRenderScope {
  sessionId: string;
  cwd?: string;
  visible: boolean;
}

export interface CollabPanelOpenTarget {
  sessionId: string;
  cwd?: string;
}

export interface CollabPanelDefinition {
  id: string;
  title: string | (() => string);
  render(scope: CollabPanelRenderScope): ReactNode;
}

export interface CollabPanelHost {
  register(panel: CollabPanelDefinition): () => void;
  open(target: CollabPanelOpenTarget): void;
}
