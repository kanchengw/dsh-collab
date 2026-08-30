import { createElement, type ReactNode } from "react";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  COLLAB_PANEL_ID,
  type CollabPanelDefinition,
  type CollabPanelHost,
  type CollabPanelOpenTarget,
} from "../../src/collab-panel-host.js";

class FakeCollabPanelHost implements CollabPanelHost {
  private panel?: CollabPanelDefinition;
  readonly opened: CollabPanelOpenTarget[] = [];

  register(panel: CollabPanelDefinition): () => void {
    if (this.panel) throw new Error(`Panel already registered: ${panel.id}`);
    this.panel = panel;
    return () => {
      if (this.panel === panel) this.panel = undefined;
    };
  }

  open(target: CollabPanelOpenTarget): void {
    if (!this.panel) throw new Error("Collab panel is not registered");
    this.opened.push(target);
  }

  render(sessionId: string, visible: boolean, cwd?: string): ReactNode {
    if (!this.panel) throw new Error("Collab panel is not registered");
    return this.panel.render({ sessionId, cwd, visible });
  }
}

describe("CollabPanelHost contract", () => {
  it("keeps panel hosting scoped to a DSH Session rather than a Collab room", () => {
    expectTypeOf<CollabPanelOpenTarget>().toEqualTypeOf<{ sessionId: string; cwd?: string }>();

    const host = new FakeCollabPanelHost();
    host.register({
      id: COLLAB_PANEL_ID,
      title: "Collab",
      render: ({ sessionId, cwd, visible }) => createElement("div", { "data-session": sessionId, "data-cwd": cwd, hidden: !visible }),
    });

    host.open({ sessionId: "session-participant", cwd: "C:/work/room-release" });

    expect(host.opened).toEqual([{ sessionId: "session-participant", cwd: "C:/work/room-release" }]);
  });

  it("passes only the active Session scope and visibility to panel content", () => {
    const host = new FakeCollabPanelHost();
    let renderedScope: unknown;
    host.register({
      id: COLLAB_PANEL_ID,
      title: () => "Collab",
      render: (scope) => {
        renderedScope = scope;
        return null;
      },
    });

    host.render("session-owner", false, "C:/work/project");

    expect(renderedScope).toEqual({
      sessionId: "session-owner",
      cwd: "C:/work/project",
      visible: false,
    });
  });

  it("supports duplicate-registration rejection and deterministic disposal without a sidebar provider", () => {
    const host = new FakeCollabPanelHost();
    const panel: CollabPanelDefinition = {
      id: COLLAB_PANEL_ID,
      title: "Collab",
      render: () => null,
    };
    const dispose = host.register(panel);

    expect(() => host.register(panel)).toThrow(/already registered/i);

    dispose();

    expect(() => host.open({ sessionId: "session-owner" })).toThrow(/not registered/i);
  });
});
