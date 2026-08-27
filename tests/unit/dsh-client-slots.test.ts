import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { apply, applyDshCollabClient, createDshGatewayControlPort, createDshParticipantPersistence, createDshSettingsPort, decodeDshParticipantSettings, DshCollabRoomSurface, DshCollabSessionAction, DshCollabSettingsCard, inject, type DshCollabClientContext, type DshCollabClientSnapshot } from "../../src/dsh-client.js";
import { DshCollabSettingsPanel } from "../../src/collab-settings-card.js";
import { closeDshCollabRoom, openDshCollabRoom } from "../../src/collab-rooms.js";

const snapshot: DshCollabClientSnapshot = { roomId: "room-1", roomTitle: "Release", hostDisplayName: "Host", role: "host", connection: "online", onlineCount: 3, canSteer: true };

describe("real DSH client slot adapter", () => {
  it("lets the Owner dismiss a generated invitation without stopping the room", () => {
    const source = readFileSync(resolve(process.cwd(), "src/dsh-client.ts"), "utf8");

    expect(source).toMatch(/setInvitation\(""\);[^\n]*share\.hideInvitation/);
  });

  it("keeps room status and actions available at narrow viewports", () => {
    const css = readFileSync(resolve(process.cwd(), "src/collab-room.module.css"), "utf8");
    const narrow = css.slice(css.indexOf("@media (max-width: 720px)"), css.indexOf("@media (max-width: 440px)"));

    expect(narrow).not.toMatch(/\.surfaceHeader > \.connection\s*{[^}]*display:\s*none/);
    expect(narrow).not.toMatch(/\.surfaceActions \.toolbarButton\s*{[^}]*display:\s*none/);
    expect(narrow).toMatch(/\.surfaceActions\s*{[^}]*flex-wrap:\s*wrap/);
  });

  it("exports the DSH client runner apply entry", () => {
    expect(apply).toBe(applyDshCollabClient);
    expect(inject).toEqual(["slots", "settingsScope", "connection", "locale"]);
  });

  it("starts and stops the Host Gateway only through the official Connection RPC", async () => {
    const calls: string[] = [];
    const base = { getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }), save: vi.fn() };
    const port = createDshGatewayControlPort(base, {
      call: vi.fn(async (_channel: string, endpoint: string) => {
        calls.push(endpoint);
        if (endpoint === "rooms/list") return { ok: true, value: { rooms: [] } };
        return { ok: true, value: endpoint.endsWith("start") ? { status: "running", port: 4310 } : { status: "stopped" } };
      }),
    });

    expect(port.getGatewaySnapshot?.()).toEqual({ status: "stopped" });
    expect(calls).toEqual([]);
    await port.startGateway?.();
    expect(port.getGatewaySnapshot?.()).toEqual({ status: "running", port: 4310 });
    await port.stopGateway?.();
    expect(port.getGatewaySnapshot?.()).toEqual({ status: "stopped" });
    expect(calls).toEqual(["gateway/start", "rooms/list", "gateway/stop", "rooms/list"]);
  });

  it("preserves class-backed room actions when adding Gateway controls", async () => {
    class BrowserSettings {
      readonly shared: string[] = [];

      getSnapshot() {
        return { gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" };
      }

      async save(): Promise<void> {}

      async shareHostRoom(input: { sessionId: string }): Promise<void> {
        this.shared.push(input.sessionId);
      }
    }
    const base = new BrowserSettings();
    const port = createDshGatewayControlPort(base, { call: vi.fn() });

    await port.shareHostRoom?.({ sessionId: "session-current", title: "Current" });

    expect(base.shared).toEqual(["session-current"]);
  });

  it("keeps the native Host conversation to one composer with a header-only Collab action", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSessionAction, { sessionId: "room-1", defaultRoomName: "Release", fallback: snapshot }));

    expect(html).toContain('data-collab-session-action="true"');
    expect(html).toContain("Open Collab room");
    expect(html).not.toContain("textarea");
    expect(html).not.toContain('data-collab-room-ui="true"');
  });

  it("renders the same full room surface for Owner and Participant", () => {
    const participant: DshCollabClientSnapshot = {
      ...snapshot,
      role: "participant",
      canSteer: false,
      members: [
        { memberId: "member-host", displayName: "Host" },
        { memberId: "member-bob", displayName: "Bob" },
      ],
      timeline: [
        { eventId: "human-1", seq: 1, kind: "human", authorMemberId: "member-bob", text: "**hello**" },
        { eventId: "agent-1", seq: 2, kind: "agent", authorMemberId: "member-host", requestId: "request-1", state: "output", text: "**done**" },
        { eventId: "stream:request-2", seq: 3, kind: "agent", authorMemberId: "member-host", requestId: "request-2", state: "output", text: "**working", streaming: true },
      ],
    };
    openDshCollabRoom({ kind: "joined", roomId: "room-1", roomTitle: "Release", hostDisplayName: "Host", gatewayEndpoint: "wss://host.example/collab" });
    const html = renderToStaticMarkup(createElement(DshCollabRoomSurface, { fallback: participant }));
    closeDshCollabRoom();

    expect(html).toContain('data-collab-surface="room"');
    expect(html).toContain('data-collab-mode="participant"');
    expect(html).toContain('data-collab-room-ui="true"');
    expect(html).toContain("**hello**");
    expect(html).not.toContain("<strong>hello</strong>");
    expect(html).toContain("<strong>done</strong>");
    expect(html).toContain('data-streaming="true"');
    expect(readFileSync(resolve(process.cwd(), "src/dsh-client.ts"), "utf8")).toContain("streaming: item.streaming === true");
    expect(html).toContain(">Bob<");
    expect(html).not.toContain(">member-bob<");
    expect(html).not.toContain(">Output</span>");
    expect(html).toContain('name="collab-text"');
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html).not.toContain("<select");
    expect(html).not.toContain('name="collab-target"');
    expect(html).toContain("@agent");
    expect(html).not.toContain('style="');
    expect(renderToStaticMarkup(createElement(DshCollabRoomSurface, { fallback: snapshot }))).toBe("");
  });

  it("opens a draft Owner room from the native session header without adding another composer", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSessionAction, {
      sessionId: "session-current",
      defaultRoomName: "Release planning",
      fallback: { ...snapshot, roomId: "", role: "participant", connection: "offline" },
    }));

    expect(html).toContain("Share as Collab room");
    expect(html).not.toContain("textarea");
  });

  it("keeps Settings configuration-only", () => {
    const html = renderToStaticMarkup(createElement(DshCollabSettingsPanel, { port: { getSnapshot: () => ({ gatewayHost: "0.0.0.0", gatewayPort: 4310, exposeMode: "network" as const, advertisedEndpoint: "ws://192.168.1.20:4310/collab" }), save: vi.fn() } }));
    expect(html).toContain('data-settings-namespace="dsh-collab"');
    expect(html).toContain("Private network exposure");
    expect(html).toContain("Collab Gateway");
    expect(html).not.toContain('name="gatewayHost"');
    expect(html).not.toContain('name="gatewayPort"');
    expect(html).toContain('name="connectionMethod"');
    expect(html).not.toContain("This device only");
    expect(html).toContain('name="privateAddress"');
    expect(html).toContain('name="derivedEndpoint"');
    expect(html).not.toContain('name="hostInvitationOutput"');
    expect(html).not.toContain("Open Host room");
    expect(html).not.toContain("Create invitation");
    expect(html).not.toContain('name="participantInvitation"');
    expect(html).not.toContain("Join someone else");
    expect(html).not.toContain("data-room-role");
    expect(html).not.toContain("Host your own room");
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
      { name: "conversation.session.header.actions", options: expect.objectContaining({ id: "dsh-collab", order: 30, locale: "dsh-collab" }) },
      { name: "sidebar.footer.action", options: expect.objectContaining({ id: "dsh-collab", order: 20, locale: "dsh-collab" }) },
      { name: "shell.overlay", options: expect.objectContaining({ id: "dsh-collab-rooms", order: 10, locale: "dsh-collab" }) },
      { name: "shell.overlay", options: expect.objectContaining({ id: "dsh-collab-room", order: 20, locale: "dsh-collab" }) },
      { name: "settings.plugin.item", options: expect.objectContaining({ key: "dsh-collab", locale: "dsh-collab" }) },
    ]);
    expect(context.slots.inject).toHaveBeenCalledWith("conversation.session.header.actions", expect.any(Function));
    expect(context.slots.inject).toHaveBeenCalledWith("sidebar.footer.action", expect.any(Function));
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

  it("stores multiple Joined rooms and forgets only the selected membership", async () => {
    let joinedRooms: Array<{ gatewayEndpoint: string; roomId: string; memberId: string; credential: string; roomTitle?: string }> = [];
    const scope = {
      getSnapshot: () => ({ status: "ready" as const, value: { joinedRooms }, writable: true }),
      subscribe: () => () => {},
      set: vi.fn(async (_field: string, value: unknown) => { joinedRooms = value as typeof joinedRooms; }),
      unset: vi.fn(async () => {}),
    };
    const persistence = createDshParticipantPersistence(scope);
    const first = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret", roomTitle: "Design review" };
    const second = { gatewayEndpoint: "wss://other.example/collab", roomId: "room-3", memberId: "member-bob", credential: "other-secret", roomTitle: "Release" };
    await persistence.save(first);
    await persistence.save(second);
    expect(persistence.list?.()).toEqual([first, second]);
    await persistence.remove?.({ gatewayEndpoint: first.gatewayEndpoint, roomId: first.roomId });
    expect(persistence.list?.()).toEqual([second]);
    expect(scope.set).toHaveBeenLastCalledWith("joinedRooms", [second]);

    const html = renderToStaticMarkup(createElement(DshCollabSettingsCard, { port: { getSnapshot: () => ({ gatewayHost: "127.0.0.1", gatewayPort: 4310, exposeMode: "loopback" as const, advertisedEndpoint: "" }), save: vi.fn() } }));
    expect(html).not.toContain("resume-secret");
    expect(html).not.toContain('name="participant"');
  });

  it("migrates the pre-release single resume field into Joined rooms", () => {
    const legacy = { gatewayEndpoint: "wss://collab.example/collab", roomId: "room-2", memberId: "member-bob", credential: "resume-secret" };
    expect(decodeDshParticipantSettings({ resume: legacy })).toEqual({ joinedRooms: [legacy] });
    expect(decodeDshParticipantSettings({ joinedRooms: [legacy], resume: legacy })).toEqual({ joinedRooms: [legacy] });
  });

  it("does not connect a saved Joined room when local DSH settings become ready", async () => {
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
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(client?.getSnapshot()).toMatchObject({ connection: "offline" });
      expect(requests.filter((url) => url.endsWith("/resume"))).toHaveLength(0);
    } finally {
      if (fetchDescriptor) Object.defineProperty(globalThis, "fetch", fetchDescriptor); else Reflect.deleteProperty(globalThis, "fetch");
      if (socketDescriptor) Object.defineProperty(globalThis, "WebSocket", socketDescriptor); else Reflect.deleteProperty(globalThis, "WebSocket");
    }
  });
});
