import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { apply, applyDshCollabClient, createDshSettingsPort, DshCollabDock, DshCollabSettingsCard, inject, type DshCollabClientContext, type DshCollabClientSnapshot } from "../../src/dsh-client.js";

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

  it("renders a collab settings card with network warning", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsCard, { port: { getSnapshot: () => ({ gatewayHost: "0.0.0.0", gatewayPort: 0, exposeMode: "network" as const }), save: vi.fn() } }));
    expect(html).toContain('data-settings-namespace="dsh-collab"');
    expect(html).toContain("Anyone who can reach this address");
    expect(html).toContain('name="gatewayPort"');
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
      { name: "settings.plugin.item", options: expect.objectContaining({ key: "dsh-collab" }) },
    ]);
    expect(context.slots.inject).toHaveBeenCalledWith("conversation.input.dock", expect.any(Function));
    expect(context.slots.inject).toHaveBeenCalledWith("settings.plugin.item", expect.any(Function));
    expect(context.slots.inject).not.toHaveBeenCalledWith("settings.plugins.tab", expect.any(Function));
  });

  it("reads and atomically persists gateway settings through the DSH settings scope", async () => {
    let value = { gateway: { gatewayHost: "127.0.0.1", gatewayPort: 3080, exposeMode: "loopback" as const } };
    const set = vi.fn(async (_field: string, next: typeof value.gateway) => { value = { gateway: next }; });
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value, writable: true }),
      subscribe: () => () => {}, set, unset: vi.fn(),
    };
    const actions = { getSnapshot: () => value.gateway, save: vi.fn() };
    const port = createDshSettingsPort(scope, actions);

    expect(port.getSnapshot()).toEqual(value.gateway);
    await port.save({ gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "network" });
    expect(set).toHaveBeenCalledWith("gateway", { gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "network" });
    expect(createDshSettingsPort(scope, actions).getSnapshot()).toEqual(value.gateway);
    await expect(port.save({ gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "loopback" })).rejects.toThrow("loopback");
    expect(set).toHaveBeenCalledTimes(1);
  });
});
