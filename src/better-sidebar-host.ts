import type { ReactNode } from "react";
import type {
  CollabPanelDefinition,
  CollabPanelHost,
  CollabPanelOpenTarget,
} from "./collab-panel-host.js";

export const BETTER_SIDEBAR_MIN_VERSION = "0.17.1";
export const BETTER_SIDEBAR_REQUIRED_FEATURES = ["targetedOpen"] as const;

export interface BetterSidebarTabDescriptor {
  id: string;
  title: string | (() => string);
  single: true;
  component(props: {
    scope: { sessionId: string; cwd?: string };
    visible: boolean;
  }): ReactNode;
}

export interface BetterSidebarServicePort {
  readonly version: string;
  readonly features: readonly string[];
  registerTab(descriptor: BetterSidebarTabDescriptor): () => void;
  openTab(
    seed: { type: string; url?: string },
    scope?: { sessionId: string; cwd?: string },
  ): void;
  getSnapshot?(): { sessionId?: string; cwd?: string };
}

export type BetterSidebarHostResolution =
  | { kind: "missing"; requiredVersion: string }
  | { kind: "incompatible"; reason: "service" | "version" | "features"; requiredVersion: string; actualVersion?: string; missingFeatures?: string[] }
  | { kind: "ready"; host: CollabPanelHost; version: string; getActiveTarget(): CollabPanelOpenTarget | undefined };

function isCompatibleVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return false;
  const [, major, minor, patch] = match.map(Number);
  return major === 0 && minor === 17 && patch! >= 1;
}

function isServicePort(value: unknown): value is BetterSidebarServicePort {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const service = value as Partial<BetterSidebarServicePort>;
  return typeof service.version === "string"
    && Array.isArray(service.features)
    && typeof service.registerTab === "function"
    && typeof service.openTab === "function";
}

export function resolveBetterSidebarHost(service: unknown): BetterSidebarHostResolution {
  if (service === undefined || service === null) {
    return { kind: "missing", requiredVersion: BETTER_SIDEBAR_MIN_VERSION };
  }
  if (!isServicePort(service)) {
    return { kind: "incompatible", reason: "service", requiredVersion: BETTER_SIDEBAR_MIN_VERSION };
  }
  if (!isCompatibleVersion(service.version)) {
    return { kind: "incompatible", reason: "version", requiredVersion: BETTER_SIDEBAR_MIN_VERSION, actualVersion: service.version };
  }
  const missingFeatures = BETTER_SIDEBAR_REQUIRED_FEATURES.filter((feature) => !service.features.includes(feature));
  if (missingFeatures.length > 0) {
    return { kind: "incompatible", reason: "features", requiredVersion: BETTER_SIDEBAR_MIN_VERSION, actualVersion: service.version, missingFeatures };
  }
  return {
    kind: "ready",
    host: createBetterSidebarHost(service),
    version: service.version,
    getActiveTarget: () => {
      const snapshot = service.getSnapshot?.();
      if (!snapshot || typeof snapshot.sessionId !== "string" || snapshot.sessionId.trim() === "") return undefined;
      return { sessionId: snapshot.sessionId, ...(typeof snapshot.cwd === "string" && snapshot.cwd.trim() !== "" ? { cwd: snapshot.cwd } : {}) };
    },
  };
}

export function createBetterSidebarHost(service: BetterSidebarServicePort): CollabPanelHost {
  let registration: { panel: CollabPanelDefinition; dispose: () => void } | undefined;

  return {
    register(panel) {
      if (registration) throw new Error(`Collab panel already registered: ${registration.panel.id}`);
      const disposeProvider = service.registerTab({
        id: panel.id,
        title: panel.title,
        single: true,
        component: ({ scope, visible }) => panel.render({
          sessionId: scope.sessionId,
          ...(scope.cwd === undefined ? {} : { cwd: scope.cwd }),
          visible,
        }),
      });
      let active = true;
      const dispose = (): void => {
        if (!active) return;
        active = false;
        if (registration?.panel === panel) registration = undefined;
        disposeProvider();
      };
      registration = { panel, dispose };
      return dispose;
    },
    open(target: CollabPanelOpenTarget) {
      if (!registration) throw new Error("Collab panel is not registered");
      // Better Sidebar 0.17.1 expands active desktop and narrow panels only
      // for content opens. The Collab tab ignores this internal URL seed.
      service.openTab({ type: registration.panel.id, url: "dsh-collab://panel" }, target);
    },
  };
}
