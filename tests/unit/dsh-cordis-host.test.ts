import { createConnection, createServer as createTcpServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { mountDshCollabCordisHost } from "../../src/dsh-cordis-host.js";
import { authenticateCollabRequest, isLoopbackAddress } from "../../src/http.js";
import { apply, DSH_COLLAB_PARTICIPANT_NAMESPACE, DSH_COLLAB_SETTINGS_NAMESPACE, type DshCollabPersistedSettings } from "../../src/index.js";

async function freeTcpPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => { socket.destroy(); resolve(true); });
    socket.once("error", () => { socket.destroy(); resolve(false); });
  });
}

async function waitUntilListening(port: number): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Gateway did not listen on ${String(port)}`);
}

describe("Cordis Host mount", () => {
  const noPersistence = { stateFile: false as const };
  it("accepts only loopback Host or an identity asserted by an explicitly trusted proxy", () => {
    const options = {
      hostPrincipalId: "host",
      allowLoopbackPrincipal: true,
      trustedProxyAddresses: ["10.0.0.5"],
      trustedPrincipalHeader: "x-authenticated-user",
      trustedProxyMarkerHeader: "x-forwarded-for",
    };
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { "x-dsh-principal-id": "host" }, remoteAddress: "203.0.113.4" }, options)).toEqual({});
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: {}, remoteAddress: "::1" }, options)).toEqual({ principalId: "host" });
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { origin: "https://evil.example" }, remoteAddress: "::1" }, options)).toEqual({});
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { origin: "http://127.0.0.1:3080" }, remoteAddress: "::1" }, options)).toEqual({ principalId: "host" });
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { "x-forwarded-for": "203.0.113.9" }, remoteAddress: "10.0.0.5" }, options)).toEqual({});
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { "x-forwarded-for": "203.0.113.9", "x-authenticated-user": "alice" }, remoteAddress: "10.0.0.5" }, options)).toEqual({ principalId: "alice" });
  });

  it("registers the formal dsh-collab settings namespace with safe composition defaults", () => {
    const register = vi.fn((_namespace: string, _schema: unknown, options: { base: DshCollabPersistedSettings; validate(value: unknown): void }) => ({ get: () => options.base, update: vi.fn(async () => {}) }));
    const context = {
      agents: { get: () => undefined },
      inject: vi.fn((_services: string[], callback: (ctx: { settings: { register: typeof register } }) => void) => callback({ settings: { register } })),
    };
    apply(context, {
      roomId: "room-1", hostId: "host", title: "Room", hostDisplayName: "Host",
      host: "127.0.0.1", port: 3080,
    });

    expect(context.inject).toHaveBeenCalledWith(["settings"], expect.any(Function));
    expect(register).toHaveBeenCalledWith(
      DSH_COLLAB_SETTINGS_NAMESPACE,
      expect.objectContaining({ toJSON: expect.any(Function) }),
      expect.objectContaining({
        base: expect.objectContaining({
          gateway: { gatewayHost: "127.0.0.1", gatewayPort: 3080, exposeMode: "loopback", advertisedEndpoint: "" },
          security: { tokenTtlMs: 8 * 60 * 60 * 1000, maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 32, approvalPolicy: "host-only" },
        }),
        validate: expect.any(Function),
      }),
    );
    expect(register).toHaveBeenCalledWith(
      DSH_COLLAB_PARTICIPANT_NAMESPACE,
      expect.objectContaining({ toJSON: expect.any(Function) }),
      expect.objectContaining({ validate: expect.any(Function) }),
    );
    const options = register.mock.calls[0]?.[2];
    if (!options) throw new Error("settings registration options were not captured");
    expect(() => options.validate({ gateway: { gatewayHost: "0.0.0.0", gatewayPort: 3080, exposeMode: "loopback" } })).toThrow("loopback");
  });

  it("applies persisted security settings to the Host runtime after restart", async () => {
    const gatewayPort = await freeTcpPort();
    const disposeEffects: Array<() => void | Promise<void>> = [];
    const persisted = {
      gateway: { gatewayHost: "127.0.0.1" as const, gatewayPort, exposeMode: "loopback" as const, advertisedEndpoint: "" },
      security: { tokenTtlMs: 25, approvalPolicy: "disabled" as const, maxMembers: 2, maxMessageBytes: 4, maxQueue: 1 },
    };
    let resolved: DshCollabPersistedSettings = persisted;
    let control: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
    const update = vi.fn(async (patch: object) => { resolved = { ...resolved, ...patch as Partial<DshCollabPersistedSettings> }; });
    const context = {
      agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
      inject: (_services: string[], callback: (ctx: { settings: { register: () => { get(): DshCollabPersistedSettings; update(patch: object): Promise<void> } } }) => void) => callback({ settings: { register: () => ({ get: () => resolved, update }) } }),
      effect: (factory: () => (() => void | Promise<void>) | void) => { const dispose = factory(); if (dispose) disposeEffects.push(dispose); return () => {}; },
      connection: { rpc: { handle: vi.fn((_channel: string, handler: typeof control) => { control = handler; return async () => {}; }) } },
    };

    apply(context, {
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host",
      allowLoopbackPrincipal: true, tokenTtlMs: 1000, maxMessageBytes: 1000, now: () => 10, tokenFactory: () => "room-token",
      ...noPersistence,
    });
    await control!("gateway/start", {}, new AbortController().signal);
    await waitUntilListening(gatewayPort);
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ gateway: persisted.gateway, appliedGateway: persisted.gateway }));

    try {
      const bootstrap = await fetch(`http://127.0.0.1:${String(gatewayPort)}/collab/v1/rooms/room-1/bootstrap`);
      const bootstrapBody = await bootstrap.json() as { data: { expiresAt: number; roomToken: string } };
      expect(bootstrapBody.data.expiresAt).toBe(35);
      const oversized = await fetch(`http://127.0.0.1:${String(gatewayPort)}/collab/v1/rooms/room-1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${bootstrapBody.data.roomToken}`, "content-type": "application/json" },
        body: JSON.stringify({ clientMessageId: "message-1", text: "hello" }),
      });
      expect(oversized.status).toBe(422);
    } finally {
      await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
    }
    expect(await canConnect(gatewayPort)).toBe(false);
  });

  it("starts a dedicated Gateway without mounting routes into the DSH WebServer", async () => {
    const mounted = mountDshCollabCordisHost({
      agents: { get: (sessionId) => sessionId === "session-1" ? { followup: () => {}, steer: () => {}, cancel: () => {} } : undefined },
    }, {
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", port: 0, ...noPersistence,
    });
    expect(mounted).toBeDefined();
    const port = await mounted!.ready;
    expect(port).toBeGreaterThan(0);
    expect(await canConnect(port)).toBe(true);
    await mounted!.dispose();
    expect(await canConnect(port)).toBe(false);
  });

  it("waits for an in-flight Gateway listen before immediate disposal", async () => {
    const mounted = mountDshCollabCordisHost({
      agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
    }, {
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", port: 0, ...noPersistence,
    });
    if (!mounted) throw new Error("Gateway was not mounted");
    const ready = mounted.ready;
    await mounted.dispose();
    const port = await ready;
    expect(await canConnect(port)).toBe(false);
  });

  it("restores Host room members and timeline from its state file after restart", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-collab-restart-"));
    const stateFile = join(dir, "state.json");
    const config = { roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", port: 0, stateFile };
    const context = { agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) } };
    try {
      const first = mountDshCollabCordisHost(context, config);
      if (!first) throw new Error("first Gateway did not mount");
      await first.ready;
      first.runtime.rooms.addMember("room-1", { memberId: "member-bob", principalId: "bob", displayName: "Bob", now: 2 });
      first.runtime.ledger.append({ eventId: "event-1", roomId: "room-1", type: "human.message", actor: { memberId: "member-bob", principalId: "bob" }, createdAt: 3, payload: { text: "hello" } });
      await first.dispose();

      const second = mountDshCollabCordisHost(context, config);
      if (!second) throw new Error("second Gateway did not mount");
      await second.ready;
      expect(second.runtime.rooms.listMembers("room-1")).toContainEqual(expect.objectContaining({ memberId: "member-bob" }));
      expect(second.runtime.ledger.readAfter("room-1", 0)).toContainEqual(expect.objectContaining({ eventId: "event-1" }));
      await second.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("can be disabled without starting a Gateway", () => {
    const mounted = mountDshCollabCordisHost({ agents: { get: () => undefined } }, {
      enabled: false, roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host",
    });
    expect(mounted).toBeUndefined();
  });

  it("keeps the Gateway stopped until the loopback control RPC starts it", async () => {
    const gatewayPort = await freeTcpPort();
    const disposeEffects: Array<() => void | Promise<void>> = [];
    let control: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
    let persisted: DshCollabPersistedSettings = {
      gateway: { gatewayHost: "127.0.0.1", gatewayPort, exposeMode: "loopback", advertisedEndpoint: "" },
    };
    const context = {
      agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
      effect: (factory: () => (() => void | Promise<void>) | void) => { const dispose = factory(); if (dispose) disposeEffects.push(dispose); return () => {}; },
      inject: (_services: string[], callback: (ctx: { settings: { register: () => { get(): DshCollabPersistedSettings; update(patch: object): Promise<void> } } }) => void) => callback({ settings: { register: () => ({ get: () => persisted, update: async (patch: object) => { persisted = { ...persisted, ...patch as Partial<DshCollabPersistedSettings> }; } }) } }),
      connection: { rpc: { handle: vi.fn((_channel: string, handler: NonNullable<typeof control>, options: unknown) => { control = handler; expect(options).toEqual({ authority: "loopback" }); return async () => {}; }) } },
    };
    apply(context, { roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", port: gatewayPort, ...noPersistence });
    expect(await canConnect(gatewayPort)).toBe(false);
    expect(control).toBeDefined();
    expect(await control!("gateway/status", {}, new AbortController().signal)).toMatchObject({ ok: true, value: { status: "stopped" } });
    await control!("gateway/start", {}, new AbortController().signal);
    await waitUntilListening(gatewayPort);
    expect(await control!("gateway/status", {}, new AbortController().signal)).toMatchObject({ ok: true, value: { status: "running", port: gatewayPort } });
    await control!("gateway/stop", {}, new AbortController().signal);
    expect(await canConnect(gatewayPort)).toBe(false);
    await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
  });

  it("does not start the removed local proxy when stale config is present", async () => {
    const targetPort = await freeTcpPort();
    const listenPort = await freeTcpPort();
    const disposeEffects: Array<() => void | Promise<void>> = [];
    const context = {
      agents: { get: () => undefined },
      effect: (factory: () => (() => void | Promise<void>) | void) => {
        const dispose = factory();
        if (dispose) disposeEffects.push(dispose);
        return () => {};
      },
    };

    try {
      apply(context, { localProxy: { enabled: true, targetPort, listenPort } } as Parameters<typeof apply>[1]);
      expect(disposeEffects).toHaveLength(0);
      expect(await canConnect(listenPort)).toBe(false);
    } finally {
      await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
    }
  }, 10_000);

  it("starts the Gateway without binding a room to the first DSH Agent", async () => {
    const gatewayPort = await freeTcpPort();
    const disposeEffects: Array<() => void | Promise<void>> = [];
    let control: ((endpoint: string, payload: unknown, signal: AbortSignal) => Promise<unknown>) | undefined;
    let persisted: DshCollabPersistedSettings = {
      gateway: { gatewayHost: "127.0.0.1", gatewayPort, exposeMode: "loopback", advertisedEndpoint: "" },
    };
    const context = {
      agents: { get: () => undefined },
      effect: (factory: () => (() => void | Promise<void>) | void) => { const dispose = factory(); if (dispose) disposeEffects.push(dispose); return () => {}; },
      inject: (_services: string[], callback: (ctx: { settings: { register: () => { get(): DshCollabPersistedSettings; update(patch: object): Promise<void> } } }) => void) => callback({ settings: { register: () => ({ get: () => persisted, update: async (patch: object) => { persisted = { ...persisted, ...patch as Partial<DshCollabPersistedSettings> }; } }) } }),
      connection: { rpc: { handle: vi.fn((_channel: string, handler: NonNullable<typeof control>) => { control = handler; return async () => {}; }) } },
    };
    apply(context, { roomId: "room-1", hostId: "host", title: "Room", hostDisplayName: "Host", port: gatewayPort, ...noPersistence });
    expect(await canConnect(gatewayPort)).toBe(false);
    await control!("gateway/start", {}, new AbortController().signal);
    await waitUntilListening(gatewayPort);
    expect((await fetch(`http://127.0.0.1:${String(gatewayPort)}/collab/v1/rooms/room-1/bootstrap`)).status).toBe(404);
    await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
    expect(await canConnect(gatewayPort)).toBe(false);
  });

  it("persists a session room created after the Gateway starts", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-collab-session-room-"));
    const stateFile = join(dir, "state.json");
    const config = { hostId: "host", hostDisplayName: "Host", port: 0, stateFile, allowLoopbackPrincipal: true };
    const context = { agents: { get: (sessionId: string) => sessionId === "session-current" ? { followup: () => {}, steer: () => {}, cancel: () => {} } : undefined } };
    try {
      const first = mountDshCollabCordisHost(context, config);
      if (!first) throw new Error("first Gateway did not mount");
      await first.ready;
      const shared = await first.runtime.gateway.handle({
        method: "POST", path: "/v1/rooms/session-current/host", auth: { principalId: "host" },
        body: { hostSessionId: "session-current", title: "Release room" },
      });
      expect(shared.status).toBe(200);
      await first.dispose();

      const second = mountDshCollabCordisHost(context, config);
      if (!second) throw new Error("second Gateway did not mount");
      await second.ready;
      expect(second.runtime.rooms.getRoom("session-current")).toMatchObject({ title: "Release room", hostSessionId: "session-current" });
      await second.dispose();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
