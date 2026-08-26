import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { apply, applyDshCollabClient, createDshParticipantPersistence, createDshSettingsPort, DshCollabDock, DshCollabParticipantOverlay, DshCollabSettingsCard, inject, type DshCollabClientContext, type DshCollabClientSnapshot } from "../../src/dsh-client.js";
import { DshCollabSettingsPanel } from "../../src/collab-settings-card.js";

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
    expect(html).toContain('data-collab-room-ui="true"');
    expect(html).toContain("hello");
    expect(html).toContain("done");
    expect(html).toContain('name="collab-text"');
    expect(html).not.toContain('style="');
    expect(html).not.toContain("dsh-collab-dock__");
    expect(renderToStaticMarkup(createElement(DshCollabParticipantOverlay, { fallback: snapshot }))).toBe("");
  });

  it("renders separate Host configuration and Participant invitation flows", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, { port: { getSnapshot: () => ({ gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network" as const, advertisedEndpoint: "ws://192.168.1.20:4310/collab" }), save: vi.fn() } }));
    expect(html).toContain('data-settings-namespace="dsh-collab"');
    expect(html).toContain("Private network exposure");
    expect(html).toContain("dedicated Collab Gateway");
    expect(html).not.toContain('name="gatewayHost"');
    expect(html).toContain('name="gatewayPort"');
    expect(html).toContain('name="connectionMethod"');
    expect(html).not.toContain("This device only");
    expect(html).toContain('name="advertisedEndpoint"');
    expect(html).toContain('name="hostInvitationOutput"');
    expect(html).toContain('name="participantInvitation"');
    expect(html).not.toContain('name="participantGatewayUrl"');
    expect(html).not.toContain('name="inviteToken"');
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

  it("uses the dedicated Gateway default instead of the DSH origin", () => {
    const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
    const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    let settings: { getSnapshot(): { gatewayPort: number; advertisedEndpoint?: string } } | undefined;
    Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "http://127.0.0.1:3082" } });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class {} });
    try {
      applyDshCollabClient({
        slots: { inject: (_name, register) => register(), register: () => () => {} },
        provide: (name, value) => { if (name === "collabSettings") settings = value as typeof settings; },
      });
      expect(settings?.getSnapshot()).toMatchObject({ gatewayPort: 4310, advertisedEndpoint: "" });
    } finally {
      if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
      else Reflect.deleteProperty(globalThis, "location");
      if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor);
      else Reflect.deleteProperty(globalThis, "WebSocket");
    }
  });

  it("reads and persists namespaced settings through the DSH settings scope", async () => {
    let value = {
      gateway: { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" },
      appliedGateway: { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" },
    };
    const set = vi.fn(async (field: string, next: unknown) => { value = { ...value, [field]: next }; });
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value, writable: true }),
      subscribe: () => () => {}, set, unset: vi.fn(),
    };
    const configureGateway = vi.fn();
    const actions = { getSnapshot: () => value.gateway, save: vi.fn(), configureGateway };
    const port = createDshSettingsPort(scope, actions);

    expect(configureGateway).toHaveBeenCalledWith(value.gateway);
    expect(port.getSnapshot()).toMatchObject({ ...value.gateway, writable: true, tokenTtlMs: 28_800_000, maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 32 });
    await port.save({ gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "network", advertisedEndpoint: "wss://new.example/collab" });
    expect(set).toHaveBeenCalledWith("gateway", { gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "network", advertisedEndpoint: "wss://new.example/collab" });
    expect(port.getSnapshot()).toMatchObject({ ...value.gateway, tokenTtlMs: 28_800_000, maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 32 });
    expect(configureGateway).toHaveBeenLastCalledWith(value.appliedGateway);
    value = { ...value, appliedGateway: value.gateway };
    port.getSnapshot();
    expect(configureGateway).toHaveBeenLastCalledWith(value.gateway);
    await expect(port.save({ gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "loopback", advertisedEndpoint: "wss://new.example/collab" })).rejects.toThrow("loopback");
    expect(set).toHaveBeenCalledWith("security", { tokenTtlMs: 28_800_000, approvalPolicy: "host-only", maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 32 });
    expect(set).toHaveBeenCalledTimes(2);

    for (const advertisedEndpoint of [
      "not a URL",
      "ws://new.example/collab",
      "wss://user:pass@new.example/collab",
      "wss://new.example/collab?room=one",
      "wss://new.example/collab#invite",
      "wss://new.example/not-collab",
    ]) {
      await expect(port.save({ gatewayHost: "0.0.0.0", gatewayPort: 8443, exposeMode: "network", advertisedEndpoint })).rejects.toThrow("gatewayEndpoint");
    }
    expect(set).toHaveBeenCalledTimes(2);
  });

  it("rejects a save when the DSH settings scope does not commit it", async () => {
    const value = { gateway: { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" } };
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value, writable: true }),
      subscribe: () => () => {},
      set: vi.fn(async () => {}),
      unset: vi.fn(),
    };
    const port = createDshSettingsPort(scope, { getSnapshot: () => value.gateway, save: vi.fn() });

    await expect(port.save({
      gatewayHost: "127.0.0.1",
      gatewayPort: 4310,
      exposeMode: "loopback",
      advertisedEndpoint: "wss://host.example/collab",
    })).rejects.toThrow(/not persisted/i);
  });

  it("stores Participant resume state in the local DSH settings scope without exposing it in the settings card", async () => {
    let resume: { gatewayEndpoint: string; roomId: string; memberId: string; credential: string } | undefined;
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value: { resume }, writable: true }),
      subscribe: () => () => {},
      set: vi.fn(async (_field: string, value: unknown) => { resume = value as typeof resume; }),
      unset: vi.fn(async () => { resume = undefined; }),
    };
    const persistence = createDshParticipantPersistence(scope);
    await persistence.save({ gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" });
    expect(persistence.load()).toMatchObject({ roomId: "room-2", credential: "resume-secret" });
    expect(scope.set).toHaveBeenCalledWith("resume", expect.objectContaining({ memberId: "member-bob" }));
    await persistence.clear();
    expect(scope.unset).toHaveBeenCalledWith("resume");

    const html = renderToStaticMarkup(createElement(DshCollabSettingsCard, { port: { getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }), save: vi.fn() } }));
    expect(html).not.toContain("resume-secret");
    expect(html).not.toContain('name="participant"');
  });

  it("automatically resumes the saved Participant room when local DSH settings are ready", async () => {
    const fetchDescriptor = Object.getOwnPropertyDescriptor(globalThis, "fetch");
    const socketDescriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
    const requests: string[] = [];
    let client: { getSnapshot(): DshCollabClientSnapshot } | undefined;
    Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string) => {
      requests.push(url);
      const data = url.endsWith("/resume")
        ? { room: { roomId: "room-2", title: "Remote" }, member: { memberId: "member-bob", role: "participant" }, roomToken: "fresh-token" }
        : url.endsWith("/snapshot")
          ? { room: { roomId: "room-2", title: "Remote" }, members: [], lastEventSeq: 0 }
          : { events: [], nextSeq: 0 };
      return { ok: true, status: 200, json: async () => ({ ok: true, data }) };
    } });
    Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: class {
      readyState = 1;
      onopen?: () => void;
      onclose?: () => void;
      constructor() { queueMicrotask(() => this.onopen?.()); }
      close(): void { this.readyState = 3; }
      send(): void {}
    } });
    try {
      const binder = { bind: vi.fn((spec: { namespace: string }) => spec.namespace === "dsh-collab-participant" ? {
        getSnapshot: () => ({ status: "ready", value: { resume: { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" } }, writable: true }),
        subscribe: () => () => {}, set: vi.fn(), unset: vi.fn(),
      } : {
        getSnapshot: () => ({ status: "ready", value: { gateway: { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback", advertisedEndpoint: "" } }, writable: true }),
        subscribe: () => () => {}, set: vi.fn(), unset: vi.fn(),
      }) };
      applyDshCollabClient({
        slots: { inject: (_name, register) => register(), register: () => () => {} },
        get: (name) => name === "settingsScope" ? binder : undefined,
        provide: (name, value) => { if (name === "collabClient") client = value as typeof client; },
      } as DshCollabClientContext);
      await vi.waitFor(() => expect(client?.getSnapshot()).toMatchObject({ roomId: "room-2", role: "participant", connection: "online" }));
      expect(requests.filter((url) => url.endsWith("/resume"))).toHaveLength(1);
    } finally {
      if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor); else Reflect.deleteProperty(globalThis, "fetch");
      if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor); else Reflect.deleteProperty(globalThis, "WebSocket");
    }
  });
});
