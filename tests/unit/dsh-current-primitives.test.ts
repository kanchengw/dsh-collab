import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { MessageText: _removed, ...currentDshExports } = actual;
  return currentDshExports;
});

import { DshCollabDock, type DshCollabClientSnapshot } from "../../src/dsh-client.js";

describe("current DSH UI primitives compatibility", () => {
  it("renders human timeline messages without the removed MessageText export", () => {
    const snapshot: DshCollabClientSnapshot = {
      roomId: "room-1",
      memberId: "member-host",
      roomTitle: "Test room",
      hostDisplayName: "Host",
      role: "host",
      connection: "online",
      onlineCount: 2,
      canSteer: true,
      members: [{ memberId: "member-guest", displayName: "Guest" }],
      timeline: [{
        eventId: "human-1",
        contextEventId: "human-1",
        seq: 1,
        kind: "human",
        authorMemberId: "member-guest",
        text: "Please review this change",
      }],
      agentQueue: [],
    };

    const html = renderToStaticMarkup(createElement(DshCollabDock, {
      fallback: snapshot,
      showHeader: false,
    }));

    expect(html).toContain("Please review this change");
  });
});
