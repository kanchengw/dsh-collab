import { mkdtemp } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalNginxProxy, renderLocalNginxConfig, resolveDshPort, resolveLocalProxyPort } from "../../src/nginx.js";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
  return address.port;
}

describe("bundled local nginx", () => {
  it("renders a restricted HTTP/WebSocket proxy with trusted identity injection", () => {
    const config = renderLocalNginxConfig({ targetPort: 3083, collabTargetPort: 3082, listenPort: 3183, principalId: "participant" });

    expect(config).toContain("listen 127.0.0.1:3183;");
    expect(config).toContain("server 127.0.0.1:3083;");
    expect(config).toContain("server 127.0.0.1:3082;");
    expect(config).toContain("proxy_bind 127.0.0.2;");
    expect(config).toContain("proxy_set_header X-DSH-Principal-Id \"\";");
    expect(config).toContain("proxy_set_header x-authenticated-user \"participant\";");
    expect(config).toContain("proxy_set_header x-dsh-proxy \"1\";");
    expect(config).toContain("proxy_set_header Upgrade $http_upgrade;");
    expect(config).toContain("proxy_read_timeout 1h;");
    expect(config).toContain("\"http://127.0.0.1:3083\" $http_origin;");
    expect(config).toContain("add_header Access-Control-Allow-Origin $dsh_collab_cors_origin always;");
    expect(config).toContain("add_header Access-Control-Allow-Headers \"Accept, Authorization, Content-Type\" always;");
    expect(config).toContain("return 204;");
    expect(config).toContain("access_log off;");
    expect(config).toMatch(/location \^~ \/collab\/ \{[\s\S]*proxy_bind 127\.0\.0\.2;[\s\S]*proxy_pass http:\/\/dsh_collab_target;/);
    expect(config).toContain("location / {\n            proxy_pass http://dsh_browser_target;");
  });

  it("derives the hidden proxy port beside the DSH listener", () => {
    expect(resolveLocalProxyPort(3082)).toBe(3182);
    expect(resolveLocalProxyPort(3082, 3900)).toBe(3900);
  });

  it("accepts the real DSH port override", () => {
    expect(resolveDshPort(3083)).toBe(3083);
  });

  it("starts the bundled Windows nginx with its generated runtime config", async () => {
    if (process.platform !== "win32" || process.arch !== "x64") return;
    const listenPort = await freePort();
    const runtimeDir = await mkdtemp(join(tmpdir(), "dsh-collab-nginx-test-"));
    const proxy = createLocalNginxProxy({ targetPort: 3080, listenPort, principalId: "test", runtimeDir });

    try {
      await proxy.start();
      await expect(new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port: listenPort });
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
      })).resolves.toBeUndefined();
    } finally {
      await proxy.dispose();
    }
  }, 10_000);

  it("rejects a proxy port already owned by another process", async () => {
    if (process.platform !== "win32" || process.arch !== "x64") return;
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (!address || typeof address === "string") throw new Error("occupied test server did not bind a TCP port");
    const runtimeDir = await mkdtemp(join(tmpdir(), "dsh-collab-nginx-collision-"));
    const proxy = createLocalNginxProxy({ targetPort: 3080, listenPort: address.port, principalId: "test", runtimeDir });

    try {
      await expect(proxy.start()).rejects.toThrow(/proxy port/i);
    } finally {
      await proxy.dispose();
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }
  }, 10_000);
});
