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
    expect(manifest.dsh.bundle.patch).toBe("./cordis.patch.yml");
    expect(() => validateDshCollabManifest(manifest)).not.toThrow();
  });
});
