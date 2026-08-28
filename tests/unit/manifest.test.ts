import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateDshCollabManifest } from "../../src/manifest.js";

describe("dsh package manifest", () => {
  it("exposes one package with host bundle and browser face", () => {
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    expect(manifest.name).toBe("dsh-collab");
    expect(manifest.exports["./client"]).toBeDefined();
    expect(manifest.dsh.client.platform).toBe("web");
    expect(manifest.dsh.client.inject).toContain("@deepseek-ai/dsh-client-locale");
    expect(manifest.dsh.client.inject).not.toContain("@deepseek-ai/dsh-client-ui-slots");
    expect(manifest.peerDependencies["@deepseek-ai/dsh-agent"]).toBe(">=0.1.1-rc.2 <0.2.0");
    expect(manifest.devDependencies["@deepseek-ai/dsh-agent"]).toBe("0.1.1-rc.2");
    expect(manifest.peerDependencies["@deepseek-ai/dsh-client-ui-primitives"]).toBe(">=0.1.1-rc.2 <0.2.0");
    expect(manifest.devDependencies["@deepseek-ai/dsh-client-ui-primitives"]).toBe("0.1.1-rc.2");
    expect(readFileSync(resolve(process.cwd(), "src/dsh-client.ts"), "utf8")).not.toContain("dsh-client-ui-primitives/src/");
    expect(manifest.dsh.bundle.patch).toBe("./cordis.patch.yml");
    const patch = readFileSync(resolve(process.cwd(), "cordis.patch.yml"), "utf8");
    expect(patch).toContain("inject: [agentDefaultModel, agents, agentPresets, settings, connection, fs, subprocess]");
    expect(() => validateDshCollabManifest(manifest)).not.toThrow();
  });
});
