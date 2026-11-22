import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@deepseek-ai/dsh-client-ui-primitives", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { MessageText: _removed, ...currentDshExports } = actual;
  return currentDshExports;
});

import * as currentPrimitives from "@deepseek-ai/dsh-client-ui-primitives";
import { DshCollabDock, type DshCollabClientSnapshot } from "../../src/dsh-client.js";

function humanSnapshot(text: string, eventId: string): DshCollabClientSnapshot {
  return {
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
      eventId,
      contextEventId: eventId,
      seq: 1,
      kind: "human",
      authorMemberId: "member-guest",
      text,
    }],
    agentQueue: [],
  };
}

function renderHumanTimeline(text: string, eventId: string): string {
  return renderToStaticMarkup(createElement(DshCollabDock, {
    fallback: humanSnapshot(text, eventId),
    showHeader: false,
  }));
}

describe("current DSH UI primitives compatibility", () => {
  it("exposes UserTextRun without the removed user text projector export", () => {
    const removedProjectorExport = ["project", "UserText"].join("");
    expect(typeof currentPrimitives.UserTextRun).toBe("function");
    expect(Object.keys(currentPrimitives)).not.toContain(removedProjectorExport);
  });

  it("renders human timeline messages without the removed MessageText export", () => {
    expect(renderHumanTimeline("Please review this change", "human-1"))
      .toContain("Please review this change");
  });

  it("renders HTML-like and Markdown-like human input as literal text", () => {
    const text = "<b>文本</b> & **粗体** [链接](https://example.invalid)";
    const html = renderHumanTimeline(text, "human-special");
    const renderedText = html.match(/<span class="[^"]*plainRun[^"]*">([\s\S]*?)<\/span>/)?.[1];

    expect(renderedText).toBe("&lt;b&gt;文本&lt;/b&gt; &amp; **粗体** [链接](https://example.invalid)");
    expect(renderedText).not.toContain("<strong>");
    expect(renderedText).not.toContain("<a ");
  });
});
