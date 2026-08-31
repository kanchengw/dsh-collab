import { createHash, randomUUID } from "node:crypto";
import { open, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDefaultCollabEasyTierDir } from "./persistence.js";

export interface EasyTierArtifactDescriptor {
  platform: NodeJS.Platform;
  arch: string;
  archiveName: string;
  archiveUrl: string;
  byteLength: number;
  sha256: string;
}

export interface EasyTierArtifactManifest {
  schemaVersion: 1;
  project: "EasyTier";
  version: string;
  tag: string;
  source: {
    repository: string;
    commit: string;
    archiveUrl: string;
    buildInstructionsUrl: string;
    upstream: {
      repository: string;
      tag: string;
      commit: string;
    };
  };
  legal: {
    notice: string;
    lgpl: string;
    lgplSha256: string;
    gpl: string;
    gplSha256: string;
    source: string;
  };
  artifacts: EasyTierArtifactDescriptor[];
}

const EASYTIER_REPOSITORY = "https://github.com/kanchengw/easytier-collab";
const EASYTIER_COMMIT = "631b5539bff59adee292c8f8e1b1b43b40742b2f";
const EASYTIER_TAG = "v2.6.4-collab.1";
const EASYTIER_UPSTREAM_REPOSITORY = "https://github.com/EasyTier/EasyTier";
const EASYTIER_UPSTREAM_COMMIT = "8428a89d2dabc94c97d370ec607c6ca142473626";
const EASYTIER_LGPL_SHA256 = "e3a994d82e644b03a792a930f574002658412f62407f5fee083f2555c5f23118";
const GPL_SHA256 = "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986";

export const EASYTIER_ARTIFACT_MANIFEST: EasyTierArtifactManifest = {
  schemaVersion: 1,
  project: "EasyTier",
  version: "2.6.4",
  tag: EASYTIER_TAG,
  source: {
    repository: EASYTIER_REPOSITORY,
    commit: EASYTIER_COMMIT,
    archiveUrl: `${EASYTIER_REPOSITORY}/archive/${EASYTIER_COMMIT}.zip`,
    buildInstructionsUrl: `${EASYTIER_REPOSITORY}/blob/${EASYTIER_COMMIT}/collab/windows-no-tun/build.ps1`,
    upstream: {
      repository: EASYTIER_UPSTREAM_REPOSITORY,
      tag: "v2.6.4",
      commit: EASYTIER_UPSTREAM_COMMIT,
    },
  },
  legal: {
    notice: "NOTICE.md",
    lgpl: "LICENSE.LGPL-3.0",
    lgplSha256: EASYTIER_LGPL_SHA256,
    gpl: "LICENSE.GPL-3.0",
    gplSha256: GPL_SHA256,
    source: "SOURCE.md",
  },
  artifacts: [{
    platform: "win32",
    arch: "x64",
    archiveName: "easytier-windows-x86_64-v2.6.4-collab.1.zip",
    archiveUrl: `${EASYTIER_REPOSITORY}/releases/download/${EASYTIER_TAG}/easytier-windows-x86_64-v2.6.4-collab.1.zip`,
    byteLength: 13_248_117,
    sha256: "86ae7bd23014dbec29d0b5fe1d5e46da202a4c4773f81b5feb99bfa20b9a902b",
  }],
};

function legalFile(value: string, expected: string): void {
  if (value !== expected) throw new Error(`EasyTier legal material path is invalid: ${expected}`);
}

