import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { dirname, join } from "node:path";
import { EasyTierArtifactStore, type PreparedEasyTierArtifact } from "./easytier-artifacts.js";
import { resolveDefaultCollabEasyTierRunDir } from "./persistence.js";
import type { DshRepositorySubprocess } from "./repository-inspector.js";

export interface EasyTierRuntimeFileDescriptor {
  name: "easytier-core.exe" | "easytier-cli.exe";
  byteLength: number;
  sha256: string;
}

export interface EasyTierRuntimeManifest {
  version: string;
  platform: NodeJS.Platform;
  arch: string;
  archiveRoot: string;
  files: EasyTierRuntimeFileDescriptor[];
}

export const EASYTIER_RUNTIME_MANIFEST: EasyTierRuntimeManifest = {
  version: "2.6.4",
  platform: "win32",
  arch: "x64",
  archiveRoot: "easytier-windows-x86_64",
  files: [
    { name: "easytier-core.exe", byteLength: 23_119_360, sha256: "ce26f47b630f26fbbc77e965c9edbd01bf0b606e152b45b3247663ea1821f585" },
    { name: "easytier-cli.exe", byteLength: 9_968_128, sha256: "f7b90c4f13b788774a6d099713d71d86d297617247b87a19f46a61b48452f810" },
  ],
};

export interface EasyTierProcessOutcome {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutLossy: boolean;
  stderrLossy: boolean;
}

export interface EasyTierProcessSpec {
  argv: readonly string[];
  cwd: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  stdoutMaxBytes?: number;
  stderrMaxBytes?: number;
}

export interface EasyTierRunningProcess {
  done: Promise<EasyTierProcessOutcome>;
  stop(): Promise<EasyTierProcessOutcome>;
}

export interface EasyTierProcessPort {
  resolveExecutable(command: string, signal?: AbortSignal): Promise<string>;
  run(spec: EasyTierProcessSpec): Promise<EasyTierProcessOutcome>;
  spawn(spec: EasyTierProcessSpec): EasyTierRunningProcess;
}

export function createDshEasyTierProcessPort(subprocess: DshRepositorySubprocess): EasyTierProcessPort {
  const spawn = (spec: EasyTierProcessSpec): EasyTierRunningProcess => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    spec.signal?.addEventListener("abort", abort, { once: true });
    if (spec.signal?.aborted) controller.abort();
    const handle = subprocess.spawn({
      argv: spec.argv,
      cwd: spec.cwd,
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: spec.stdoutMaxBytes ?? 1024 * 1024 },
        stderr: { maxBytes: spec.stderrMaxBytes ?? 256 * 1024 },
      },
      graceMs: 2_000,
      signal: controller.signal,
      ...(spec.env ? { env: spec.env } : {}),
    });
    const done = handle.done.then((result): EasyTierProcessOutcome => {
      spec.signal?.removeEventListener("abort", abort);
      const stdout = handle.collected.stdout?.readFrom(0);
      const stderr = handle.collected.stderr?.readFrom(0);
      return {
        ...result,
        stdout: stdout?.text ?? "",
        stderr: stderr?.text ?? "",
        stdoutLossy: stdout?.lossy ?? false,
        stderrLossy: stderr?.lossy ?? false,
      };
    });
    return {
      done,
      async stop() {
        controller.abort();
        return done;
      },
    };
  };
  return {
    resolveExecutable: (command, signal) => subprocess.resolveExecutable(command, undefined, signal),
    spawn,
    run: (spec) => spawn(spec).done,
  };
}

interface EasyTierArtifactProvider {
  prepare(input?: { platform?: NodeJS.Platform; arch?: string; version?: string; signal?: AbortSignal }): Promise<PreparedEasyTierArtifact>;
}

export interface PreparedEasyTierRuntimeAssets {
  corePath: string;
  cliPath: string;
  workingDirectory: string;
  cached: boolean;
}

