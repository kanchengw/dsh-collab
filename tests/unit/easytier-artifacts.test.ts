import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EASYTIER_ARTIFACT_MANIFEST,
  EasyTierArtifactStore,
  fetchEasyTierArtifact,
  resolveEasyTierArtifact,
  validateEasyTierArtifactManifest,
  type EasyTierArtifactDownloader,
  type EasyTierArtifactManifest,
} from "../../src/easytier-artifacts.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fixtureManifest(bytes: Uint8Array): EasyTierArtifactManifest {
  const source = EASYTIER_ARTIFACT_MANIFEST.source;
  return {
    ...EASYTIER_ARTIFACT_MANIFEST,
    source: { ...source, upstream: { ...source.upstream } },
    legal: { ...EASYTIER_ARTIFACT_MANIFEST.legal },
    artifacts: [{
      ...EASYTIER_ARTIFACT_MANIFEST.artifacts[0]!,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    }],
  };
}

async function legalRoot(commit = EASYTIER_ARTIFACT_MANIFEST.source.commit): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-legal-"));
  roots.push(root);
  const [lgpl, gpl] = await Promise.all([
    readFile(join(process.cwd(), "third_party", "easytier", "LICENSE.LGPL-3.0"), "utf8"),
    readFile(join(process.cwd(), "third_party", "easytier", "LICENSE.GPL-3.0"), "utf8"),
  ]);
  await Promise.all([
    writeFile(join(root, "NOTICE.md"), `EasyTier v2.6.4\n${commit}\n`, "utf8"),
    writeFile(join(root, "LICENSE.LGPL-3.0"), lgpl, "utf8"),
    writeFile(join(root, "LICENSE.GPL-3.0"), gpl, "utf8"),
    writeFile(join(root, "SOURCE.md"), `Corresponding source ${commit}\n${EASYTIER_ARTIFACT_MANIFEST.source.buildInstructionsUrl}\n`, "utf8"),
  ]);
  return root;
}