export function validateEasyTierArtifactManifest(manifest: EasyTierArtifactManifest): EasyTierArtifactManifest {
  if (manifest.schemaVersion !== 1 || manifest.project !== "EasyTier" || manifest.version !== "2.6.4"
    || manifest.tag !== EASYTIER_TAG) throw new Error("EasyTier manifest version is invalid");
  if (manifest.source.repository !== EASYTIER_REPOSITORY || manifest.source.commit !== EASYTIER_COMMIT
    || manifest.source.archiveUrl !== `${EASYTIER_REPOSITORY}/archive/${manifest.source.commit}.zip`
    || manifest.source.buildInstructionsUrl !== `${EASYTIER_REPOSITORY}/blob/${manifest.source.commit}/collab/windows-no-tun/build.ps1`
    || manifest.source.upstream.repository !== EASYTIER_UPSTREAM_REPOSITORY
    || manifest.source.upstream.tag !== "v2.6.4"
    || manifest.source.upstream.commit !== EASYTIER_UPSTREAM_COMMIT) {
    throw new Error("EasyTier manifest source is invalid");
  }
  legalFile(manifest.legal.notice, "NOTICE.md");
  legalFile(manifest.legal.lgpl, "LICENSE.LGPL-3.0");
  legalFile(manifest.legal.gpl, "LICENSE.GPL-3.0");
  legalFile(manifest.legal.source, "SOURCE.md");
  if (manifest.legal.lgplSha256 !== EASYTIER_LGPL_SHA256 || manifest.legal.gplSha256 !== GPL_SHA256) {
    throw new Error("EasyTier legal material checksum is invalid");
  }
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length === 0) throw new Error("EasyTier manifest has no artifacts");
  const identities = new Set<string>();
  for (const artifact of manifest.artifacts) {
    const identity = `${artifact.platform}/${artifact.arch}`;
    if (identities.has(identity)) throw new Error("EasyTier manifest contains a duplicate platform");
    identities.add(identity);
    if (!/^[A-Za-z0-9._-]+\.zip$/.test(artifact.archiveName)
      || artifact.archiveUrl !== `${EASYTIER_REPOSITORY}/releases/download/${manifest.tag}/${artifact.archiveName}`
      || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1
      || !/^[a-f0-9]{64}$/.test(artifact.sha256)) throw new Error("EasyTier artifact descriptor is invalid");
  }
  return structuredClone(manifest);
}

function artifactFrom(manifest: EasyTierArtifactManifest, input: { platform: NodeJS.Platform; arch: string; version: string }): EasyTierArtifactDescriptor {
  if (input.version !== manifest.version) throw new Error(`EasyTier ${input.version} is unsupported`);
  const artifact = manifest.artifacts.find((candidate) => candidate.platform === input.platform && candidate.arch === input.arch);
  if (!artifact) throw new Error(`EasyTier is unsupported on ${input.platform}/${input.arch}`);
  return structuredClone(artifact);
}

export function resolveEasyTierArtifact(input: { platform?: NodeJS.Platform; arch?: string; version?: string } = {}): EasyTierArtifactDescriptor {
  const manifest = validateEasyTierArtifactManifest(EASYTIER_ARTIFACT_MANIFEST);
  return artifactFrom(manifest, {
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    version: input.version ?? manifest.version,
  });
}

export interface EasyTierArtifactDownloader {
  download(url: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
}

export const fetchEasyTierArtifact: EasyTierArtifactDownloader = {
  async *download(url, signal) {
    const response = await fetch(url, { signal });
    if (!response.ok || !response.body) throw new Error(`EasyTier download failed with HTTP ${response.status}`);
    const reader = response.body.getReader();
    let complete = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) {
          complete = true;
          return;
        }
        yield chunk.value;
      }
    } finally {
      if (!complete) await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  },
};

export interface PreparedEasyTierArtifact {
  descriptor: EasyTierArtifactDescriptor;
  archivePath: string;
  cached: boolean;
}

function defaultLegalRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "third_party", "easytier");
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const result = await handle.write(bytes, offset, bytes.byteLength - offset);
    if (result.bytesWritten < 1) throw new Error("EasyTier artifact write made no progress");
    offset += result.bytesWritten;
  }
}

export class EasyTierArtifactStore {
  private readonly root: string;
  private readonly legalRoot: string;
  private readonly downloader: EasyTierArtifactDownloader;
  private readonly manifest: EasyTierArtifactManifest;
  private readonly preparing = new Map<string, Promise<PreparedEasyTierArtifact>>();

  constructor(options: {
    root?: string;
    legalRoot?: string;
    downloader?: EasyTierArtifactDownloader;
    manifest?: EasyTierArtifactManifest;
  } = {}) {
    this.root = options.root ?? resolveDefaultCollabEasyTierDir();
    this.legalRoot = options.legalRoot ?? defaultLegalRoot();
    this.downloader = options.downloader ?? fetchEasyTierArtifact;
    this.manifest = validateEasyTierArtifactManifest(options.manifest ?? EASYTIER_ARTIFACT_MANIFEST);
  }

