import { describe, expect, it, vi } from "vitest";
import { mountDshCollabCordisHost } from "../../src/dsh-cordis-host.js";
import { apply } from "../../src/index.js";

describe("Cordis Host mount", () => {
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