export interface EasyTierRuntimeAssetProvider {
  prepare(signal?: AbortSignal): Promise<PreparedEasyTierRuntimeAssets>;
}

function validateRuntimeManifest(manifest: EasyTierRuntimeManifest): EasyTierRuntimeManifest {
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version) || manifest.platform !== "win32" || manifest.arch !== "x64"
    || manifest.archiveRoot !== "easytier-windows-x86_64") throw new Error("EasyTier runtime manifest identity is invalid");
  const names = manifest.files.map((file) => file.name).sort();
  if (names.join(",") !== "easytier-cli.exe,easytier-core.exe") throw new Error("EasyTier runtime manifest files are invalid");
  for (const file of manifest.files) {
    if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 1 || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error("EasyTier runtime file descriptor is invalid");
    }
  }
  return structuredClone(manifest);
}

async function sha256File(path: string): Promise<string> {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer);
  return digest.digest("hex");
}

async function verifyRuntimeFile(root: string, descriptor: EasyTierRuntimeFileDescriptor): Promise<void> {
  const path = join(root, descriptor.name);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size !== descriptor.byteLength || await sha256File(path) !== descriptor.sha256) {
    throw new Error(`cached EasyTier runtime ${descriptor.name} is invalid`);
  }
}

export class EasyTierRuntimeAssetStore implements EasyTierRuntimeAssetProvider {
  private readonly artifacts: EasyTierArtifactProvider;
  private readonly processes: EasyTierProcessPort;
  private readonly manifest: EasyTierRuntimeManifest;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private preparing?: Promise<PreparedEasyTierRuntimeAssets>;

