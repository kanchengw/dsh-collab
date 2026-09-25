import { createElement, type ReactNode } from "react";
import type { CollabPanelHost, CollabPanelOpenTarget, CollabPanelRenderScope } from "./collab-panel-host.js";
import { COLLAB_PANEL_ID } from "./collab-panel-host.js";
import { DshCollabRoomsPanelIcon } from "./collab-rooms.js";

export const COLLAB_ROOMS_PANEL_ID = "dsh-collab-rooms";
export const COLLAB_RIGHT_TAB_ID = "dsh-collab/right";
export const COLLAB_RIGHT_TAB_KIND = "dsh-collab";

export interface DshLayoutPanelPort {
  selectPanel(id: string | null): void;
}

export interface DshSidebarRightPort {
  openTab(kind: string, options?: { revealIfOpened?: boolean }): void;
}

export interface DshSidebarRightTabsPort {
  register(definition: {
    id: string;
    kind: string;
    priority?: "extension" | "builtin" | "fallback";
    title: (address: string) => string;
    guide?: readonly {
      id: string;
      order: number;
      title: () => string;
      description?: () => string;
    }[];
  }): () => void;
}

export interface DshSidebarRightTabProps {
  sessionId?: string;
  useTabInfo?: () => { tab: { visible: boolean } };
}

/** Select the official global Collab Rooms panel, with a legacy fallback for older shells. */
export function openOfficialCollabRooms(layout?: DshLayoutPanelPort, fallback?: () => void): void {
  if (layout) {
    try {
      layout.selectPanel(COLLAB_ROOMS_PANEL_ID);
      return;
    } catch {
      // The official panel may still be registering during plugin startup.
    }
  }
  fallback?.();
}

const SIDEBAR_SURFACE_RETRY_MS = 16;
const SIDEBAR_SURFACE_MAX_RETRIES = 120;

function isMissingSessionSurface(error: unknown): boolean {
  return error instanceof Error && error.message === "sidebarRight: no session surface is mounted";
}

/** Adapt the official right Sidebar navigation to the existing panel contract. */
export function createOfficialCollabPanelHost(
  sidebarRight: DshSidebarRightPort,
  selectSession?: (sessionId: string) => void,
  selectPanel?: (id: string | null) => void,
): CollabPanelHost {
  let openRequest = 0;

  return {
    register: () => () => {},
    open: (target: CollabPanelOpenTarget) => {
      const request = ++openRequest;
      selectSession?.(target.sessionId);
      selectPanel?.(null);
      const attempt = (remaining: number): void => {
        if (request !== openRequest) return;
        try {
          sidebarRight.openTab(COLLAB_RIGHT_TAB_KIND, { revealIfOpened: true });
        } catch (error) {
          if (!isMissingSessionSurface(error)) throw error;
          if (remaining === 0) {
            console.error("dsh-collab: the DSH Session surface did not mount in time", error);
            return;
          }
          setTimeout(() => { attempt(remaining - 1); }, SIDEBAR_SURFACE_RETRY_MS);
        }
      };
      setTimeout(() => { attempt(SIDEBAR_SURFACE_MAX_RETRIES); }, 0);
    },
  };
}

export function registerOfficialCollabSidebar(input: {
  context: {
    slots: {
      inject(name: string, register: () => unknown): unknown;
      register(options: Record<string, unknown>, component: (props: Record<string, unknown>) => ReactNode): () => void;
    };
    effect?(callback: () => void | (() => void), label?: string): unknown;
  };
  layout?: DshLayoutPanelPort;
  sidebarRight?: DshSidebarRightPort;
  sidebarRightTabs?: DshSidebarRightTabsPort;
  roomPanel: (embedded: boolean) => ReactNode;
  rightPanel: (props: DshSidebarRightTabProps) => ReactNode;
  label: string;
  guideDescription?: () => string;
}): void {
  const { context } = input;
  if (input.layout) {
    context.slots.inject("sidebar.panellist", () => context.slots.register(
      { name: "sidebar.panellist", id: COLLAB_ROOMS_PANEL_ID, order: 20, label: input.label },
      () => createElement(DshCollabRoomsPanelIcon),
    ));
    context.slots.inject("main", () => context.slots.register(
      { name: "main", key: COLLAB_ROOMS_PANEL_ID },
      () => input.roomPanel(true),
    ));
  }

  if (input.sidebarRight && input.sidebarRightTabs) {
    const register = (): (() => void) => {
      const disposeType = input.sidebarRightTabs!.register({
        id: COLLAB_RIGHT_TAB_ID,
        kind: COLLAB_RIGHT_TAB_KIND,
        priority: "extension",
        title: () => input.label,
        guide: [{
          id: "rooms",
          order: 20,
          title: () => input.label,
          description: input.guideDescription ?? (() => input.label),
        }],
      });
      const disposeBody = context.slots.inject("sidebar.right.pane.tab", () => context.slots.register(
        { name: "sidebar.right.pane.tab", key: COLLAB_RIGHT_TAB_ID },
        (props) => input.rightPanel(props as DshSidebarRightTabProps),
      ));
      return () => { (disposeBody as (() => void) | undefined)?.(); disposeType(); };
    };
    if (context.effect) context.effect(register, "dsh-collab: official sidebar embedding");
    else register();
  }
}

export function collabPanelScopeFromTab(props: DshSidebarRightTabProps, cwd?: string): CollabPanelRenderScope | undefined {
  if (!props.sessionId) return undefined;
  return {
    sessionId: props.sessionId,
    ...(cwd === undefined ? {} : { cwd }),
    visible: props.useTabInfo?.().tab.visible ?? true,
  };
}

export { COLLAB_PANEL_ID };
