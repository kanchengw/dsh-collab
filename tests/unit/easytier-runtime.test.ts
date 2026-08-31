import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EasyTierRuntimeAssetStore,
  EasyTierRuntimeManager,
  EASYTIER_RUNTIME_MANIFEST,
  buildEasyTierRuntimeConfig,
  createDshEasyTierProcessPort,
  parseEasyTierPeerDiagnostics,
  type EasyTierProcessOutcome,
  type EasyTierProcessPort,
  type EasyTierRuntimeAssetProvider,
  type EasyTierRuntimeManifest,
} from "../../src/easytier-runtime.js";
import type { DshRepositorySubprocess } from "../../src/repository-inspector.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function outcome(input: Partial<EasyTierProcessOutcome> = {}): EasyTierProcessOutcome {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stderr: "",
    stdoutLossy: false,
    stderrLossy: false,
    ...input,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("EasyTier runtime configuration", () => {
  it("builds the approved no-TUN config without putting the secret or test-only bind override on disk", () => {
    const config = buildEasyTierRuntimeConfig({
      instanceName: "collab-participant-room-1",
      networkName: "dsh-collab-room-1",
      networkSecret: "room-secret-that-must-not-leak",
      virtualIpv4: "10.231.0.2",
      listenerPort: 22110,
      rpcPort: 22111,
      peers: ["tcp://shared.example.com:11010"],
      portForward: { listenPort: 4312, targetIpv4: "10.231.0.1", targetPort: 4311 },
    });

    expect(config.text).toContain('network_name = "dsh-collab-room-1"');
    expect(config.text).toContain('network_secret = "${ET_NETWORK_SECRET}"');
    expect(config.text).toContain('listeners = ["tcp://0.0.0.0:22110"]');
    expect(config.text).toContain("no_tun = true");
    expect(config.text).toContain("enable_ipv6 = false");
    expect(config.text).toContain("disable_upnp = true");
    expect(config.text).toContain('bind_addr = "127.0.0.1:4312"');
    expect(config.text).toContain('dst_addr = "10.231.0.1:4311"');
    expect(config.text).not.toContain("room-secret-that-must-not-leak");
    expect(config.text).not.toContain("bind_device");
    expect(config.env).toEqual({ ET_NETWORK_SECRET: "room-secret-that-must-not-leak" });
    expect(config.rpcPortal).toBe("127.0.0.1:22111");
  });

  it("rejects values that could escape the config or address boundaries", () => {
    const base = {
      instanceName: "collab-owner-room-1",
      networkName: "dsh-collab-room-1",
      networkSecret: "valid-secret",
      virtualIpv4: "10.231.0.1",
      listenerPort: 22110,
      rpcPort: 22111,
      peers: ["tcp://shared.example.com:11010"],
    } as const;

    expect(() => buildEasyTierRuntimeConfig({ ...base, instanceName: 'room"\n[flags]' })).toThrow("instanceName");
    expect(() => buildEasyTierRuntimeConfig({ ...base, virtualIpv4: "127.0.0.1" })).toThrow("virtualIpv4");
    expect(() => buildEasyTierRuntimeConfig({ ...base, listenerPort: 0 })).toThrow("listenerPort");
    expect(() => buildEasyTierRuntimeConfig({ ...base, peers: ["tcp://user:password@shared.example.com:11010"] })).toThrow("peer");
    expect(() => buildEasyTierRuntimeConfig({ ...base, networkSecret: 'valid"secret' })).toThrow("networkSecret");
    expect(() => buildEasyTierRuntimeConfig({ ...base, networkSecret: "valid\\secret" })).toThrow("networkSecret");
  });
});