  constructor(options: {
    artifactStore?: EasyTierArtifactProvider;
    processes: EasyTierProcessPort;
    manifest?: EasyTierRuntimeManifest;
    platform?: NodeJS.Platform;
    arch?: string;
  }) {
    this.artifacts = options.artifactStore ?? new EasyTierArtifactStore();
    this.processes = options.processes;
    this.manifest = validateRuntimeManifest(options.manifest ?? EASYTIER_RUNTIME_MANIFEST);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  prepare(signal?: AbortSignal): Promise<PreparedEasyTierRuntimeAssets> {
    if (this.preparing) return this.preparing;
    const pending = this.prepareOnce(signal).finally(() => {
      if (this.preparing === pending) this.preparing = undefined;
    });
    this.preparing = pending;
    return pending;
  }

  private async prepareOnce(signal?: AbortSignal): Promise<PreparedEasyTierRuntimeAssets> {
    if (this.platform !== this.manifest.platform || this.arch !== this.manifest.arch) {
      throw new Error(`EasyTier runtime is unsupported on ${this.platform}/${this.arch}`);
    }
    const artifact = await this.artifacts.prepare({
      platform: this.manifest.platform,
      arch: this.manifest.arch,
      version: this.manifest.version,
      ...(signal ? { signal } : {}),
    });
    if (artifact.descriptor.platform !== this.manifest.platform || artifact.descriptor.arch !== this.manifest.arch) {
      throw new Error("EasyTier archive does not match the runtime manifest");
    }
    const runtimeDirectory = join(dirname(artifact.archivePath), "runtime");
    let runtimeExists = true;
    try {
      const metadata = await stat(runtimeDirectory);
      if (!metadata.isDirectory()) throw new Error("cached EasyTier runtime is invalid");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") runtimeExists = false;
      else throw error;
    }
    if (runtimeExists) {
      try {
        await Promise.all(this.manifest.files.map((file) => verifyRuntimeFile(runtimeDirectory, file)));
      } catch (error) {
        throw new Error("cached EasyTier runtime is invalid", { cause: error });
      }
      return this.result(runtimeDirectory, true);
    }

    const extractionRoot = join(dirname(artifact.archivePath), `.runtime.tmp-${randomUUID()}`);
    await mkdir(extractionRoot, { recursive: false, mode: 0o700 });
    try {
      const tar = await this.processes.resolveExecutable("tar", signal);
      const entries = this.manifest.files.map((file) => `${this.manifest.archiveRoot}/${file.name}`);
      const extracted = await this.processes.run({
        argv: [tar, "-xf", artifact.archivePath, "-C", extractionRoot, ...entries],
        cwd: dirname(artifact.archivePath),
        ...(signal ? { signal } : {}),
        stdoutMaxBytes: 64 * 1024,
        stderrMaxBytes: 64 * 1024,
      });
      if (extracted.exitCode !== 0 || extracted.stdoutLossy || extracted.stderrLossy) {
        throw new Error(`EasyTier archive extraction failed: ${redactEasyTierDiagnostic(extracted.stderr || extracted.stdout)}`);
      }
      const extractedRuntime = join(extractionRoot, this.manifest.archiveRoot);
      await Promise.all(this.manifest.files.map((file) => verifyRuntimeFile(extractedRuntime, file)));
      try {
        await rename(extractedRuntime, runtimeDirectory);
      } catch (error) {
        try {
          await Promise.all(this.manifest.files.map((file) => verifyRuntimeFile(runtimeDirectory, file)));
          return this.result(runtimeDirectory, true);
        } catch {
          throw error;
        }
      }
      return this.result(runtimeDirectory, false);
    } finally {
      await rm(extractionRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private result(runtimeDirectory: string, cached: boolean): PreparedEasyTierRuntimeAssets {
    return {
      corePath: join(runtimeDirectory, "easytier-core.exe"),
      cliPath: join(runtimeDirectory, "easytier-cli.exe"),
      workingDirectory: runtimeDirectory,
      cached,
    };
  }
}

export interface EasyTierPortForwardInput {
  listenPort: number;
  targetIpv4: string;
  targetPort: number;
}

export interface EasyTierRuntimeStartInput {
  instanceName: string;
  networkName: string;
  networkSecret: string;
  virtualIpv4: string;
  listenerPort: number;
  rpcPort: number;
  peers: readonly string[];
  portForward?: EasyTierPortForwardInput;
}

export interface EasyTierRuntimeConfig {
  text: string;
  env: { ET_NETWORK_SECRET: string };
  rpcPortal: string;
}

function validPort(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) throw new Error(`${name} is invalid`);
}

function validName(name: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value)) throw new Error(`${name} is invalid`);
}

function validPrivateIpv4(name: string, value: string): void {
  if (!isIPv4(value)) throw new Error(`${name} is invalid`);
  const [a, b] = value.split(".").map(Number);
  if (!(a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168))) throw new Error(`${name} must be private IPv4`);
}

function validPeer(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("EasyTier peer is invalid");
  }
  if (!new Set(["tcp:", "udp:", "wg:", "quic:", "ws:", "wss:"]).has(url.protocol)
    || !url.hostname || !url.port || url.username || url.password || (url.pathname && url.pathname !== "/") || url.search || url.hash) {
    throw new Error("EasyTier peer is invalid");
  }
}

