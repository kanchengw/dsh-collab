import { describe, expect, it, vi } from "vitest";
import { applyDshCollabClient, decodeDshParticipantSettings, type DshCollabClientContext } from "../../src/dsh-client.js";
import { composerTargetForText } from "../../src/ui.js";

describe("Collab Bar production composition", () => {
  it("rejects obsolete inline Participant secrets while publishing only the intended slots", () => {
    const inline = {
      gatewayEndpoint: "wss://collab.example/collab",
      roomId: "room-1",
      memberId: "member-bob",
      credential: "resume-secret",
    };
    const registrations: Array<{ name: string; id?: string; key?: string }> = [];
    const context = {
      slots: {
        inject: vi.fn((_name: string, register: () => unknown) => register()),
        register: vi.fn((options: { name: string; id?: string; key?: string }) => {
          registrations.push({ name: options.name, id: options.id, key: options.key });
          return () => {};
        }),
      },
      get: vi.fn(() => undefined),
    };

    expect(decodeDshParticipantSettings({ resume: inline })).toEqual({});
    applyDshCollabClient(context as unknown as DshCollabClientContext);

    expect(registrations).toEqual([
      { name: "conversation.session.header.actions", id: "dsh-collab", key: undefined },
      { name: "sidebar.footer.action", id: "dsh-collab", key: undefined },
      { name: "shell.overlay", id: "dsh-collab-rooms", key: undefined },
      { name: "settings.plugin.item", id: undefined, key: "dsh-collab" },
    ]);
    expect(registrations.some(({ name, id }) => name === "shell.overlay" && id !== "dsh-collab-rooms")).toBe(false);
    expect(composerTargetForText("@agent summarize the upgrade")).toBe("dsh");
  });
});
