import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_EASYTIER_SHARED_NODE,
  EasyTierTransportCoordinator,
  type EasyTierManagedRuntime,
} from "../../src/easytier-transport.js";
import type { EasyTierRuntimeStartInput, EasyTierRuntimeStatus } from "../../src/easytier-runtime.js";

function runtimeHarness(): { runtime: EasyTierManagedRuntime; starts: EasyTierRuntimeStartInput[] } {
  const starts: EasyTierRuntimeStartInput[] = [];
  let status: EasyTierRuntimeStatus = { kind: "idle" };
  return {
    starts,
    runtime: {
      status: () => structuredClone(status),
      start: vi.fn(async (input) => {
        starts.push(structuredClone(input));
        status = { kind: "starting", startedAt: 1 };
        return structuredClone(status);
      }),
      diagnose: vi.fn(async (targetIpv4) => ({ kind: "direct" as const, targetIpv4, checkedAt: 1 })),
      stop: vi.fn(async () => {
        status = { kind: "stopped", stoppedAt: 2 };
        return structuredClone(status);
      }),
    },
  };
}

function ports(...values: number[]): { allocate(): Promise<number> } {
  const queue = [...values];
  return { allocate: async () => queue.shift() ?? Promise.reject(new Error("port fixture exhausted")) };
}

describe("EasyTier Collab lifecycle", () => {
  it("starts one Owner overlay for the original Gateway and reuses it for the same room", async () => {
    const { runtime, starts } = runtimeHarness();
    const transport = new EasyTierTransportCoordinator({
      runtime,
      ports: ports(41001, 41002),
      credentials: {
        networkName: () => "dsh-collab-room-1",
        networkSecret: () => "network-secret-room-1",
        participantVirtualAddress: () => "10.231.2.3",
      },
    });

    const first = await transport.startOwner({ roomId: "room-1", gatewayPort: 4310 });
    const second = await transport.startOwner({ roomId: "room-1", gatewayPort: 4310, network: first.network });

    expect(first).toMatchObject({
      role: "owner",
      roomId: "room-1",
      gatewayEndpoint: "ws://10.231.0.1:4310/collab",
      network: {
        mode: "easytier",
        version: 1,
        networkName: "dsh-collab-room-1",
        networkSecret: "network-secret-room-1",
        ownerVirtualAddress: "10.231.0.1",
        sharedNode: DEFAULT_EASYTIER_SHARED_NODE,
      },
    });
    expect(second).toEqual(first);
    expect(starts).toEqual([expect.objectContaining({
      networkName: "dsh-collab-room-1",
      networkSecret: "network-secret-room-1",
      virtualIpv4: "10.231.0.1",
      listenerPort: 41001,
      rpcPort: 41002,
      peers: [DEFAULT_EASYTIER_SHARED_NODE],
    })]);
    expect(starts[0]).not.toHaveProperty("portForward");
  });

  it("starts a Participant loopback bridge and rejects a second active room", async () => {
    const { runtime, starts } = runtimeHarness();
    const transport = new EasyTierTransportCoordinator({
      runtime,
      ports: ports(42001, 42002, 42003),
      credentials: {
        networkName: () => "unused",
        networkSecret: () => "unused-secret",
        participantVirtualAddress: () => "10.231.2.3",
      },
    });
    const network = {
      mode: "easytier" as const,
      version: 1 as const,
      networkName: "dsh-collab-room-1",
      networkSecret: "network-secret-room-1",
      ownerVirtualAddress: "10.231.0.1",
      sharedNode: DEFAULT_EASYTIER_SHARED_NODE,
    };

    const connected = await transport.startParticipant({ roomId: "room-1", gatewayPort: 4310, network });

    expect(connected).toMatchObject({
      role: "participant",
      roomId: "room-1",
      gatewayEndpoint: "ws://127.0.0.1:42003/collab",
      localVirtualAddress: "10.231.2.3",
    });
    expect(starts).toEqual([expect.objectContaining({
      virtualIpv4: "10.231.2.3",
      listenerPort: 42001,
      rpcPort: 42002,
      peers: [DEFAULT_EASYTIER_SHARED_NODE],
      portForward: { listenPort: 42003, targetIpv4: "10.231.0.1", targetPort: 4310 },
    })]);
    await expect(transport.startParticipant({ roomId: "room-2", gatewayPort: 4310, network: { ...network, networkName: "room-2" } }))
      .rejects.toThrow("one active EasyTier room");
  });

  it("stops the managed process and returns to an inactive transport state", async () => {
    const { runtime } = runtimeHarness();
    const transport = new EasyTierTransportCoordinator({ runtime, ports: ports(43001, 43002) });
    await transport.startOwner({ roomId: "room-1", gatewayPort: 4310 });

    await expect(transport.stop()).resolves.toEqual({ kind: "stopped", stoppedAt: 2 });
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(transport.snapshot()).toEqual({ active: false, runtime: { kind: "stopped", stoppedAt: 2 } });
  });

  it("reports an offline overlay before any Gateway request and cleans up the process", async () => {
    const { runtime } = runtimeHarness();
    runtime.diagnose = vi.fn(async () => ({ kind: "offline" as const, reason: "target-unreachable" as const, checkedAt: 1 }));
    const transport = new EasyTierTransportCoordinator({
      runtime,
      ports: ports(45001, 45002, 45003),
      routeWait: { timeoutMs: 0, now: () => 1, sleep: async () => {} },
    });
    const network = {
      mode: "easytier" as const, version: 1 as const, networkName: "room-1", networkSecret: "network-secret",
      ownerVirtualAddress: "10.231.0.1", sharedNode: DEFAULT_EASYTIER_SHARED_NODE,
    };

    await expect(transport.startParticipant({ roomId: "room-1", gatewayPort: 4310, network })).rejects.toThrow("network is offline");
    expect(runtime.stop).toHaveBeenCalledOnce();
    expect(transport.snapshot().active).toBe(false);
  });

  it("allows an explicit reconnect after the previous EasyTier process exits", async () => {
    const starts: EasyTierRuntimeStartInput[] = [];
    let status: EasyTierRuntimeStatus = { kind: "idle" };
    const runtime: EasyTierManagedRuntime = {
      status: () => status,
      start: vi.fn(async (input) => { starts.push(input); status = { kind: "starting", startedAt: starts.length }; return status; }),
      diagnose: vi.fn(async (targetIpv4) => ({ kind: "direct" as const, targetIpv4, checkedAt: starts.length })),
      stop: vi.fn(async () => status = { kind: "stopped", stoppedAt: 3 }),
    };
    const transport = new EasyTierTransportCoordinator({ runtime, ports: ports(46001, 46002, 46003, 46004, 46005, 46006) });
    const network = {
      mode: "easytier" as const, version: 1 as const, networkName: "room-1", networkSecret: "network-secret",
      ownerVirtualAddress: "10.231.0.1", sharedNode: DEFAULT_EASYTIER_SHARED_NODE,
    };
    const first = await transport.startParticipant({ roomId: "room-1", gatewayPort: 4310, network, localVirtualAddress: "10.231.2.3" });
    status = { kind: "process-error", code: "process-exit", message: "process exited", exitCode: 1, failedAt: 2 };

    const restarted = await transport.startParticipant({ roomId: "room-1", gatewayPort: 4310, network, localVirtualAddress: "10.231.2.3" });

    expect(starts).toHaveLength(2);
    expect(restarted.gatewayEndpoint).not.toBe(first.gatewayEndpoint);
  });
});