export function buildEasyTierRuntimeConfig(input: EasyTierRuntimeStartInput): EasyTierRuntimeConfig {
  validName("instanceName", input.instanceName);
  validName("networkName", input.networkName);
  if (input.networkSecret.length < 8 || input.networkSecret.length > 256 || /["\\\0-\x1f\x7f]/.test(input.networkSecret)) {
    throw new Error("networkSecret is invalid");
  }
  validPrivateIpv4("virtualIpv4", input.virtualIpv4);
  validPort("listenerPort", input.listenerPort);
  validPort("rpcPort", input.rpcPort);
  if (input.peers.length > 16) throw new Error("EasyTier peers exceed the limit");
  for (const peer of input.peers) validPeer(peer);
  if (input.portForward) {
    validPort("portForward.listenPort", input.portForward.listenPort);
    validPrivateIpv4("portForward.targetIpv4", input.portForward.targetIpv4);
    validPort("portForward.targetPort", input.portForward.targetPort);
  }

  const lines = [
    `instance_name = ${JSON.stringify(input.instanceName)}`,
    `hostname = ${JSON.stringify(input.instanceName)}`,
    `ipv4 = ${JSON.stringify(input.virtualIpv4)}`,
    `listeners = [${JSON.stringify(`tcp://0.0.0.0:${input.listenerPort}`)}]`,
    "",
    "[network_identity]",
    `network_name = ${JSON.stringify(input.networkName)}`,
    'network_secret = "${ET_NETWORK_SECRET}"',
  ];
  for (const peer of input.peers) lines.push("", "[[peer]]", `uri = ${JSON.stringify(peer)}`);
  if (input.portForward) {
    lines.push(
      "",
      "[[port_forward]]",
      `bind_addr = ${JSON.stringify(`127.0.0.1:${input.portForward.listenPort}`)}`,
      `dst_addr = ${JSON.stringify(`${input.portForward.targetIpv4}:${input.portForward.targetPort}`)}`,
      'proto = "tcp"',
    );
  }
  lines.push("", "[flags]", "no_tun = true", "enable_ipv6 = false", "disable_upnp = true", "", "[console_logger]", 'level = "warn"', "");
  return {
    text: lines.join("\n"),
    env: { ET_NETWORK_SECRET: input.networkSecret },
    rpcPortal: `127.0.0.1:${input.rpcPort}`,
  };
}

export type EasyTierRuntimeStatus =
  | { kind: "idle" }
  | { kind: "starting"; startedAt: number }
  | { kind: "direct"; targetIpv4: string; checkedAt: number }
  | { kind: "relayed"; targetIpv4: string; checkedAt: number; hops: number }
  | { kind: "offline"; reason: "target-unreachable" | "diagnostic-unavailable"; checkedAt: number; message?: string }
  | { kind: "stopping"; stoppedAt: number }
  | { kind: "stopped"; stoppedAt: number }
  | { kind: "process-error"; code: "port-conflict" | "process-exit" | "start-failed" | "stop-failed"; message: string; exitCode: number | null; failedAt: number };

export function parseEasyTierPeerDiagnostics(text: string, targetIpv4: string, checkedAt: number): EasyTierRuntimeStatus {
  validPrivateIpv4("targetIpv4", targetIpv4);
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch (error) {
    throw new Error("EasyTier peer diagnostic JSON is invalid", { cause: error });
  }
  if (!Array.isArray(rows)) throw new Error("EasyTier peer diagnostic payload is invalid");
  const target = rows.find((row) => row && typeof row === "object" && (row as Record<string, unknown>).ipv4 === targetIpv4) as Record<string, unknown> | undefined;
  if (!target) return { kind: "offline", reason: "target-unreachable", checkedAt };
  if (target.cost === "p2p") return { kind: "direct", targetIpv4, checkedAt };
  if (typeof target.cost === "string") {
    const relayed = /^relay\((\d+)\)$/.exec(target.cost);
    if (relayed) return { kind: "relayed", targetIpv4, checkedAt, hops: Number(relayed[1]) };
  }
  throw new Error("EasyTier peer diagnostic route is invalid");
}

export function redactEasyTierDiagnostic(text: string, secrets: readonly string[] = []): string {
  let redacted = text;
  for (const secret of secrets) if (secret) redacted = redacted.split(secret).join("[REDACTED]");
  return redacted
    .replace(/(network[_-]?secret\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
    .replace(/(ET_NETWORK_SECRET\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[REDACTED]")
    .trim();
}

interface ActiveRuntime {
  id: string;
  input: EasyTierRuntimeStartInput;
  configPath: string;
  assets: PreparedEasyTierRuntimeAssets;
  process: EasyTierRunningProcess;
  expectedStop: boolean;
  completion: Promise<void>;
}

interface StartingRuntime {
  id: string;
  controller: AbortController;
}

export class EasyTierRuntimeManager {
  private readonly assets: EasyTierRuntimeAssetProvider;
  private readonly processes: EasyTierProcessPort;
  private readonly runRoot: string;
  private readonly clock: { now(): number };
  private currentStatus: EasyTierRuntimeStatus = { kind: "idle" };
  private active?: ActiveRuntime;
  private starting?: StartingRuntime;

  constructor(options: {
    processes: EasyTierProcessPort;
    assets?: EasyTierRuntimeAssetProvider;
    runRoot?: string;
    clock?: { now(): number };
  }) {
    this.processes = options.processes;
    this.assets = options.assets ?? new EasyTierRuntimeAssetStore({ processes: options.processes });
    this.runRoot = options.runRoot ?? resolveDefaultCollabEasyTierRunDir();
    this.clock = options.clock ?? { now: () => Date.now() };
  }

  status(): EasyTierRuntimeStatus {
    return structuredClone(this.currentStatus);
  }

  async start(input: EasyTierRuntimeStartInput, signal?: AbortSignal): Promise<EasyTierRuntimeStatus> {
    if (this.active || this.starting) throw new Error("EasyTier runtime is already active");
    const config = buildEasyTierRuntimeConfig(input);
    const starting = { id: randomUUID(), controller: new AbortController() };
    const startSignal = signal ? AbortSignal.any([signal, starting.controller.signal]) : starting.controller.signal;
    this.starting = starting;
    this.currentStatus = { kind: "starting", startedAt: this.clock.now() };
    let configPath: string | undefined;
    try {
      const assets = await this.assets.prepare(startSignal);
      if (startSignal.aborted) throw new Error("EasyTier start was cancelled");
      await mkdir(this.runRoot, { recursive: true, mode: 0o700 });
      if (startSignal.aborted) throw new Error("EasyTier start was cancelled");
      configPath = join(this.runRoot, `${randomUUID()}.toml`);
      await writeFile(configPath, config.text, { encoding: "utf8", flag: "wx", mode: 0o600 });
      if (startSignal.aborted) throw new Error("EasyTier start was cancelled");
      const process = this.processes.spawn({
        argv: [
          assets.corePath,
          "--config-file", configPath,
          "--rpc-portal", config.rpcPortal,
          "--console-log-level", "warn",
        ],
        cwd: assets.workingDirectory,
        env: { ...config.env, LANG: "C", LC_ALL: "C" },
        stdoutMaxBytes: 1024 * 1024,
        stderrMaxBytes: 1024 * 1024,
      });
      const active = {
        id: randomUUID(),
        input: { ...input, peers: [...input.peers], ...(input.portForward ? { portForward: { ...input.portForward } } : {}) },
        configPath,
        assets,
        process,
        expectedStop: false,
        completion: Promise.resolve(),
      } satisfies ActiveRuntime;
      this.active = active;
      active.completion = this.monitor(active);
      return this.status();
    } catch (error) {
      if (configPath) await rm(configPath, { force: true }).catch(() => undefined);
      if (startSignal.aborted) {
        if (this.status().kind !== "stopped") this.currentStatus = { kind: "stopped", stoppedAt: this.clock.now() };
        throw new Error("EasyTier start was cancelled");
      }
      const message = redactEasyTierDiagnostic(error instanceof Error ? error.message : String(error), [input.networkSecret]);
      this.currentStatus = { kind: "process-error", code: "start-failed", message, exitCode: null, failedAt: this.clock.now() };
      throw new Error(message);
    } finally {
      if (this.starting?.id === starting.id) this.starting = undefined;
    }
  }

  async diagnose(targetIpv4: string, signal?: AbortSignal): Promise<EasyTierRuntimeStatus> {
    const active = this.active;
    if (!active) return this.status();
    let result: EasyTierProcessOutcome;
    try {
      result = await this.processes.run({
        argv: [
          active.assets.cliPath,
          "--rpc-portal", `127.0.0.1:${active.input.rpcPort}`,
          "--output", "json",
          "--instance-name", active.input.instanceName,
          "peer",
        ],
        cwd: active.assets.workingDirectory,
        ...(signal ? { signal } : {}),
        stdoutMaxBytes: 1024 * 1024,
        stderrMaxBytes: 256 * 1024,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (this.active?.id !== active.id) return this.status();
      this.currentStatus = {
        kind: "offline",
        reason: "diagnostic-unavailable",
        checkedAt: this.clock.now(),
        message: redactEasyTierDiagnostic(error instanceof Error ? error.message : String(error), [active.input.networkSecret]),
      };
      return this.status();
    }
    if (this.active?.id !== active.id) return this.status();
    const checkedAt = this.clock.now();
    if (result.exitCode !== 0 || result.stdoutLossy || result.stderrLossy) {
      this.currentStatus = {
        kind: "offline",
        reason: "diagnostic-unavailable",
        checkedAt,
        message: result.stdoutLossy || result.stderrLossy
          ? "EasyTier diagnostic output exceeded its limit"
          : redactEasyTierDiagnostic(result.stderr || result.stdout, [active.input.networkSecret]),
      };
      return this.status();
    }
    try {
      this.currentStatus = parseEasyTierPeerDiagnostics(result.stdout, targetIpv4, checkedAt);
    } catch (error) {
      this.currentStatus = {
        kind: "offline",
        reason: "diagnostic-unavailable",
        checkedAt,
        message: redactEasyTierDiagnostic(error instanceof Error ? error.message : String(error), [active.input.networkSecret]),
      };
    }
    return this.status();
  }

  async stop(): Promise<EasyTierRuntimeStatus> {
    const active = this.active;
    if (!active) {
      const stoppedAt = this.clock.now();
      if (this.starting) {
        this.currentStatus = { kind: "stopping", stoppedAt };
        this.starting.controller.abort();
      }
      this.currentStatus = { kind: "stopped", stoppedAt };
      return this.status();
    }
    const stoppedAt = this.clock.now();
    active.expectedStop = true;
    this.currentStatus = { kind: "stopping", stoppedAt };
    try {
      await active.process.stop();
    } catch (error) {
      await rm(active.configPath, { force: true }).catch(() => undefined);
      const message = redactEasyTierDiagnostic(error instanceof Error ? error.message : String(error), [active.input.networkSecret]);
      this.currentStatus = { kind: "process-error", code: "stop-failed", message, exitCode: null, failedAt: this.clock.now() };
      throw new Error(message);
    }
    await active.completion;
    if (this.active?.id === active.id) {
      this.active = undefined;
      await rm(active.configPath, { force: true }).catch(() => undefined);
      this.currentStatus = { kind: "stopped", stoppedAt };
    }
    return this.status();
  }

  private async monitor(active: ActiveRuntime): Promise<void> {
    let result: EasyTierProcessOutcome;
    try {
      result = await active.process.done;
    } catch (error) {
      result = {
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        stdoutLossy: false,
        stderrLossy: false,
      };
    }
    await rm(active.configPath, { force: true }).catch(() => undefined);
    if (this.active?.id !== active.id) return;
    this.active = undefined;
    if (active.expectedStop) {
      this.currentStatus = { kind: "stopped", stoppedAt: this.clock.now() };
      return;
    }
    const raw = result.stdoutLossy || result.stderrLossy
      ? "EasyTier process output exceeded its diagnostic limit"
      : result.stderr || result.stdout || `EasyTier process exited with code ${result.exitCode ?? "unknown"}`;
    const message = redactEasyTierDiagnostic(raw, [active.input.networkSecret]);
    const portConflict = /address already in use|addrinuse|10048|only one usage/i.test(raw);
    this.currentStatus = {
      kind: "process-error",
      code: portConflict ? "port-conflict" : "process-exit",
      message,
      exitCode: result.exitCode,
      failedAt: this.clock.now(),
    };
  }
}
