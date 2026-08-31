import { randomBytes, randomInt, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { DEFAULT_EASYTIER_SHARED_NODE, EASYTIER_INVITATION_VERSION, decodeEasyTierInvitationNetwork, type EasyTierInvitationNetwork } from "./easytier-invitation.js";
import type { EasyTierRuntimeStartInput, EasyTierRuntimeStatus } from "./easytier-runtime.js";

export { DEFAULT_EASYTIER_SHARED_NODE } from "./easytier-invitation.js";
export const DEFAULT_EASYTIER_OWNER_ADDRESS = "10.231.0.1";

export interface EasyTierManagedRuntime {
  status(): EasyTierRuntimeStatus;
  start(input: EasyTierRuntimeStartInput, signal?: AbortSignal): Promise<EasyTierRuntimeStatus>;
  diagnose(targetIpv4: string, signal?: AbortSignal): Promise<EasyTierRuntimeStatus>;
  stop(): Promise<EasyTierRuntimeStatus>;
}

export interface EasyTierPortAllocator {
  allocate(): Promise<number>;
}

export const loopbackEasyTierPorts: EasyTierPortAllocator = {
  allocate: () => new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate an EasyTier port"));
        return;
      }
      server.close((error) => { if (error) reject(error); else resolve(address.port); });
    });
  }),
};

export interface EasyTierTransportCredentials {
  networkName(): string;
  networkSecret(): string;
  participantVirtualAddress(): string;
}

const defaultCredentials: EasyTierTransportCredentials = {
  networkName: () => `dsh-collab-${randomUUID().replaceAll("-", "")}`,
  networkSecret: () => randomBytes(32).toString("base64url"),
  participantVirtualAddress: () => `10.231.${String(randomInt(1, 255))}.${String(randomInt(2, 255))}`,
};

export interface ActiveEasyTierTransport {
  role: "owner" | "participant";
  roomId: string;
  gatewayEndpoint: string;
  network: EasyTierInvitationNetwork;
  localVirtualAddress: string;
}

export type EasyTierTransportSnapshot =
  | { active: false; runtime: EasyTierRuntimeStatus }
  | ({ active: true; runtime: EasyTierRuntimeStatus } & ActiveEasyTierTransport);

export class EasyTierTransportCoordinator {
  private readonly runtime: EasyTierManagedRuntime;
  private readonly ports: EasyTierPortAllocator;
  private readonly credentials: EasyTierTransportCredentials;
  private readonly routeWait: { timeoutMs: number; now(): number; sleep(ms: number): Promise<void> };
  private active?: ActiveEasyTierTransport;