describe("EasyTier peer diagnostics", () => {
  it("maps the official CLI peer cost values to direct, relayed and offline states", () => {
    const direct = JSON.stringify([
      { ipv4: "10.231.0.2", cost: "Local" },
      { ipv4: "10.231.0.1", cost: "p2p" },
    ]);
    const relayed = JSON.stringify([
      { ipv4: "10.231.0.2", cost: "Local" },
      { ipv4: "10.231.0.1", cost: "relay(2)" },
    ]);

    expect(parseEasyTierPeerDiagnostics(direct, "10.231.0.1", 100)).toEqual({ kind: "direct", targetIpv4: "10.231.0.1", checkedAt: 100 });
    expect(parseEasyTierPeerDiagnostics(relayed, "10.231.0.1", 101)).toEqual({ kind: "relayed", targetIpv4: "10.231.0.1", checkedAt: 101, hops: 2 });
    expect(parseEasyTierPeerDiagnostics("[]", "10.231.0.1", 102)).toEqual({ kind: "offline", reason: "target-unreachable", checkedAt: 102 });
    expect(() => parseEasyTierPeerDiagnostics('{"cost":"p2p"}', "10.231.0.1", 103)).toThrow("diagnostic");
  });
});

describe("EasyTier runtime assets", () => {
  it("ships the forked headless runtime without the Npcap loader", () => {
    expect(EASYTIER_RUNTIME_MANIFEST.files.map((file) => file.name).sort()).toEqual([
      "easytier-cli.exe",
      "easytier-core.exe",
    ]);
  });

  it("rejects an unsupported runtime platform before preparing the Windows archive", async () => {
    const artifactStore = { prepare: vi.fn(async () => { throw new Error("must not prepare"); }) };
    const processes: EasyTierProcessPort = {
      resolveExecutable: vi.fn(async (command) => command),
      run: vi.fn(async () => outcome()),
      spawn: vi.fn(() => { throw new Error("not used"); }),
    };
    const store = new EasyTierRuntimeAssetStore({ artifactStore, processes, platform: "linux", arch: "x64" });

    await expect(store.prepare()).rejects.toThrow("unsupported");
    expect(artifactStore.prepare).not.toHaveBeenCalled();
  });

  it("extracts only the pinned headless binaries atomically and rejects later cache corruption", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-runtime-assets-"));
    roots.push(root);
    const archivePath = join(root, "easytier.zip");
    await writeFile(archivePath, "trusted archive", "utf8");
    const core = Buffer.from("core binary");
    const cli = Buffer.from("cli binary");
    const manifest: EasyTierRuntimeManifest = {
      version: "2.6.4",
      platform: "win32",
      arch: "x64",
      archiveRoot: "easytier-windows-x86_64",
      files: [
        { name: "easytier-core.exe", byteLength: core.byteLength, sha256: sha256(core) },
        { name: "easytier-cli.exe", byteLength: cli.byteLength, sha256: sha256(cli) },
      ],
    };
    const artifactStore = {
      prepare: vi.fn(async () => ({
        archivePath,
        cached: true,
        descriptor: { platform: "win32" as const, arch: "x64", archiveName: "easytier.zip", archiveUrl: "https://example.invalid/easytier.zip", byteLength: 1, sha256: "0".repeat(64) },
      })),
    };
    const runs: string[][] = [];
    const processes: EasyTierProcessPort = {
      resolveExecutable: vi.fn(async () => "tar.exe"),
      async run(spec) {
        runs.push([...spec.argv]);
        const target = spec.argv[spec.argv.indexOf("-C") + 1]!;
        const extracted = join(target, manifest.archiveRoot);
        await mkdir(extracted, { recursive: true });
        await Promise.all([
          writeFile(join(extracted, "easytier-core.exe"), core),
          writeFile(join(extracted, "easytier-cli.exe"), cli),
        ]);
        return outcome();
      },
      spawn: vi.fn(() => { throw new Error("not used"); }),
    };
    const store = new EasyTierRuntimeAssetStore({ artifactStore, processes, manifest });

    const first = await store.prepare();
    const second = await store.prepare();

    expect(first.cached).toBe(false);
    expect(second).toEqual({ ...first, cached: true });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toContain(`${manifest.archiveRoot}/easytier-core.exe`);
    expect(runs[0]).toContain(`${manifest.archiveRoot}/easytier-cli.exe`);
    expect(runs[0]!.join(" ")).not.toContain("easytier-web");

    await rm(first.cliPath);
    await expect(store.prepare()).rejects.toThrow("cached EasyTier runtime");
    expect(runs).toHaveLength(1);

    await writeFile(first.cliPath, cli);
    await writeFile(first.corePath, "tampered", "utf8");
    await expect(store.prepare()).rejects.toThrow("cached EasyTier runtime");
    expect(runs).toHaveLength(1);
  });
});

