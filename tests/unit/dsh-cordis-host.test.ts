import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createConnection, createServer as createTcpServer } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { mountDshCollabCordisHost } from "../../src/dsh-cordis-host.js";
import { authenticateCollabRequest, isLoopbackAddress } from "../../src/http.js";
import { apply, DSH_COLLAB_SETTINGS_NAMESPACE, type DshCollabPersistedSettings } from "../../src/index.js";

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
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`test port ${String(port)} did not start listening`);
}

describe("Cordis Host mount", () => {
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
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { "x-forwarded-for": "203.0.113.9" }, remoteAddress: "10.0.0.5" }, options)).toEqual({});
    expect(authenticateCollabRequest({ method: "GET", path: "/", headers: { "x-forwarded-for": "203.0.113.9", "x-authenticated-user": "alice" }, remoteAddress: "10.0.0.5" }, options)).toEqual({ principalId: "alice" });
  });

  it("registers the formal dsh-collab settings namespace with safe composition defaults", () => {
    const register = vi.fn((_namespace: string, _schema: unknown, options: { base: DshCollabPersistedSettings; validate(value: unknown): void }) => ({ get: () => options.base }));
    const context = {
      webServer: { register: vi.fn(), registerUpgrade: vi.fn() },
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
          gateway: { gatewayHost: "127.0.0.1", gatewayPort: 3080, exposeMode: "loopback" },
          participantGatewayUrl: "",
          security: { tokenTtlMs: 8 * 60 * 60 * 1000, maxMembers: 16, maxMessageBytes: 64 * 1024, maxQueue: 32, approvalPolicy: "host-only" },
        }),
        validate: expect.any(Function),
      }),
    );
    const options = register.mock.calls[0]?.[2];
    if (!options) throw new Error("settings registration options were not captured");
    expect(() => options.validate({ gateway: { gatewayHost: "0.0.0.0", gatewayPort: 3080, exposeMode: "loopback" } })).toThrow("loopback");
  });

  it("applies persisted security settings to the Host runtime after restart", async () => {
    let routeHandler: ((request: IncomingMessage, response: ServerResponse) => void | Promise<void>) | undefined;
    const disposeEffects: Array<() => void | Promise<void>> = [];
    const persisted = {
      gateway: { gatewayHost: "127.0.0.1" as const, gatewayPort: 0, exposeMode: "loopback" as const },
      participantGatewayUrl: "",
      security: { tokenTtlMs: 25, approvalPolicy: "disabled" as const, maxMembers: 2, maxMessageBytes: 4, maxQueue: 1 },
    };
    const context = {
      webServer: {
        register: ({ handler }: { handler: typeof routeHandler }) => { routeHandler = handler; return () => { routeHandler = undefined; }; },
        registerUpgrade: vi.fn(() => () => {}),
      },
      agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
      inject: (_services: string[], callback: (ctx: { settings: { register: () => { get(): typeof persisted } } }) => void) => callback({ settings: { register: () => ({ get: () => persisted }) } }),
      effect: (factory: () => (() => void | Promise<void>) | void) => { const dispose = factory(); if (dispose) disposeEffects.push(dispose); return () => {}; },
    };

    apply(context, {
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host",
      allowLoopbackPrincipal: true, tokenTtlMs: 1000, maxMessageBytes: 1000, now: () => 10, tokenFactory: () => "room-token",
    });
    expect(routeHandler).toBeDefined();
    const server = createHttpServer((request, response) => { void routeHandler?.(request, response); });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test HTTP server did not bind a TCP port");

    try {
      const bootstrap = await fetch(`http://127.0.0.1:${String(address.port)}/collab/v1/rooms/room-1/bootstrap`);
      const bootstrapBody = await bootstrap.json() as { data: { expiresAt: number; roomToken: string } };
      expect(bootstrapBody.data.expiresAt).toBe(35);
      const oversized = await fetch(`http://127.0.0.1:${String(address.port)}/collab/v1/rooms/room-1/messages`, {
        method: "POST",
        headers: { authorization: `Bearer ${bootstrapBody.data.roomToken}`, "content-type": "application/json" },
        body: JSON.stringify({ clientMessageId: "message-1", text: "hello" }),
      });
      expect(oversized.status).toBe(422);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
    }
  });

  it("mounts the Gateway into the real WebServer route contract and unwinds it", async () => {
    const http: string[] = [];
    const upgrades: string[] = [];
    const mounted = mountDshCollabCordisHost({
      webServer: {
        register: vi.fn(({ path }: { path: string }) => { http.push(path); return () => http.splice(http.indexOf(path), 1); }),
        registerUpgrade: vi.fn(({ path }: { path: string }) => { upgrades.push(path); return () => upgrades.splice(upgrades.indexOf(path), 1); }),
      },
      agents: { get: (sessionId) => sessionId === "session-1" ? { followup: () => {}, steer: () => {}, cancel: () => {} } : undefined },
    }, {
      roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", port: 0,
    });
    expect(mounted).toBeDefined();
    expect(http).toEqual(["/collab"]);
    expect(upgrades).toEqual(["/collab/v1/stream"]);
    await mounted!.dispose();
    expect(http).toEqual([]);
    expect(upgrades).toEqual([]);
  });

  it("can be disabled without touching WebServer", () => {
    const register = vi.fn();
    const mounted = mountDshCollabCordisHost({ webServer: { register, registerUpgrade: vi.fn() }, agents: { get: () => undefined } }, {
      enabled: false, roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host",
    });
    expect(mounted).toBeUndefined();
    expect(register).not.toHaveBeenCalled();
  });

  it("wires the package default apply to a configured Cordis context", async () => {
    const http: string[] = [];
    const disposeEffects: Array<() => void | Promise<void>> = [];
    const context = {
      webServer: {
        register: ({ path }: { path: string }) => { http.push(path); return () => http.splice(http.indexOf(path), 1); },
        registerUpgrade: ({ path }: { path: string }) => { http.push(path); return () => http.splice(http.indexOf(path), 1); },
      },
      agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
      effect: (factory: () => (() => void | Promise<void>) | void) => { const dispose = factory(); if (dispose) disposeEffects.push(dispose); return () => {}; },
    };
    apply(context, { roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host" });
    expect(http).toEqual(["/collab", "/collab/v1/stream"]);
    await Promise.all(disposeEffects.map(async (dispose) => { await dispose(); }));
    expect(http).toEqual([]);
  });

  it("returns an async Cordis disposer that waits for bundled nginx to stop", async () => {
    if (process.platform !== "win32" || process.arch !== "x64") return;
    const targetPort = await freeTcpPort();
    const listenPort = await freeTcpPort();
    const disposeEffects: Array<() => void | Promise<void>> = [];
    const context = {
      webServer: { register: vi.fn(), registerUpgrade: vi.fn() },
      agents: { get: () => undefined },
      effect: (factory: () => (() => void | Promise<void>) | void) => {
        const dispose = factory();
        if (dispose) disposeEffects.push(dispose);
        return () => {};
      },
    };

    apply(context, { localProxy: { enabled: true, targetPort, listenPort } });
    await waitUntilListening(listenPort);
    expect(disposeEffects).toHaveLength(1);

    const disposal = disposeEffects[0]!();
    expect(disposal).toBeInstanceOf(Promise);
    await disposal;
    expect(await canConnect(listenPort)).toBe(false);
  }, 10_000);

  it("waits for the first real DSH Agent when Web creates sessions lazily", async () => {
    let created: ((payload: { agent: { id: string } }) => void) | undefined;
    const http: string[] = [];
    const context = {
      webServer: {
        register: ({ path }: { path: string }) => { http.push(path); return () => http.splice(http.indexOf(path), 1); },
        registerUpgrade: ({ path }: { path: string }) => { http.push(path); return () => http.splice(http.indexOf(path), 1); },
      },
      agents: { get: (id: string) => id === "session-created" ? { followup: () => {}, steer: () => {}, cancel: () => {} } : undefined },
      on: (_event: "agent/created", listener: (payload: { agent: { id: string } }) => void) => { created = listener; return () => { created = undefined; }; },
    };
    apply(context, { roomId: "room-1", hostId: "host", title: "Room", hostDisplayName: "Host" });
    expect(http).toEqual([]);
    created?.({ agent: { id: "session-created" } });
    expect(http).toEqual(["/collab", "/collab/v1/stream"]);
  });
});
