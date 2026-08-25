import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("installable package build", () => {
  it("keeps browser-only modules out of the built Host root", () => {
    const entry = readFileSync(resolve(process.cwd(), "lib/index.js"), "utf8");
    expect(entry).not.toMatch(/dsh-client|dsh-browser-client|collab-settings-card/);
  });

  it("builds only the host and browser faces and keeps one package patch row", () => {
    const packageJson = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
    const buildConfig = JSON.parse(readFileSync(resolve(process.cwd(), "tsconfig.build.json"), "utf8"));
    const patch = readFileSync(resolve(process.cwd(), "cordis.patch.yml"), "utf8");
    expect(packageJson.scripts.clean).toContain("rmSync('lib'");
    expect(packageJson.scripts.build).toMatch(/^pnpm clean && /);
    expect(packageJson.scripts.build).toContain("tsconfig.build.json");
    expect(buildConfig.compilerOptions.rootDir).toBe("src");
    expect(packageJson.exports["./client"]).toBeDefined();
    expect(packageJson.exports["./nginx"]).toBeUndefined();
    expect(packageJson.files).not.toContain("vendor");
    expect(packageJson.files).not.toContain("LICENSE.nginx");
    expect(existsSync(resolve(process.cwd(), "src/nginx.ts"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), "src/webserver.ts"))).toBe(false);
    expect(existsSync(resolve(process.cwd(), "vendor/nginx/windows-x64/nginx.exe"))).toBe(false);
    expect((patch.match(/name: dsh-collab\s*$/gm) ?? []).length).toBe(1);
    expect(patch).not.toContain("dsh-collab/client");
    expect(patch).not.toContain("localProxy");
    expect(patch).not.toContain("127.0.0.2");
  });
});