describe("DSH EasyTier process adapter", () => {
  it("uses bounded output and aborts the DSH subprocess when stopped", async () => {
    const spawn = vi.fn((spec: Parameters<DshRepositorySubprocess["spawn"]>[0]) => ({
      collected: {
        stdout: { readFrom: () => ({ text: "bounded stdout", lossy: true }) },
        stderr: { readFrom: () => ({ text: "bounded stderr", lossy: false }) },
      },
      done: new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        spec.signal?.addEventListener("abort", () => resolve({ exitCode: null, signal: "SIGTERM" }), { once: true });
      }),
    }));
    const resolveExecutable = vi.fn(async () => "C:\\Windows\\System32\\tar.exe");
    const port = createDshEasyTierProcessPort({ resolveExecutable, spawn });

    await expect(port.resolveExecutable("tar")).resolves.toBe("C:\\Windows\\System32\\tar.exe");
    const process = port.spawn({
      argv: ["core.exe", "--version"],
      cwd: "C:\\runtime",
      stdoutMaxBytes: 12,
      stderrMaxBytes: 8,
    });

    await expect(process.stop()).resolves.toEqual({
      exitCode: null,
      signal: "SIGTERM",
      stdout: "bounded stdout",
      stderr: "bounded stderr",
      stdoutLossy: true,
      stderrLossy: false,
    });
    expect(resolveExecutable).toHaveBeenCalledWith("tar", undefined, undefined);
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      stdio: { stdin: "ignore", stdout: { maxBytes: 12 }, stderr: { maxBytes: 8 } },
      graceMs: 2_000,
    }));
  });
});

