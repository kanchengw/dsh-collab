import { describe, expect, it, vi } from "vitest";
import {
  COLLAB_RIGHT_TAB_ID,
  COLLAB_RIGHT_TAB_KIND,
  COLLAB_ROOMS_PANEL_ID,
  collabPanelScopeFromTab,
  createOfficialCollabPanelHost,
  openOfficialCollabRooms,
  registerOfficialCollabSidebar,
} from "../../src/dsh-sidebar-embedding.js";

describe("official DSH Sidebar embedding", () => {
  it("opens the official Collab Rooms main panel instead of only toggling the legacy drawer state", () => {
    const selectPanel = vi.fn();
    const fallback = vi.fn();

    openOfficialCollabRooms({ selectPanel }, fallback);

    expect(selectPanel).toHaveBeenCalledWith(COLLAB_ROOMS_PANEL_ID);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("uses the fallback room drawer only when the official layout is unavailable", () => {
    const fallback = vi.fn();

    openOfficialCollabRooms(undefined, fallback);

    expect(fallback).toHaveBeenCalledOnce();
  });

  it("opens the existing Collab Bar after the target Session is selected", async () => {
    vi.useFakeTimers();
    const openTab = vi.fn();
    const selectSession = vi.fn();
    const selectPanel = vi.fn();
    try {
      const host = createOfficialCollabPanelHost({ openTab }, selectSession, selectPanel);

      host.open({ sessionId: "session-1", cwd: "C:\\work\\atlas" });

      expect(selectSession).toHaveBeenCalledWith("session-1");
      expect(selectPanel).toHaveBeenCalledWith(null);
      expect(openTab).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(0);

      expect(openTab).toHaveBeenCalledWith(COLLAB_RIGHT_TAB_KIND, { revealIfOpened: true });
      expect(selectSession.mock.invocationCallOrder[0]).toBeLessThan(selectPanel.mock.invocationCallOrder[0]!);
      expect(selectPanel.mock.invocationCallOrder[0]).toBeLessThan(openTab.mock.invocationCallOrder[0]!);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries opening until the target Session surface is mounted", async () => {
    vi.useFakeTimers();
    try {
      let mounted = false;
      const openTab = vi.fn(() => {
        if (!mounted) throw new Error("sidebarRight: no session surface is mounted");
      });
      const host = createOfficialCollabPanelHost({ openTab });

      expect(() => host.open({ sessionId: "session-1" })).not.toThrow();
      expect(openTab).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(0);
      expect(openTab).toHaveBeenCalledTimes(1);

      mounted = true;
      await vi.advanceTimersByTimeAsync(16);

      expect(openTab).toHaveBeenCalledTimes(2);
      expect(openTab).toHaveBeenLastCalledWith(COLLAB_RIGHT_TAB_KIND, { revealIfOpened: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("registers the global Rooms panel and session-scoped right tab", () => {
    const registrations: Array<{ name: string; options: Record<string, unknown> }> = [];
    const inject = vi.fn((_name: string, register: () => unknown) => register());
    const register = vi.fn((options: Record<string, unknown>) => {
      registrations.push({ name: String(options.name), options });
      return () => {};
    });
    const registerTab = vi.fn(() => () => {});
    const context = {
      slots: { inject, register },
      effect: (callback: () => void | (() => void)) => { callback(); },
    };

    registerOfficialCollabSidebar({
      context,
      layout: { selectPanel: vi.fn() },
      sidebarRight: { openTab: vi.fn() },
      sidebarRightTabs: { register: registerTab },
      roomPanel: () => null,
      rightPanel: () => null,
      label: "Collab Rooms",
    });

    expect(registerTab).toHaveBeenCalledWith(expect.objectContaining({
      id: COLLAB_RIGHT_TAB_ID,
      kind: COLLAB_RIGHT_TAB_KIND,
      title: expect.any(Function),
      guide: expect.arrayContaining([
        expect.objectContaining({
          id: expect.any(String),
          order: expect.any(Number),
          title: expect.any(Function),
          description: expect.any(Function),
        }),
      ]),
    }));
    expect(registrations).toEqual([
      { name: "sidebar.panellist", options: expect.objectContaining({ id: COLLAB_ROOMS_PANEL_ID }) },
      { name: "main", options: expect.objectContaining({ key: COLLAB_ROOMS_PANEL_ID }) },
      { name: "sidebar.right.pane.tab", options: expect.objectContaining({ key: COLLAB_RIGHT_TAB_ID }) },
    ]);
    expect(inject).toHaveBeenCalledWith("sidebar.panellist", expect.any(Function));
    expect(inject).toHaveBeenCalledWith("main", expect.any(Function));
    expect(inject).toHaveBeenCalledWith("sidebar.right.pane.tab", expect.any(Function));
  });

  it("derives a session-scoped render target from the official tab props", () => {
    expect(collabPanelScopeFromTab({
      sessionId: "session-1",
      useTabInfo: () => ({ tab: { visible: false } }),
    }, "C:\\work\\atlas")).toEqual({
      sessionId: "session-1",
      cwd: "C:\\work\\atlas",
      visible: false,
    });
    expect(collabPanelScopeFromTab({ useTabInfo: () => ({ tab: { visible: true } }) })).toBeUndefined();
  });
});