  async prepare(input: { platform?: NodeJS.Platform; arch?: string; version?: string; signal?: AbortSignal } = {}): Promise<PreparedEasyTierArtifact> {
    const request = {
      platform: input.platform ?? process.platform,
      arch: input.arch ?? process.arch,
      version: input.version ?? this.manifest.version,
    };
    const descriptor = artifactFrom(this.manifest, request);
    const key = `${request.version}/${request.platform}/${request.arch}`;
    const active = this.preparing.get(key);
    if (active) return active;
    const pending = this.prepareOnce(descriptor, input.signal).finally(() => {
      if (this.preparing.get(key) === pending) this.preparing.delete(key);
    });
    this.preparing.set(key, pending);
    return pending;
  }

  private async prepareOnce(descriptor: EasyTierArtifactDescriptor, signal?: AbortSignal): Promise<PreparedEasyTierArtifact> {
    await this.verifyLegalMaterials();
    const directory = join(this.root, `v${this.manifest.version}`, `${descriptor.platform}-${descriptor.arch}`);
    const archivePath = join(directory, descriptor.archiveName);
    try {
      const metadata = await stat(archivePath);
      if (!metadata.isFile() || metadata.size !== descriptor.byteLength) {
        throw new Error("Cached EasyTier artifact size does not match its manifest");
      }
      const existing = await readFile(archivePath);
      this.verifyBytes(existing, descriptor);
      return { descriptor, archivePath, cached: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `${descriptor.archiveName}.tmp-${randomUUID()}`);
    const digest = createHash("sha256");
    let byteLength = 0;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, "wx", 0o600);
      for await (const chunk of this.downloader.download(descriptor.archiveUrl, signal)) {
        if (!(chunk instanceof Uint8Array)) throw new Error("EasyTier downloader returned invalid bytes");
        byteLength += chunk.byteLength;
        if (byteLength > descriptor.byteLength) throw new Error("EasyTier artifact exceeds its pinned size");
        digest.update(chunk);
        await writeAll(handle, chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (byteLength !== descriptor.byteLength) throw new Error("EasyTier artifact size does not match its manifest");
      if (digest.digest("hex") !== descriptor.sha256) throw new Error("EasyTier artifact checksum does not match its manifest");
      await rename(temporary, archivePath);
      return { descriptor, archivePath, cached: false };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private verifyBytes(bytes: Uint8Array, descriptor: EasyTierArtifactDescriptor): void {
    if (bytes.byteLength !== descriptor.byteLength) throw new Error("Cached EasyTier artifact size does not match its manifest");
    if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) throw new Error("Cached EasyTier artifact checksum does not match its manifest");
  }

  private async verifyLegalMaterials(): Promise<void> {
    const paths = this.manifest.legal;
    let notice: string;
    let lgpl: string;
    let gpl: string;
    let source: string;
    try {
      [notice, lgpl, gpl, source] = await Promise.all([
        readFile(join(this.legalRoot, paths.notice), "utf8"),
        readFile(join(this.legalRoot, paths.lgpl), "utf8"),
        readFile(join(this.legalRoot, paths.gpl), "utf8"),
        readFile(join(this.legalRoot, paths.source), "utf8"),
      ]);
    } catch (error) {
      throw new Error("EasyTier legal material is missing", { cause: error });
    }
    const normalizedSha256 = (text: string): string => createHash("sha256").update(text.replaceAll("\r\n", "\n"), "utf8").digest("hex");
    if (!notice.includes("EasyTier") || !notice.includes(this.manifest.version) || !notice.includes(this.manifest.source.commit)
      || normalizedSha256(lgpl) !== paths.lgplSha256
      || normalizedSha256(gpl) !== paths.gplSha256
      || !source.includes(this.manifest.source.commit) || !source.includes(this.manifest.source.buildInstructionsUrl)) {
      throw new Error("EasyTier legal material does not match the pinned release");
    }
  }
}
