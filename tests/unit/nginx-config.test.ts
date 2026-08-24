import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const configPath = resolve(process.cwd(), "e2e/nginx/nginx.conf");

describe("local two-DSH nginx boundary", () => {
  it("keeps the requested DSH ports and separate browser entry points", () => {
    const config = readFileSync(configPath, "utf8");

    expect(config).toContain("server 127.0.0.1:3082;");
    expect(config).toContain("server 127.0.0.1:3083;");
    expect(config).toContain("listen 3182;");
    expect(config).toContain("listen 3183;");
    expect(config).not.toMatch(/\b3080\b|\b3081\b/);
  });

  it("routes both collab paths to the Host DSH with trusted proxy headers", () => {
    const config = readFileSync(configPath, "utf8");

    expect(config).toMatch(/location \^~ \/collab\//);
    expect(config.match(/proxy_pass http:\/\/dsh_host;/g)).toHaveLength(3);
    expect(config.match(/proxy_bind 127\.0\.0\.2;/g)).toHaveLength(2);
    expect(config.match(/proxy_set_header Upgrade \$http_upgrade;/g)).toHaveLength(4);
    expect(config.match(/proxy_set_header Connection \$connection_upgrade;/g)).toHaveLength(4);
    expect(config.match(/proxy_set_header X-DSH-Proxy "1";/g)).toHaveLength(2);
    expect(config.match(/proxy_read_timeout 1h;/g)).toHaveLength(2);
    expect(config.match(/proxy_buffering off;/g)).toHaveLength(2);
  });
});
