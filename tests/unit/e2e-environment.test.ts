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
      read("e2e/dsh-client.patch.yml"),
      read("e2e/prepare.ps1"),
      read("e2e/start.ps1"),
    ].join("\n");

    expect(assets).not.toMatch(/nginx|127\.0\.0\.2|3182|3183|participantGatewayUrl|trustedProxy|localProxy/i);
  });

  it("prepares two role-neutral clients from one symmetric patch", () => {
    const clientPatch = read("e2e/dsh-client.patch.yml");
    const prepare = read("e2e/prepare.ps1");
    const start = read("e2e/start.ps1");

    expect(existsSync(resolve(root, "e2e/dsh-host.patch.yml"))).toBe(false);
    expect(existsSync(resolve(root, "e2e/dsh-participant.patch.yml"))).toBe(false);
    expect(clientPatch).toContain("hostId: __CLIENT_ID__");
    expect(clientPatch).toContain("port: __GATEWAY_PORT__");
    expect(clientPatch).toContain("hostDisplayName: __CLIENT_DISPLAY_NAME__");
    expect(clientPatch).toContain("allowLoopbackPrincipal: true");
    expect(clientPatch).toContain("id: directory-picker\n  disabled: true");
    expect(clientPatch).toContain("@deepseek-ai/dsh-host-directory-picker-browse");
    expect(clientPatch).toContain("@deepseek-ai/dsh-client-ui-directory-picker-browse");

    expect(prepare).toContain('Id = "client-a"');
    expect(prepare).toContain('Id = "client-b"');
    expect(prepare).toContain("GatewayPort = 4312");
    expect(prepare).toContain("GatewayPort = 4313");
    expect(prepare).toContain("plugin --profile web add");
    expect(start).toContain('[ValidateSet("A", "B")]');
    expect(start).toContain('A = @{ Home = "client-a"; UiPort = 3082 }');
    expect(start).toContain('B = @{ Home = "client-b"; UiPort = 3083 }');
  });

  it("gives both clients the released private-network invitation path", () => {
    const settingsPatch = read("e2e/dsh-client.settings.patch.yml");
    const prepare = read("e2e/prepare.ps1");
    const releasePatch = read("cordis.patch.yml");
    const packageJson = JSON.parse(read("package.json")) as { files?: string[] };

    expect(settingsPatch).toContain("gatewayHost: 0.0.0.0");
    expect(settingsPatch).toContain("gatewayPort: __GATEWAY_PORT__");
    expect(settingsPatch).toContain("exposeMode: network");
    expect(settingsPatch).toContain("ws://__PRIVATE_ADDRESS__:__GATEWAY_PORT__/collab");
    expect(prepare).toContain("dsh-client.settings.patch.yml");
    expect(prepare).toContain("foreach ($client in $clients)");
    expect(prepare).toContain("plugin --profile web add $projectRoot");
    expect(prepare).toContain("lib/index.js");
    expect(prepare).toContain("lib/client.js");
    expect(releasePatch).not.toMatch(/4312|4313|__PRIVATE_ADDRESS__/);
    expect(packageJson.files?.some((entry) => entry === "e2e" || entry.startsWith("e2e/"))).toBe(false);
  });
});
