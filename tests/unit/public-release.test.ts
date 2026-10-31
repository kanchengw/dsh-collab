import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("public release hygiene", () => {
  it("does not track internal design records, generated graphs or private settings", () => {
    const internalPaths = [
      "AGENTS.md",
      "design.md",
      "dev_log.md",
      "docs/plans",
      "docs/decisions",
      "docs/spikes",
      "e2e/dsh-client.settings.patch.yml",
      "graphify-out",
      "scripts/graphify-unit-snapshot.ps1",
    ];
    const tracked = execFileSync("git", ["ls-files", "--", ...internalPaths], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    expect(tracked).toBe("");

    const ignore = read(".gitignore");
    for (const pattern of [
      "/design.md",
      "/dev_log.md",
      "/docs/plans/",
      "/docs/decisions/",
      "/docs/spikes/",
      "/e2e/dsh-client.settings.patch.yml",
      "/graphify-out/",
    ]) {
      expect(ignore).toContain(pattern);
    }
  });

  it("publishes a complete README without links to private documents or assets", () => {
    const readme = read("README.md");
    const packageJson = JSON.parse(read("package.json")) as { files?: string[]; repository?: { url?: string } };

    expect(readme).toContain("## Requirements");
    expect(readme).toContain("## Install from source");
    expect(readme).toContain("## Quick start");
    expect(readme).toContain("## Security and privacy");
    expect(readme).toContain("## Development");
    expect(readme).toContain("[Wire protocol](./protocol.md)");
    expect(readme).not.toMatch(/docs\/plans|docs\/decisions|dev_log\.md|design\.md/);
    expect(existsSync(resolve(root, "assets/dsh-collab-github-header-roundtable-v9-chat-team.png"))).toBe(true);
    expect(packageJson.files).not.toContain("design.md");
    expect(packageJson.repository?.url).toBe("git+https://github.com/kanchengw/dsh-collab.git");
  });
});