describe("EasyTier artifact supply chain", () => {
  it("pins the verified no-Npcap fork while retaining the exact upstream base", () => {
    expect(EASYTIER_ARTIFACT_MANIFEST).toMatchObject({
      version: "2.6.4",
      tag: "v2.6.4-collab.1",
      source: {
        repository: "https://github.com/kanchengw/easytier-collab",
        commit: "631b5539bff59adee292c8f8e1b1b43b40742b2f",
        upstream: {
          repository: "https://github.com/EasyTier/EasyTier",
          tag: "v2.6.4",
          commit: "8428a89d2dabc94c97d370ec607c6ca142473626",
        },
      },
      artifacts: [{
        platform: "win32",
        arch: "x64",
        archiveName: "easytier-windows-x86_64-v2.6.4-collab.1.zip",
        byteLength: 13_248_117,
        sha256: "86ae7bd23014dbec29d0b5fe1d5e46da202a4c4773f81b5feb99bfa20b9a902b",
      }],
    });
    expect(resolveEasyTierArtifact({ platform: "win32", arch: "x64", version: "2.6.4" }).archiveUrl)
      .toBe("https://github.com/kanchengw/easytier-collab/releases/download/v2.6.4-collab.1/easytier-windows-x86_64-v2.6.4-collab.1.zip");
    expect(() => resolveEasyTierArtifact({ platform: "linux", arch: "x64", version: "2.6.4" })).toThrow("unsupported");
    expect(() => resolveEasyTierArtifact({ platform: "win32", arch: "x64", version: "2.6.5" })).toThrow("unsupported");
  });

  it("rejects manifest source drift before any artifact can be trusted", () => {
    const forged = {
      ...EASYTIER_ARTIFACT_MANIFEST,
      source: { ...EASYTIER_ARTIFACT_MANIFEST.source, repository: "https://mirror.invalid/EasyTier" },
    };
    expect(() => validateEasyTierArtifactManifest(forged)).toThrow("source");
    const forgedUpstream = {
      ...EASYTIER_ARTIFACT_MANIFEST,
      source: {
        ...EASYTIER_ARTIFACT_MANIFEST.source,
        upstream: { ...EASYTIER_ARTIFACT_MANIFEST.source.upstream, commit: "0".repeat(40) },
      },
    };
    expect(() => validateEasyTierArtifactManifest(forgedUpstream)).toThrow("source");
  });

  it("cancels the HTTP response body when artifact consumption stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("oversized chunk"));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(body, { status: 200 }));
    try {
      for await (const _chunk of fetchEasyTierArtifact.download("https://github.com/EasyTier/EasyTier/releases/download/v2.6.4/test.zip")) break;
      expect(cancelled).toBe(true);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("requires license and corresponding-source materials before downloading", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-cache-"));
    const missingLegal = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-missing-legal-"));
    roots.push(root, missingLegal);
    const downloader: EasyTierArtifactDownloader = { download: vi.fn(async function* () { yield Buffer.from("unused"); }) };
    const store = new EasyTierArtifactStore({ root, legalRoot: missingLegal, downloader, manifest: fixtureManifest(Buffer.from("archive")) });

    await expect(store.prepare({ platform: "win32", arch: "x64", version: "2.6.4" })).rejects.toThrow("legal material");
    expect(downloader.download).not.toHaveBeenCalled();
  });

  it("rejects placeholder text in place of the complete license terms", async () => {
    const bytes = Buffer.from("archive");
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-cache-"));
    roots.push(root);
    const legal = await legalRoot();
    await writeFile(join(legal, "LICENSE.LGPL-3.0"), "GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3\n", "utf8");
    const downloader: EasyTierArtifactDownloader = { download: vi.fn(async function* () { yield bytes; }) };
    const store = new EasyTierArtifactStore({ root, legalRoot: legal, downloader, manifest: fixtureManifest(bytes) });

    await expect(store.prepare({ platform: "win32", arch: "x64", version: "2.6.4" })).rejects.toThrow("legal material");
    expect(downloader.download).not.toHaveBeenCalled();
  });

  it("publishes one verified cache artifact atomically and reuses it", async () => {
    const bytes = Buffer.from("verified EasyTier archive");
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-cache-"));
    roots.push(root);
    const downloader: EasyTierArtifactDownloader = {
      download: vi.fn(async function* () { yield bytes.subarray(0, 8); yield bytes.subarray(8); }),
    };
    const store = new EasyTierArtifactStore({ root, downloader, manifest: fixtureManifest(bytes) });

    const first = await store.prepare({ platform: "win32", arch: "x64", version: "2.6.4" });
    const second = await store.prepare({ platform: "win32", arch: "x64", version: "2.6.4" });

    expect(first.cached).toBe(false);
    expect(second).toEqual({ ...first, cached: true });
    expect(await readFile(first.archivePath)).toEqual(bytes);
    expect(downloader.download).toHaveBeenCalledOnce();
    expect((await readdir(join(root, "v2.6.4", "win32-x64"))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("never publishes a truncated or checksum-mismatched download", async () => {
    const expected = Buffer.from("expected archive");
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-cache-"));
    roots.push(root);
    const legal = await legalRoot();
    const downloader: EasyTierArtifactDownloader = { download: vi.fn(async function* () { yield Buffer.from("tampered archive"); }) };
    const manifest = fixtureManifest(expected);
    const store = new EasyTierArtifactStore({ root, legalRoot: legal, downloader, manifest });

    await expect(store.prepare({ platform: "win32", arch: "x64", version: "2.6.4" })).rejects.toThrow(/size|checksum/);
    const cache = join(root, "v2.6.4", "win32-x64");
    await mkdir(cache, { recursive: true });
    expect(await readdir(cache)).toEqual([]);
  });

  it("rejects a corrupted cached archive without replacing it from the network", async () => {
    const expected = Buffer.from("expected archive");
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-cache-"));
    roots.push(root);
    const cache = join(root, "v2.6.4", "win32-x64");
    await mkdir(cache, { recursive: true });
    const manifest = fixtureManifest(expected);
    const archivePath = join(cache, manifest.artifacts[0]!.archiveName);
    await writeFile(archivePath, Buffer.from("tampered archive"));
    const downloader: EasyTierArtifactDownloader = { download: vi.fn(async function* () { yield expected; }) };
    const store = new EasyTierArtifactStore({ root, downloader, manifest });

    await expect(store.prepare({ platform: "win32", arch: "x64", version: "2.6.4" })).rejects.toThrow("Cached EasyTier artifact");
    expect(downloader.download).not.toHaveBeenCalled();
    expect(await readFile(archivePath)).toEqual(Buffer.from("tampered archive"));
  });

  it("shares one in-flight download for the same pinned artifact", async () => {
    const bytes = Buffer.from("verified EasyTier archive");
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-cache-"));
    roots.push(root);
    let releaseDownload!: () => void;
    const wait = new Promise<void>((resolve) => { releaseDownload = resolve; });
    const downloader: EasyTierArtifactDownloader = { download: vi.fn(async function* () { await wait; yield bytes; }) };
    const store = new EasyTierArtifactStore({ root, downloader, manifest: fixtureManifest(bytes) });

    const first = store.prepare({ platform: "win32", arch: "x64", version: "2.6.4" });
    const second = store.prepare({ platform: "win32", arch: "x64", version: "2.6.4" });
    releaseDownload();

    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(downloader.download).toHaveBeenCalledOnce();
  });

  it("does not let an unsupported concurrent request reuse another platform download", async () => {
    const bytes = Buffer.from("verified EasyTier archive");
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-easytier-cache-"));
    roots.push(root);
    let releaseDownload!: () => void;
    const wait = new Promise<void>((resolve) => { releaseDownload = resolve; });
    const downloader: EasyTierArtifactDownloader = { download: vi.fn(async function* () { await wait; yield bytes; }) };
    const store = new EasyTierArtifactStore({ root, downloader, manifest: fixtureManifest(bytes) });

    const supported = store.prepare({ platform: "win32", arch: "x64", version: "2.6.4" });
    await expect(store.prepare({ platform: "linux", arch: "x64", version: "2.6.4" })).rejects.toThrow("unsupported");
    releaseDownload();
    await expect(supported).resolves.toMatchObject({ cached: false });
  });
});