describe("EasyTier runtime manager", () => {
  it("does nothing until explicit start, then starts and stops one secret-safe runtime", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-runs-"));
    roots.push(root);
    const processDone = deferred<EasyTierProcessOutcome>();
    const stopped = vi.fn(async () => {
      const stoppedOutcome = outcome({ exitCode: null, signal: "SIGTERM" });
      processDone.resolve(stoppedOutcome);
      return stoppedOutcome;
    });
    const assets: EasyTierRuntimeAssetProvider = {
      prepare: vi.fn(async () => ({ corePath: "C:\\runtime\\easytier-core.exe", cliPath: "C:\\runtime\\easytier-cli.exe", workingDirectory: "C:\\runtime", cached: true })),
    };
    const processes: EasyTierProcessPort = {
      resolveExecutable: vi.fn(async (command) => command),
      run: vi.fn(async () => outcome()),
      spawn: vi.fn(() => ({ done: processDone.promise, stop: stopped })),
    };
    const manager = new EasyTierRuntimeManager({ assets, processes, runRoot: root, clock: { now: () => 1_000 } });

    expect(manager.status()).toEqual({ kind: "idle" });
    expect(assets.prepare).not.toHaveBeenCalled();
    expect(processes.spawn).not.toHaveBeenCalled();

    await manager.start({
      instanceName: "collab-owner-room-1",
      networkName: "dsh-collab-room-1",
      networkSecret: "runtime-secret",
      virtualIpv4: "10.231.0.1",
      listenerPort: 22110,
      rpcPort: 22111,
      peers: ["tcp://shared.example.com:11010"],
    });

    expect(manager.status()).toEqual({ kind: "starting", startedAt: 1_000 });
    const spec = vi.mocked(processes.spawn).mock.calls[0]![0];
    expect(spec.argv[0]).toBe("C:\\runtime\\easytier-core.exe");
    expect(spec.argv).toContain("--config-file");
    expect(spec.argv).toContain("--rpc-portal");
    expect(spec.argv.join(" ")).not.toContain("runtime-secret");
    expect(spec.env).toMatchObject({ ET_NETWORK_SECRET: "runtime-secret" });
    const configPath = spec.argv[spec.argv.indexOf("--config-file") + 1]!;
    expect(await readFile(configPath, "utf8")).not.toContain("runtime-secret");

    await manager.stop();

    expect(stopped).toHaveBeenCalledOnce();
    expect(manager.status()).toEqual({ kind: "stopped", stoppedAt: 1_000 });
    await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the caller signal only to cancel startup, not the active runtime lifetime", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-runs-"));
    roots.push(root);
    const processDone = deferred<EasyTierProcessOutcome>();
    const assets: EasyTierRuntimeAssetProvider = {
      prepare: vi.fn(async () => ({ corePath: "core.exe", cliPath: "cli.exe", workingDirectory: root, cached: true })),
    };
    const processes: EasyTierProcessPort = {
      resolveExecutable: vi.fn(async (command) => command),
      run: vi.fn(async () => outcome()),
      spawn: vi.fn((spec) => {
        spec.signal?.addEventListener("abort", () => processDone.resolve(outcome({ exitCode: null, signal: "SIGTERM" })), { once: true });
        return {
          done: processDone.promise,
          stop: vi.fn(async () => {
            const stopped = outcome({ exitCode: null, signal: "SIGTERM" });
            processDone.resolve(stopped);
            return stopped;
          }),
        };
      }),
    };
    const manager = new EasyTierRuntimeManager({ assets, processes, runRoot: root, clock: { now: () => 1_500 } });
    const caller = new AbortController();

    await manager.start({ instanceName: "collab-owner-room-1", networkName: "network", networkSecret: "valid-secret", virtualIpv4: "10.231.0.1", listenerPort: 22110, rpcPort: 22111, peers: [] }, caller.signal);
    expect(vi.mocked(processes.spawn).mock.calls[0]![0].signal).toBeUndefined();
    caller.abort();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(manager.status()).toEqual({ kind: "starting", startedAt: 1_500 });
    await manager.stop();
    expect(manager.status()).toEqual({ kind: "stopped", stoppedAt: 1_500 });
  });

  it("diagnoses direct and relayed routes through the official CLI JSON contract", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-runs-"));
    roots.push(root);
    const processDone = deferred<EasyTierProcessOutcome>();
    const assets: EasyTierRuntimeAssetProvider = {
      prepare: vi.fn(async () => ({ corePath: "core.exe", cliPath: "cli.exe", workingDirectory: root, cached: true })),
    };
    const run = vi.fn()
      .mockResolvedValueOnce(outcome({ stdout: JSON.stringify([{ ipv4: "10.231.0.1", cost: "p2p" }]) }))
      .mockResolvedValueOnce(outcome({ stdout: JSON.stringify([{ ipv4: "10.231.0.1", cost: "relay(3)" }]) }))
      .mockResolvedValueOnce(outcome({ exitCode: 1, stderr: "rpc unavailable" }))
      .mockRejectedValueOnce(new Error("rpc adapter unavailable"));
    const processes: EasyTierProcessPort = {
      resolveExecutable: vi.fn(async (command) => command),
      run,
      spawn: vi.fn(() => ({ done: processDone.promise, stop: vi.fn(async () => outcome({ exitCode: null, signal: "SIGTERM" })) })),
    };
    let now = 2_000;
    const manager = new EasyTierRuntimeManager({ assets, processes, runRoot: root, clock: { now: () => now++ } });
    await manager.start({ instanceName: "collab-participant-room-1", networkName: "network", networkSecret: "valid-secret", virtualIpv4: "10.231.0.2", listenerPort: 22110, rpcPort: 22111, peers: [] });

    await expect(manager.diagnose("10.231.0.1")).resolves.toMatchObject({ kind: "direct" });
    await expect(manager.diagnose("10.231.0.1")).resolves.toMatchObject({ kind: "relayed", hops: 3 });
    await expect(manager.diagnose("10.231.0.1")).resolves.toMatchObject({ kind: "offline", reason: "diagnostic-unavailable" });
    await expect(manager.diagnose("10.231.0.1")).resolves.toMatchObject({ kind: "offline", reason: "diagnostic-unavailable", message: "rpc adapter unavailable" });
    expect(run.mock.calls[0]![0].argv).toEqual(["cli.exe", "--rpc-portal", "127.0.0.1:22111", "--output", "json", "--instance-name", "collab-participant-room-1", "peer"]);
  });

  it("classifies a crashed bind as a process error and redacts the network secret", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-runs-"));
    roots.push(root);
    const processDone = deferred<EasyTierProcessOutcome>();
    const secret = "never-show-this-secret";
    const assets: EasyTierRuntimeAssetProvider = {
      prepare: vi.fn(async () => ({ corePath: "core.exe", cliPath: "cli.exe", workingDirectory: root, cached: true })),
    };
    const processes: EasyTierProcessPort = {
      resolveExecutable: vi.fn(async (command) => command),
      run: vi.fn(async () => outcome()),
      spawn: vi.fn(() => ({ done: processDone.promise, stop: vi.fn(async () => outcome({ exitCode: null, signal: "SIGTERM" })) })),
    };
    const manager = new EasyTierRuntimeManager({ assets, processes, runRoot: root, clock: { now: () => 3_000 } });
    await manager.start({ instanceName: "collab-owner-room-1", networkName: "network", networkSecret: secret, virtualIpv4: "10.231.0.1", listenerPort: 22110, rpcPort: 22111, peers: [] });

    processDone.resolve(outcome({ exitCode: 1, stderr: `network_secret=${secret} address already in use (10048)` }));
    await processDone.promise;
    await vi.waitFor(() => expect(manager.status().kind).toBe("process-error"));

    expect(manager.status()).toEqual({
      kind: "process-error",
      code: "port-conflict",
      message: "network_secret=[REDACTED] address already in use (10048)",
      exitCode: 1,
      failedAt: 3_000,
    });
    expect(JSON.stringify(manager.status())).not.toContain(secret);
  });

  it("records an immediately exited process and removes its temporary config", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-runs-"));
    roots.push(root);
    const assets: EasyTierRuntimeAssetProvider = {
      prepare: vi.fn(async () => ({ corePath: "core.exe", cliPath: "cli.exe", workingDirectory: root, cached: true })),
    };
    const processes: EasyTierProcessPort = {
      resolveExecutable: vi.fn(async (command) => command),
      run: vi.fn(async () => outcome()),
      spawn: vi.fn(() => ({
        done: Promise.resolve(outcome({ exitCode: 1, stderr: "startup failed" })),
        stop: vi.fn(async () => outcome({ exitCode: null, signal: "SIGTERM" })),
      })),
    };
    const manager = new EasyTierRuntimeManager({ assets, processes, runRoot: root, clock: { now: () => 4_000 } });

    await manager.start({ instanceName: "collab-owner-room-1", networkName: "network", networkSecret: "valid-secret", virtualIpv4: "10.231.0.1", listenerPort: 22110, rpcPort: 22111, peers: [] });
    await vi.waitFor(() => expect(manager.status().kind).toBe("process-error"));

    expect(manager.status()).toMatchObject({ kind: "process-error", code: "process-exit", message: "startup failed" });
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("redacts start failures returned to the caller", async () => {
    const secret = "never-return-this-secret";
    const assets: EasyTierRuntimeAssetProvider = {
      prepare: vi.fn(async () => { throw new Error(`download failed for network_secret=${secret}`); }),
    };
    const processes: EasyTierProcessPort = {
      resolveExecutable: vi.fn(async (command) => command),
      run: vi.fn(async () => outcome()),
      spawn: vi.fn(() => { throw new Error("not used"); }),
    };
    const manager = new EasyTierRuntimeManager({ assets, processes, clock: { now: () => 5_000 } });

    await expect(manager.start({ instanceName: "collab-owner-room-1", networkName: "network", networkSecret: secret, virtualIpv4: "10.231.0.1", listenerPort: 22110, rpcPort: 22111, peers: [] }))
      .rejects.toThrow("network_secret=[REDACTED]");
    expect(JSON.stringify(manager.status())).not.toContain(secret);
  });

  it("removes the temporary config and reports a stop failure without claiming the process stopped", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-runs-"));
    roots.push(root);
    const processDone = deferred<EasyTierProcessOutcome>();
    const secret = "stop-failure-secret";
    const assets: EasyTierRuntimeAssetProvider = {
      prepare: vi.fn(async () => ({ corePath: "core.exe", cliPath: "cli.exe", workingDirectory: root, cached: true })),
    };
    const processes: EasyTierProcessPort = {
      resolveExecutable: vi.fn(async (command) => command),
      run: vi.fn(async () => outcome()),
      spawn: vi.fn(() => ({
        done: processDone.promise,
        stop: vi.fn(async () => { throw new Error(`unable to stop ${secret}`); }),
      })),
    };
    const manager = new EasyTierRuntimeManager({ assets, processes, runRoot: root, clock: { now: () => 6_000 } });
    await manager.start({ instanceName: "collab-owner-room-1", networkName: "network", networkSecret: secret, virtualIpv4: "10.231.0.1", listenerPort: 22110, rpcPort: 22111, peers: [] });
    const spec = vi.mocked(processes.spawn).mock.calls[0]![0];
    const configPath = spec.argv[spec.argv.indexOf("--config-file") + 1]!;

    await expect(manager.stop()).rejects.toThrow("unable to stop [REDACTED]");

    await expect(stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(manager.status()).toMatchObject({ kind: "process-error", code: "stop-failed" });
    expect(JSON.stringify(manager.status())).not.toContain(secret);
  });

  it("rejects a concurrent start while the first runtime is still preparing", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-runs-"));
    roots.push(root);
    const prepared = deferred<{ corePath: string; cliPath: string; workingDirectory: string; cached: boolean }>();
    const processDone = deferred<EasyTierProcessOutcome>();
    const assets: EasyTierRuntimeAssetProvider = { prepare: vi.fn(() => prepared.promise) };
    const processes: EasyTierProcessPort = {
      resolveExecutable: vi.fn(async (command) => command),
      run: vi.fn(async () => outcome()),
      spawn: vi.fn(() => ({
        done: processDone.promise,
        stop: vi.fn(async () => {
          const result = outcome({ exitCode: null, signal: "SIGTERM" });
          processDone.resolve(result);
          return result;
        }),
      })),
    };
    const manager = new EasyTierRuntimeManager({ assets, processes, runRoot: root });
    const input = { instanceName: "collab-owner-room-1", networkName: "network", networkSecret: "valid-secret", virtualIpv4: "10.231.0.1", listenerPort: 22110, rpcPort: 22111, peers: [] } as const;

    const first = manager.start(input);
    await expect(manager.start(input)).rejects.toThrow("already active");
    prepared.resolve({ corePath: "core.exe", cliPath: "cli.exe", workingDirectory: root, cached: true });
    await first;
    expect(processes.spawn).toHaveBeenCalledOnce();
    await manager.stop();
  });

  it("does not spawn a process when stop cancels an in-progress start", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-runs-"));
    roots.push(root);
    const prepared = deferred<{ corePath: string; cliPath: string; workingDirectory: string; cached: boolean }>();
    const assets: EasyTierRuntimeAssetProvider = { prepare: vi.fn(() => prepared.promise) };
    const processes: EasyTierProcessPort = {
      resolveExecutable: vi.fn(async (command) => command),
      run: vi.fn(async () => outcome()),
      spawn: vi.fn(() => { throw new Error("must not spawn"); }),
    };
    const manager = new EasyTierRuntimeManager({ assets, processes, runRoot: root, clock: { now: () => 7_000 } });

    const started = manager.start({ instanceName: "collab-owner-room-1", networkName: "network", networkSecret: "valid-secret", virtualIpv4: "10.231.0.1", listenerPort: 22110, rpcPort: 22111, peers: [] });
    await expect(manager.stop()).resolves.toEqual({ kind: "stopped", stoppedAt: 7_000 });
    prepared.resolve({ corePath: "core.exe", cliPath: "cli.exe", workingDirectory: root, cached: true });

    await expect(started).rejects.toThrow("cancelled");
    expect(processes.spawn).not.toHaveBeenCalled();
    expect(manager.status()).toEqual({ kind: "stopped", stoppedAt: 7_000 });
  });
});
