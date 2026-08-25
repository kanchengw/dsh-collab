import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("installable package build", () => {
  it("builds only the host and browser faces and keeps one package patch row", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const buildConfig = JSON.parse(readFileSync(resolve(process.cwd(), "tsconfig.build.json"), "utf8"));
    const patch = readFileSync(resolve(process.cwd(), "cordis.patch.yml"), "utf8");
    expect(packageJson.scripts.clean).toContain("rmSync('lib'");
    expect(packageJson.scripts.build).toMatch(/^pnpm clean && /);
    expect(packageJson.scripts.build).toContain("tsconfig.build.json");
    expect(buildConfig.compilerOptions.rootDir).toBe("src");
    expect(packageJson.exports["./client"]).toBeDefined();
    expect(packageJson.exports["./nginx"]).toBeDefined();
    expect(packageJson.files).toContain("vendor");
    expect(packageJson.files).toContain("LICENSE.nginx");
    expect((patch.match(/name: dsh-collab\s*$/gm) ?? []).length).toBe(1);
    expect(patch).not.toContain("dsh-collab/client");
  });
});
