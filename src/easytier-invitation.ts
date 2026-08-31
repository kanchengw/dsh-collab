export const EASYTIER_INVITATION_VERSION = 1 as const;

export interface EasyTierInvitationNetwork {
  mode: "easytier";
  version: typeof EASYTIER_INVITATION_VERSION;
  networkName: string;
  networkSecret: string;
  ownerVirtualAddress: string;
  sharedNode: string;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`invitation network.${field} must not be blank`);
  return value.trim();
}

export function assertEasyTierName(field: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error(`${field} is invalid`);
}

export function assertEasyTierNetworkSecret(value: string): void {
  if (value.length < 8 || value.length > 256 || /["\\\0-\x1f\x7f]/.test(value)) throw new Error("networkSecret is invalid");
}

export function assertEasyTierPrivateIpv4(field: string, value: string): void {
  const parts = value.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part) || Number(part) > 255)) throw new Error(`${field} is invalid`);
  const [a, b] = parts.map(Number);
  if (!(a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168))) throw new Error(`${field} must be private IPv4`);
}

export function assertEasyTierPeer(field: string, value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} is invalid`);
  }
  if (!new Set(["tcp:", "udp:", "wg:", "quic:", "ws:", "wss:"]).has(url.protocol)
    || !url.hostname || !url.port || url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error(`${field} is invalid`);
  }
}

export function decodeEasyTierInvitationNetwork(value: unknown): EasyTierInvitationNetwork {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invitation network must be an object");
  const input = value as Record<string, unknown>;
  if (input.version !== EASYTIER_INVITATION_VERSION) throw new Error("invitation network.version is not supported");
  const networkName = requiredText(input.networkName, "networkName");
  const networkSecret = requiredText(input.networkSecret, "networkSecret");
  const ownerVirtualAddress = requiredText(input.ownerVirtualAddress, "ownerVirtualAddress");
  const sharedNode = requiredText(input.sharedNode, "sharedNode");
  assertEasyTierName("networkName", networkName);
  assertEasyTierNetworkSecret(networkSecret);
  assertEasyTierPrivateIpv4("ownerVirtualAddress", ownerVirtualAddress);
  assertEasyTierPeer("sharedNode", sharedNode);
  return {
    mode: "easytier",
    version: EASYTIER_INVITATION_VERSION,
    networkName,
    networkSecret,
    ownerVirtualAddress,
    sharedNode,
  };
}
