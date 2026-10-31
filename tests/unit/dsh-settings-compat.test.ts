import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as pluginModule from "../../src/index.js";
import { Config, registerDshCollabSettings } from "../../src/index.js";
import type { DshCollabPersistedSettings } from "../../src/settings.js";

const context = { agents: {}, settings: {} } as never;

 describe("DSH settings compatibility", () => {
  it("keeps Config visible to the DSH Loader module shape", () => {
    expect(Object.hasOwn(pluginModule, "default")).toBe(false);
    expect(pluginModule.Config).toBe(Config);
  });
  it("marks the live Host settings as volatile for DSH SettingsForms", () => {
    expect(Config.meta.volatile).toBeUndefined();
    expect(Config.dict?.gateway?.meta.volatile).toBe(true);
    expect(Config.dict?.security?.meta.volatile).toBe(true);
    expect(Config.dict?.connectionMethod?.meta.volatile).toBe(true);
    expect(Config.dict?.easyTierSharedNode?.meta.volatile).toBe(true);
    expect(Config.dict?.joinedRooms?.meta.volatile).toBe(true);
  });
  it("unwraps volatile SettingsForms values before the Host lifecycle reads them", () => {
    const volatile = <T>(value: T) => ({ get: () => value });
    const current = {
      gateway: volatile({ gatewayHost: "0.0.0.0" as const, gatewayPort: 4310, exposeMode: "network" as const, advertisedEndpoint: "" }),
      appliedGateway: volatile({ gatewayHost: "0.0.0.0" as const, gatewayPort: 4310, exposeMode: "network" as const, advertisedEndpoint: "ws://10.231.0.1:4310/collab" }),
      security: volatile({ tokenTtlMs: 24 * 60 * 60 * 1000, approvalPolicy: "host-only" as const, maxMembers: 16, maxMessageBytes: 65536, maxQueue: 5 }),
      connectionMethod: volatile("easytier" as const),
      easyTierSharedNode: volatile("tcp://public.kkrainbow.top:11010"),
      easyTierRooms: volatile([]),
    };
    const scope = { get: () => current, update: async () => undefined };
    const settings = { register: () => scope };
    let resolved: DshCollabPersistedSettings | undefined;

    registerDshCollabSettings({ agents: {}, settings } as never, {}, (next) => { resolved = next; });

    expect(resolved?.gateway.gatewayHost).toBe("0.0.0.0");
    expect(resolved?.gateway.exposeMode).toBe("network");
    expect(resolved?.connectionMethod).toBe("easytier");
    expect(resolved?.easyTierSharedNode).toBe("tcp://public.kkrainbow.top:11010");
  });

  it("provides a runtime settings scope when current DSH has SettingsForms", async () => {
    let resolved: DshCollabPersistedSettings | undefined;
    let scope: { get(): DshCollabPersistedSettings; update(patch: object): Promise<void> } | undefined;

    registerDshCollabSettings(context, { host: "127.0.0.1", port: 4310 }, (settings, nextScope) => {
      resolved = settings;
      scope = nextScope;
    });

    expect(resolved?.gateway.gatewayHost).toBe("127.0.0.1");
    expect(resolved?.gateway.gatewayPort).toBe(4310);
    await scope!.update({ gateway: { ...scope!.get().gateway, gatewayPort: 4311 } });
    expect(scope!.get().gateway.gatewayPort).toBe(4311);
  });
  it("ships a complete safe gateway value for the Host SettingsForms row", () => {
    const patch = readFileSync(new URL("../../cordis.patch.yml", import.meta.url), "utf8");
    expect(patch).toMatch(/gateway:\s*\r?\n\s+gatewayHost:\s+0\.0\.0\.0\s*\r?\n\s+gatewayPort:\s+4310\s*\r?\n\s+exposeMode:\s+network/);
  });
});
