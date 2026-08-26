import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(resolve(root, path), "utf8");
}

describe("isolated two-DSH browser environment", () => {
  it("contains no nginx or trusted-proxy test topology", () => {
    expect(existsSync(resolve(root, "e2e/nginx"))).toBe(false);

    const assets = [
      read("e2e/dsh-host.patch.yml"),
      read("e2e/dsh-participant.patch.yml"),
      read("e2e/prepare.ps1"),
      read("e2e/start-host.ps1"),
      read("e2e/start-participant.ps1"),
    ].join("\n");

    expect(assets).not.toMatch(/nginx|127\.0\.0\.2|3182|3183|participantGatewayUrl|trustedProxy|localProxy/i);
  });

  it("gives each complete plugin installation its own DSH home and Gateway", () => {
    const hostPatch = read("e2e/dsh-host.patch.yml");
    const participantPatch = read("e2e/dsh-participant.patch.yml");
    const prepare = read("e2e/prepare.ps1");
    const startHost = read("e2e/start-host.ps1");
    const startParticipant = read("e2e/start-participant.ps1");

    expect(hostPatch).toContain("allowLoopbackPrincipal: true");
    expect(hostPatch).toContain("port: 4312");
    expect(hostPatch).toContain("id: directory-picker\n  disabled: true");
    expect(hostPatch).toContain("@deepseek-ai/dsh-host-directory-picker-browse");
    expect(hostPatch).toContain("@deepseek-ai/dsh-client-ui-directory-picker-browse");
    expect(participantPatch).toContain("allowLoopbackPrincipal: true");
    expect(participantPatch).toContain("port: 4313");

    expect(prepare).toContain("plugin --profile web add");
    expect(prepare).toContain("e2e/.state/host");
    expect(prepare).toContain("e2e/.state/participant");
    expect(startHost).toContain("--port 3082 --no-open");
    expect(startParticipant).toContain("--port 3083 --no-open");
  });

  it("layers same-machine connectivity over the unchanged release package", () => {
    const hostPatch = read("e2e/dsh-host.patch.yml");
    const settingsPatch = read("e2e/dsh-host.settings.patch.yml");
    const prepare = read("e2e/prepare.ps1");
    const releasePatch = read("cordis.patch.yml");
    const packageJson = JSON.parse(read("package.json")) as { files?: string[] };

    expect(settingsPatch).toContain("gatewayHost: 0.0.0.0");
    expect(settingsPatch).toContain("gatewayPort: 4312");
    expect(settingsPatch).toContain("exposeMode: network");
    expect(settingsPatch).toContain("ws://__HOST_ADDRESS__:4312/collab");
    expect(prepare).toContain("dsh-host.settings.patch.yml");
    expect(prepare).toContain("plugin --profile web add $projectRoot");
    expect(prepare).toContain("lib/index.js");
    expect(prepare).toContain("lib/client.js");
    expect(hostPatch).not.toMatch(/^\s*name:\s*dsh-collab\s*$/m);
    expect(releasePatch).not.toMatch(/4312|4313|__HOST_ADDRESS__/);
    expect(packageJson.files?.some((entry) => entry === "e2e" || entry.startsWith("e2e/"))).toBe(false);
  });
});
