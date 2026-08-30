import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COLLAB_PANEL_ID, type CollabPanelRenderScope } from "../../src/collab-panel-host.js";
import {
  BETTER_SIDEBAR_MIN_VERSION,
  createBetterSidebarHost,
  resolveBetterSidebarHost,
  type BetterSidebarServicePort,
  type BetterSidebarTabDescriptor,
} from "../../src/better-sidebar-host.js";

function service(overrides: Partial<BetterSidebarServicePort> = {}): BetterSidebarServicePort & {
  descriptor?: BetterSidebarTabDescriptor;
} {
  const result: BetterSidebarServicePort & { descriptor?: BetterSidebarTabDescriptor } = {
    version: "0.17.1",
    features: ["targetedOpen", "stateSubscription", "tabMeta"],
    registerTab: vi.fn((descriptor: BetterSidebarTabDescriptor) => {
      result.descriptor = descriptor;
      return vi.fn();
    }),
    openTab: vi.fn(),
    getSnapshot: () => ({ sessionId: "session-current", cwd: "C:/work/current" }),
    ...overrides,
  };
  return result;
}

describe("BetterSidebarHost provider", () => {
  it("declares Better Sidebar as an optional peer rather than bundling another copy", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));

    expect(manifest.peerDependencies["dsh-better-sidebar"]).toBe(">=0.17.1 <0.18.0");
    expect(manifest.peerDependenciesMeta["dsh-better-sidebar"]).toEqual({ optional: true });
    expect(manifest.dependencies?.["dsh-better-sidebar"]).toBeUndefined();
  });

  it("reports a missing optional provider without constructing a Host", () => {
    expect(resolveBetterSidebarHost(undefined)).toEqual({
      kind: "missing",
      requiredVersion: BETTER_SIDEBAR_MIN_VERSION,
    });
  });

  it("rejects versions and services that do not satisfy the verified contract", () => {
    expect(resolveBetterSidebarHost(service({ version: "0.17.0" }))).toMatchObject({
      kind: "incompatible",
      reason: "version",
      actualVersion: "0.17.0",
    });
    expect(resolveBetterSidebarHost(service({ version: "0.17.1-beta.1" }))).toMatchObject({ kind: "incompatible", reason: "version" });
    expect(resolveBetterSidebarHost(service({ version: "0.18.0" }))).toMatchObject({ kind: "incompatible", reason: "version" });
    expect(resolveBetterSidebarHost(service({ features: ["stateSubscription"] }))).toMatchObject({
      kind: "incompatible",
      reason: "features",
      missingFeatures: ["targetedOpen"],
    });
  });

  it("maps only the narrow Collab contract into a single session-scoped tab", () => {
    const sidebar = service();
    const host = createBetterSidebarHost(sidebar);
    let renderScope: CollabPanelRenderScope | undefined;

    host.register({
      id: COLLAB_PANEL_ID,
      title: "Collab",
      render: (scope) => {
        renderScope = scope;
        return null;
      },
    });

    expect(sidebar.descriptor).toMatchObject({ id: COLLAB_PANEL_ID, title: "Collab", single: true });
    sidebar.descriptor?.component({ scope: { sessionId: "session-owner", cwd: "C:/work/project" }, visible: false });
    expect(renderScope).toEqual({ sessionId: "session-owner", cwd: "C:/work/project", visible: false });
  });

  it("uses targeted content-open semantics so the active narrow or desktop panel becomes visible", () => {
    const sidebar = service();
    const host = createBetterSidebarHost(sidebar);
    host.register({ id: COLLAB_PANEL_ID, title: "Collab", render: () => null });

    host.open({ sessionId: "session-participant", cwd: "C:/work/room-release" });

    expect(sidebar.openTab).toHaveBeenCalledWith(
      { type: COLLAB_PANEL_ID, url: "dsh-collab://panel" },
      { sessionId: "session-participant", cwd: "C:/work/room-release" },
    );
  });

  it("exposes the active Session target for root-scoped room navigation", () => {
    const resolution = resolveBetterSidebarHost(service({
      getSnapshot: () => ({ sessionId: "session-current", cwd: "C:/work/current" }),
    }));

    expect(resolution.kind).toBe("ready");
    if (resolution.kind === "ready") {
      expect(resolution.getActiveTarget()).toEqual({ sessionId: "session-current", cwd: "C:/work/current" });
    }
  });

  it("rejects duplicate registration and releases the provider descriptor on dispose", () => {
    const disposeProvider = vi.fn();
    const sidebar = service({ registerTab: vi.fn(() => disposeProvider) });
    const host = createBetterSidebarHost(sidebar);
    const panel = { id: COLLAB_PANEL_ID, title: "Collab", render: () => null };
    const dispose = host.register(panel);

    expect(() => host.register(panel)).toThrow(/already registered/i);

    dispose();

    expect(disposeProvider).toHaveBeenCalledOnce();
    expect(() => host.open({ sessionId: "session-owner" })).toThrow(/not registered/i);
    expect(() => host.register(panel)).not.toThrow();
  });
});
