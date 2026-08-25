import { describe, expect, it } from "vitest";
import { renderLocalNginxConfig, resolveDshPort, resolveLocalProxyPort } from "../../src/nginx.js";

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
});
