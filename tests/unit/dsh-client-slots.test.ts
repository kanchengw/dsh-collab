import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { apply, applyDshCollabClient, createDshSettingsPort, DshCollabDock, DshCollabParticipantOverlay, DshCollabSettingsCard, inject, type DshCollabClientContext, type DshCollabClientSnapshot } from "../../src/dsh-client.js";

const snapshot: DshCollabClientSnapshot = { roomId: "room-1", roomTitle: "Release", hostDisplayName: "Host", role: "host", connection: "online", memberCount: 3, canSteer: true };

describe("real DSH client slot adapter", () => {
  it("exports the DSH client runner apply entry", () => {
    expect(apply).toBe(applyDshCollabClient);
    expect(inject).toEqual(["slots", "settingsScope"]);
  });

  it("renders the native conversation dock with role, connection and target controls", () => {
    const html = renderToStaticMarkup(createElement(DshCollabDock, { fallback: snapshot }));
    expect(html).toContain('data-collab-mode="host"');
    expect(html).toContain("Release");
    expect(html).toContain("Hosted by Host");
    expect(html).toContain("Steer Agent");
    expect(html).toContain('name="collab-target"');
  });

  it("renders a root-scoped Participant room surface without a local DSH session", () => {
    const participant: DshCollabClientSnapshot = {
      ...snapshot,
      role: "participant",
      canSteer: false,
      timeline: [
        { eventId: "human-1", seq: 1, kind: "human", authorMemberId: "member-bob", text: "hello" },
        { eventId: "agent-1", seq: 2, kind: "agent", authorMemberId: "member-host", requestId: "request-1", state: "output", text: "done" },
      ],
    };
    const html = renderToStaticMarkup(createElement(DshCollabParticipantOverlay, { fallback: participant }));
    expect(html).toContain('data-collab-surface="participant-overlay"');
    expect(html).toContain("hello");
    expect(html).toContain("done");
    expect(html).toContain('name="collab-text"');
    expect(renderToStaticMarkup(createElement(DshCollabParticipantOverlay, { fallback: snapshot }))).toBe("");
  });

  it("renders deployment-owned Host network settings as read-only guidance", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsCard, { port: { getSnapshot: () => ({ gatewayHost: "0.0.0.0", gatewayPort: 0, exposeMode: "network" as const }), save: vi.fn() } }));
    expect(html).toContain('data-settings-namespace="dsh-collab"');
    expect(html).toContain("Anyone who can reach this address");
    expect(html).toContain("DSH profile/CLI");
    expect(html).not.toContain('name="gatewayHost"');
    expect(html).not.toContain('name="gatewayPort"');
    expect(html).not.toContain('name="exposeMode"');
    expect(html).toContain('name="participantGatewayUrl"');
  });

  it("registers only additive DSH slots and waits for their declarations", () => {
    const registrations: Array<{ name: string; options: Record<string, unknown> }> = [];
    const context = {
      slots: {
        inject: vi.fn((_name: string, register: () => unknown) => register()),
        register: vi.fn((options: Record<string, unknown>) => { registrations.push({ name: String(options.name), options }); return () => {}; }),
      },
      get: vi.fn((name: string) => name === "settingsScope" ? { bind: vi.fn(() => ({
        getSnapshot: () => ({ status: "ready", value: { gateway: { gatewayHost: "127.0.0.1", gatewayPort: 3080, exposeMode: "loopback" } }, writable: true }),
        subscribe: () => () => {}, set: vi.fn(), unset: vi.fn(),
      })) } : undefined),
    };
    applyDshCollabClient(context as DshCollabClientContext);
    expect(registrations).toEqual([
      { name: "conversation.input.dock", options: expect.objectContaining({ id: "collab", order: 5 }) },
      { name: "shell.overlay", options: expect.objectContaining({ id: "dsh-collab", order: 10 }) },
      { name: "settings.plugin.item", options: expect.objectContaining({ key: "dsh-collab" }) },
    ]);
    expect(context.slots.inject).toHaveBeenCalledWith("conversation.input.dock", expect.any(Function));
    expect(context.slots.inject).toHaveBeenCalledWith("shell.overlay", expect.any(Function));
    expect(context.slots.inject).toHaveBeenCalledWith("settings.plugin.item", expect.any(Function));
    expect(context.slots.inject).not.toHaveBeenCalledWith("settings.plugins.tab", expect.any(Function));
  });

  it("uses the actual DSH origin without a development-only port rewrite", () => {
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
    const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    let settings: { getSnapshot(): { gatewayPort: number; participantGatewayUrl?: string } } | undefined;
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://127.0.0.1:3082" } });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class {} });
    try {
      applyDshCollabClient({
        slots: { inject: (_name, register) => register(), register: () => () => {} },
        provide: (name, value) => { if (name === "collabSettings") settings = value as typeof settings; },
      });
      expect(settings?.getSnapshot()).toMatchObject({ gatewayPort: 3082, participantGatewayUrl: "http://127.0.0.1:3082/collab" });
    } finally {
      if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
      else Reflect.deleteProperty(globalThis, "location");
      if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor);
      else Reflect.deleteProperty(globalThis, "WebSocket");
    }
  });

  it("reads and persists namespaced settings through the DSH settings scope", async () => {
    let value = { gateway: { gatewayHost: "127.0.0.1", gatewayPort: 3080, exposeMode: "loopback" as const }, participantGatewayUrl: "https://host.example/collab" };
    const set = vi.fn(async (field: string, next: unknown) => { value = { ...value, [field]: next }; });
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value, writable: true }),
      subscribe: () => () => {}, set, unset: vi.fn(),
    };
    const actions = { getSnapshot: () => value.gateway, save: vi.fn() };
    const port = createDshSettingsPort(scope, actions);

    expect(port.getSnapshot()).toMatchObject({ ...value.gateway, participantGatewayUrl: "https://host.example/collab", tokenTtlMs: 28_800_000, maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 32 });
    await port.save({ gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "network", participantGatewayUrl: "https://new.example/collab" });
    expect(set).toHaveBeenCalledWith("gateway", { gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "network" });
    expect(set).toHaveBeenCalledWith("participantGatewayUrl", "https://new.example/collab");
    expect(createDshSettingsPort(scope, actions).getSnapshot()).toMatchObject({ ...value.gateway, participantGatewayUrl: "https://new.example/collab", tokenTtlMs: 28_800_000, maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 32 });
    await expect(port.save({ gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "loopback", participantGatewayUrl: "https://new.example/collab" })).rejects.toThrow("loopback");
    expect(set).toHaveBeenCalledWith("security", { tokenTtlMs: 28_800_000, approvalPolicy: "host-only", maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 32 });
    expect(set).toHaveBeenCalledTimes(3);

    for (const participantGatewayUrl of [
      "not a URL",
      "https://user:pass@new.example/collab",
      "https://new.example/collab?room=one",
      "https://new.example/collab#invite",
      "https://new.example/not-collab",
    ]) {
      await expect(port.save({ gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "network", participantGatewayUrl })).rejects.toThrow("participantGatewayUrl");
    }
    expect(set).toHaveBeenCalledTimes(3);
  });

  it("rejects a save when the DSH settings scope does not commit it", async () => {
    const value = { gateway: { gatewayHost: "127.0.0.1", gatewayPort: 3080, exposeMode: "loopback" as const }, participantGatewayUrl: "" };
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value, writable: true }),
      subscribe: () => () => {},
      set: vi.fn(async () => {}),
      unset: vi.fn(),
    };
    const port = createDshSettingsPort(scope, { getSnapshot: () => value.gateway, save: vi.fn() });

    await expect(port.save({
      gatewayHost: "127.0.0.1",
      gatewayPort: 3080,
      exposeMode: "loopback",
      participantGatewayUrl: "https://host.example/collab",
    })).rejects.toThrow(/not persisted/i);
  });
});
