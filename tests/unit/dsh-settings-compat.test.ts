import { describe, expect, it } from "vitest";
import { registerDshCollabSettings } from "../../src/index.js";
import type { DshCollabPersistedSettings } from "../../src/settings.js";

const context = { agents: {}, settings: {} } as never;

describe("DSH settings compatibility", () => {
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
});
