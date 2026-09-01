import { describe, expect, it, vi } from "vitest";
import { DshCollabCredentialStore } from "../../src/dsh-credentials.js";

describe("DSH credential-backed Collab secrets", () => {
  it("stores Participant resume and EasyTier secrets in an opaque grant record", async () => {
    const records = new Map<string, { kind: string; payload?: unknown }>();
    const credentials = {
      readRecord: vi.fn(async (key: string) => records.get(key)),
      modifyRecord: vi.fn(async (key: string, mutate: (current: { kind: string; payload?: unknown } | undefined) => Promise<{ kind: string; payload?: unknown } | undefined>) => {
        const next = await mutate(records.get(key));
        if (next !== undefined) records.set(key, next);
        return records.get(key);
      }),
      deleteRecord: vi.fn(async (key: string) => { records.delete(key); }),
    };
    const store = new DshCollabCredentialStore(credentials, () => "fixed-id");
    const state = {
      gatewayEndpoint: "wss://collab.example/collab",
      roomId: "room-2",
      memberId: "member-bob",
      credential: "resume-secret",
      roomTitle: "Release",
      easyTier: {
        network: {
          mode: "easytier" as const,
          version: 1 as const,
          networkName: "release",
          networkSecret: "network-secret",
          ownerVirtualAddress: "10.231.0.1",
          sharedNode: "tcp://public.kkrainbow.top:11010",
        },
        localVirtualAddress: "10.231.2.3",
      },
    };

    const key = await store.saveParticipant(state);

    expect(key).toBe("dsh-collab/participant-fixed-id");
    expect(records.get(key)).toEqual({ kind: "grant", payload: { version: 1, kind: "participant", state } });
    await expect(store.loadParticipant(key)).resolves.toEqual(state);
    await expect(store.loadParticipant("other-plugin/participant-fixed-id")).rejects.toThrow(/credential key/i);
  });

  it("stores Owner EasyTier networks separately and deletes only Collab-owned records", async () => {
    const records = new Map<string, { kind: string; payload?: unknown }>();
    const credentials = {
      readRecord: vi.fn(async (key: string) => records.get(key)),
      modifyRecord: vi.fn(async (key: string, mutate: (current: { kind: string; payload?: unknown } | undefined) => Promise<{ kind: string; payload?: unknown } | undefined>) => {
        const next = await mutate(records.get(key));
        if (next !== undefined) records.set(key, next);
        return records.get(key);
      }),
      deleteRecord: vi.fn(async (key: string) => { records.delete(key); }),
    };
    const store = new DshCollabCredentialStore(credentials, () => "owner-id");
    const network = {
      mode: "easytier" as const,
      version: 1 as const,
      networkName: "release",
      networkSecret: "network-secret",
      ownerVirtualAddress: "10.231.0.1",
      sharedNode: "tcp://public.kkrainbow.top:11010",
    };

    const key = await store.saveOwnerNetwork(network);

    expect(key).toBe("dsh-collab/owner-owner-id");
    await expect(store.loadOwnerNetwork(key)).resolves.toEqual(network);
    await store.deleteOwnerNetwork(key);
    expect(records.has(key)).toBe(false);
    await expect(store.deleteOwnerNetwork("other-plugin/owner-owner-id")).rejects.toThrow(/credential key/i);
  });
});
