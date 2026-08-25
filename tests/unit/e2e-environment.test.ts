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
    expect(participantPatch).toContain("allowLoopbackPrincipal: true");
    expect(participantPatch).toContain("port: 4313");

    expect(prepare).toContain("plugin --profile web add");
    expect(prepare).toContain("e2e/.state/host");
    expect(prepare).toContain("e2e/.state/participant");
    expect(startHost).toContain("--port 3082 --no-open");
    expect(startParticipant).toContain("--port 3083 --no-open");
  });
});
