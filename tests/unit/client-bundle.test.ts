import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("browser client bundle", () => {
  it("does not require the server-side schema runtime", () => {
    const bundle = readFileSync(resolve(process.cwd(), "lib/client.js"), "utf8");
    expect(bundle).not.toContain("@deepseek-ai/schemastery");
    expect(bundle).not.toMatch(/^import ['"]\.\/style\.css['"];?/m);
    expect(bundle).toContain("data-dsh-collab-css");
  });
});
