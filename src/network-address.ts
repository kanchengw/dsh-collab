import { networkInterfaces, type NetworkInterfaceInfo } from "node:os";

function privateIpv4(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  if (first === 192 && second === 168) return 0;
  if (first === 172 && second >= 16 && second <= 31) return 1;
  if (first === 10) return 2;
  return undefined;
}

/** Prefer a home/office LAN address over VPN-style RFC1918 ranges. */
export function detectPrivateNetworkAddress(input: NodeJS.Dict<NetworkInterfaceInfo[] | undefined> = networkInterfaces()): string | undefined {
  let selected: { address: string; priority: number } | undefined;
  for (const entries of Object.values(input)) {
    for (const entry of entries ?? []) {
      const priority = !entry.internal && entry.family === "IPv4" ? privateIpv4(entry.address) : undefined;
      if (priority !== undefined && (selected === undefined || priority < selected.priority)) selected = { address: entry.address, priority };
    }
  }
  return selected?.address;
}