  constructor(options: {
    runtime: EasyTierManagedRuntime;
    ports?: EasyTierPortAllocator;
    credentials?: EasyTierTransportCredentials;
    routeWait?: { timeoutMs: number; now(): number; sleep(ms: number): Promise<void> };
  }) {
    this.runtime = options.runtime;
    this.ports = options.ports ?? loopbackEasyTierPorts;
    this.credentials = options.credentials ?? defaultCredentials;
    this.routeWait = options.routeWait ?? { timeoutMs: 15_000, now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) };
  }

  snapshot(): EasyTierTransportSnapshot {
    const runtime = this.runtime.status();
    return this.active
      ? { active: true, ...structuredClone(this.active), runtime }
      : { active: false, runtime };
  }

  async startOwner(input: {
    roomId: string;
    gatewayPort: number;
    network?: EasyTierInvitationNetwork;
    sharedNode?: string;
    signal?: AbortSignal;
  }): Promise<ActiveEasyTierTransport> {
    const roomId = requiredRoomId(input.roomId);
    validPort(input.gatewayPort);
    const network = input.network ? decodeEasyTierInvitationNetwork(input.network) : {
      mode: "easytier" as const,
      version: EASYTIER_INVITATION_VERSION,
      networkName: this.credentials.networkName(),
      networkSecret: this.credentials.networkSecret(),
      ownerVirtualAddress: DEFAULT_EASYTIER_OWNER_ADDRESS,
      sharedNode: input.sharedNode ?? DEFAULT_EASYTIER_SHARED_NODE,
    };
    const existing = this.matchActive("owner", roomId, network);
    if (existing) return existing;
    const [listenerPort, rpcPort] = await Promise.all([this.ports.allocate(), this.ports.allocate()]);
    await this.runtime.start({
      instanceName: instanceName("owner", roomId),
      networkName: network.networkName,
      networkSecret: network.networkSecret,
      virtualIpv4: network.ownerVirtualAddress,
      listenerPort,
      rpcPort,
      peers: [network.sharedNode],
    }, input.signal);
    this.active = {
      role: "owner",
      roomId,
      gatewayEndpoint: `ws://${network.ownerVirtualAddress}:${String(input.gatewayPort)}/collab`,
      network,
      localVirtualAddress: network.ownerVirtualAddress,
    };
    return structuredClone(this.active);
  }

  async startParticipant(input: {
    roomId: string;
    gatewayPort: number;
    network: EasyTierInvitationNetwork;
    localVirtualAddress?: string;
    signal?: AbortSignal;
  }): Promise<ActiveEasyTierTransport> {
    const roomId = requiredRoomId(input.roomId);
    validPort(input.gatewayPort);
    const network = decodeEasyTierInvitationNetwork(input.network);
    const existing = this.matchActive("participant", roomId, network);
    if (existing) return existing;
    const localVirtualAddress = input.localVirtualAddress ?? this.credentials.participantVirtualAddress();
    const [listenerPort, rpcPort, bridgePort] = await Promise.all([
      this.ports.allocate(),
      this.ports.allocate(),
      this.ports.allocate(),
    ]);
    await this.runtime.start({
      instanceName: instanceName("participant", roomId),
      networkName: network.networkName,
      networkSecret: network.networkSecret,
      virtualIpv4: localVirtualAddress,
      listenerPort,
      rpcPort,
      peers: [network.sharedNode],
      portForward: {
        listenPort: bridgePort,
        targetIpv4: network.ownerVirtualAddress,
        targetPort: input.gatewayPort,
      },
    }, input.signal);
    this.active = {
      role: "participant",
      roomId,
      gatewayEndpoint: `ws://127.0.0.1:${String(bridgePort)}/collab`,
      network,
      localVirtualAddress,
    };
    try {
      await this.waitForRoute(network.ownerVirtualAddress, input.signal);
      return structuredClone(this.active);
    } catch (error) {
      await this.runtime.stop().catch(() => undefined);
      this.active = undefined;
      throw error;
    }
  }

  async stop(): Promise<EasyTierRuntimeStatus> {
    const status = await this.runtime.stop();
    this.active = undefined;
    return status;
  }

  private matchActive(role: ActiveEasyTierTransport["role"], roomId: string, network: EasyTierInvitationNetwork): ActiveEasyTierTransport | undefined {
    if (!this.active) return undefined;
    const runtime = this.runtime.status();
    if (runtime.kind === "idle" || runtime.kind === "stopped" || runtime.kind === "process-error") {
      this.active = undefined;
      return undefined;
    }
    if (this.active.role === role && this.active.roomId === roomId
      && this.active.network.networkName === network.networkName
      && this.active.network.networkSecret === network.networkSecret) return structuredClone(this.active);
    throw new Error("Only one active EasyTier room is supported by this DSH instance");
  }

  private async waitForRoute(targetIpv4: string, signal?: AbortSignal): Promise<void> {
    const deadline = this.routeWait.now() + this.routeWait.timeoutMs;
    do {
      const status = await this.runtime.diagnose(targetIpv4, signal);
      if (status.kind === "direct" || status.kind === "relayed") return;
      if (status.kind === "process-error") throw new Error(`EasyTier process failed: ${status.message}`);
      if (this.routeWait.now() >= deadline) break;
      await this.routeWait.sleep(250);
    } while (!signal?.aborted);
    if (signal?.aborted) throw new Error("EasyTier connection was cancelled");
    throw new Error("EasyTier network is offline: Owner is not reachable through the shared node");
  }
}

function validPort(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error("gatewayPort is invalid");
}

function requiredRoomId(value: string): string {
  const roomId = value.trim();
  if (roomId === "") throw new Error("roomId must not be blank");
  return roomId;
}

function instanceName(role: ActiveEasyTierTransport["role"], roomId: string): string {
  const suffix = roomId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 40) || "room";
  return `collab-${role}-${suffix}`;
}
