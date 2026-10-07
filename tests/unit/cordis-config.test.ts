import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("dsh-collab host profile defaults", () => {
  it("keeps the private-network connection method aligned with a network Gateway", () => {
    const patch = readFileSync(resolve(process.cwd(), "cordis.patch.yml"), "utf8");
    expect(patch).toMatch(/host:\s+0\.0\.0\.0/);
    expect(patch).toMatch(/gatewayHost:\s+0\.0\.0\.0/);
    expect(patch).toMatch(/exposeMode:\s+network/);
  });
});
