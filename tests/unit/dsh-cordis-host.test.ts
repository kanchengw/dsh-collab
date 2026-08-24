import { describe, expect, it, vi } from "vitest";
import { mountDshCollabCordisHost } from "../../src/dsh-cordis-host.js";
import { authenticateCollabRequest, isLoopbackAddress } from "../../src/http.js";
import { apply, DSH_COLLAB_SETTINGS_NAMESPACE } from "../../src/index.js";

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
    const register = vi.fn();
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
    const options = register.mock.calls[0]?.[2] as { validate(value: unknown): void };
    expect(() => options.validate({ gateway: { gatewayHost: "0.0.0.0", gatewayPort: 3080, exposeMode: "loopback" } })).toThrow("loopback");
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
    const disposeEffects: Array<() => void> = [];
    const context = {
      webServer: {
        register: ({ path }: { path: string }) => { http.push(path); return () => http.splice(http.indexOf(path), 1); },
        registerUpgrade: ({ path }: { path: string }) => { http.push(path); return () => http.splice(http.indexOf(path), 1); },
      },
      agents: { get: () => ({ followup: () => {}, steer: () => {}, cancel: () => {} }) },
      effect: (factory: () => (() => void) | void) => { const dispose = factory(); if (dispose) disposeEffects.push(dispose); return () => {}; },
    };
    apply(context, { roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host" });
    expect(http).toEqual(["/collab", "/collab/v1/stream"]);
    for (const dispose of disposeEffects) dispose();
    await new Promise((resolve) => setImmediate(resolve));
    expect(http).toEqual([]);
  });

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
