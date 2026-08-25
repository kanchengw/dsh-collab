function endpointError(message: string): never {
  throw new Error(`gatewayEndpoint ${message}`);
}

function ipv4Parts(hostname: string): number[] | undefined {
  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const values = parts.map(Number);
  return values.every((part) => part >= 0 && part <= 255) ? values : undefined;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1") return true;
  const ipv4 = ipv4Parts(host);
  if (ipv4) {
    return ipv4[0] === 10
      || ipv4[0] === 127
      || (ipv4[0] === 100 && ipv4[1]! >= 64 && ipv4[1]! <= 127)
      || (ipv4[0] === 169 && ipv4[1] === 254)
      || (ipv4[0] === 172 && ipv4[1]! >= 16 && ipv4[1]! <= 31)
      || (ipv4[0] === 192 && ipv4[1] === 168);
  }
  return host.includes(":") && (/^f[cd]/.test(host) || /^fe[89ab]/.test(host));
}

function isUnspecifiedHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "0.0.0.0" || host === "::";
}

export function normalizeGatewayEndpoint(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return endpointError("must be a ws(s) URL");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") endpointError("must be a ws(s) URL");
  if (url.username || url.password || url.search || url.hash) endpointError("must not contain credentials, query, or fragment");
  if (url.pathname.replace(/\/+$/, "") !== "/collab") endpointError("path must be /collab");
  if (isUnspecifiedHost(url.hostname)) endpointError("must use a reachable address; use wss for public endpoints");
  if (url.protocol === "ws:" && !isPrivateHost(url.hostname)) endpointError("must use wss for public endpoints");
  url.pathname = "/collab";
  return url.toString();
}

export function gatewayHttpUrl(endpoint: string): string {
  const url = new URL(normalizeGatewayEndpoint(endpoint));
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  return url.toString();
}

export function normalizeAdvertisedGatewayEndpoint(value: string, exposeMode: "loopback" | "network"): string {
  const normalized = normalizeGatewayEndpoint(value);
  const url = new URL(normalized);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (exposeMode === "network" && loopback) throw new Error("advertisedEndpoint cannot use a loopback address in network mode");
  if (exposeMode === "loopback" && url.protocol === "ws:" && !loopback) throw new Error("advertisedEndpoint cannot use a LAN address in loopback mode");
  return normalized;
}
