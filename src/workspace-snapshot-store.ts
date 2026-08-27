import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceSnapshotPackage } from "./collaboration-types.js";

interface StoredSnapshot {
  version: 1;
  snapshot: WorkspaceSnapshotPackage;
}

function hash(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function snapshotDirectory(root: string, snapshotId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(snapshotId)) throw new Error("snapshotId is invalid");
  return join(root, snapshotId);
}

export function isSafeWorkspaceSnapshotPath(path: string): boolean {
  const segments = path.split("/");
  return path !== ""
    && !path.startsWith("/")
    && !/^[A-Za-z]:[\\/]/.test(path)
    && !path.includes("\\")
    && segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

export function validateWorkspaceSnapshotPackage(snapshot: WorkspaceSnapshotPackage, expectedSnapshotId?: string): WorkspaceSnapshotPackage {
  if (
    !snapshot
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(snapshot.snapshotId)
    || (expectedSnapshotId !== undefined && snapshot.snapshotId !== expectedSnapshotId)
    || typeof snapshot.roomId !== "string"
    || snapshot.roomId === ""
    || typeof snapshot.hostSessionId !== "string"
    || snapshot.hostSessionId === ""
    || !Number.isSafeInteger(snapshot.roomEventSeq)
    || snapshot.roomEventSeq < 0
    || !Number.isSafeInteger(snapshot.createdAt)
    || snapshot.createdAt < 0
    || (snapshot.headOid !== undefined && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.headOid))
    || !Array.isArray(snapshot.files)
  ) {
    throw new Error("Workspace Snapshot manifest is malformed");
  }
  if (!/^[a-f0-9]{64}$/.test(snapshot.manifestHash)) throw new Error("Workspace Snapshot manifest hash is invalid");
  const paths = new Set<string>();
  for (const file of snapshot.files) {
    if (
      !file
      || typeof file.path !== "string"
      || !isSafeWorkspaceSnapshotPath(file.path)
      || paths.has(file.path)
      || !/^[a-f0-9]{64}$/.test(file.contentHash)
      || !Number.isSafeInteger(file.size)
      || file.size < 0
      || (file.source !== "tracked" && file.source !== "untracked")
    ) {
      throw new Error("Workspace Snapshot file manifest is malformed");
    }
    paths.add(file.path);
  }
  if (hash(JSON.stringify(snapshot.files)) !== snapshot.manifestHash) throw new Error("Workspace Snapshot manifest hash does not match");
  return structuredClone(snapshot);
}

function parseSnapshot(text: string, expectedSnapshotId: string): WorkspaceSnapshotPackage {
  let stored: StoredSnapshot;
  try {
    stored = JSON.parse(text) as StoredSnapshot;
  } catch (error) {
    throw new Error("Workspace Snapshot manifest is malformed", { cause: error });
  }
  if (stored?.version !== 1 || !stored.snapshot) {
    throw new Error("Workspace Snapshot manifest is malformed");
  }
  return validateWorkspaceSnapshotPackage(stored.snapshot, expectedSnapshotId);
}

export class WorkspaceSnapshotStore {
  constructor(readonly root: string) {}

  async save(snapshot: WorkspaceSnapshotPackage, contents: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const validated = validateWorkspaceSnapshotPackage(snapshot, snapshot.snapshotId);
    const destination = snapshotDirectory(this.root, validated.snapshotId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      await access(destination);
      throw new Error(`Workspace Snapshot ${snapshot.snapshotId} already exists`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const temporary = join(this.root, `.${validated.snapshotId}.${randomUUID()}.tmp`);
    await mkdir(join(temporary, "blobs"), { recursive: true, mode: 0o700 });
    try {
      const written = new Set<string>();
      for (const file of validated.files) {
        const content = contents.get(file.path);
        if (!content) throw new Error(`Workspace Snapshot content is missing: ${file.path}`);
        if (content.byteLength !== file.size || hash(content) !== file.contentHash) {
          throw new Error(`Workspace Snapshot content does not match manifest: ${file.path}`);
        }
        if (!written.has(file.contentHash)) {
          await writeFile(join(temporary, "blobs", file.contentHash), content, { mode: 0o600, flag: "wx" });
          written.add(file.contentHash);
        }
      }
      const stored: StoredSnapshot = { version: 1, snapshot: validated };
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(stored, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async load(snapshotId: string): Promise<WorkspaceSnapshotPackage | undefined> {
    const directory = snapshotDirectory(this.root, snapshotId);
    try {
      return parseSnapshot(await readFile(join(directory, "manifest.json"), "utf8"), snapshotId);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async readFile(snapshotId: string, path: string): Promise<Uint8Array> {
    const snapshot = await this.load(snapshotId);
    if (!snapshot) throw new Error(`Workspace Snapshot ${snapshotId} does not exist`);
    const file = snapshot.files.find((candidate) => candidate.path === path);
    if (!file) throw new Error(`${path} is not in snapshot ${snapshotId}`);
    const content = await readFile(join(snapshotDirectory(this.root, snapshotId), "blobs", file.contentHash));
    if (content.byteLength !== file.size || hash(content) !== file.contentHash) {
      throw new Error(`Workspace Snapshot content is corrupted: ${path}`);
    }
    return content;
  }

  async readChunk(snapshotId: string, path: string, offset: number, length: number): Promise<Uint8Array> {
    const snapshot = await this.load(snapshotId);
    if (!snapshot) throw new Error(`Workspace Snapshot ${snapshotId} does not exist`);
    const file = snapshot.files.find((candidate) => candidate.path === path);
    if (!file) throw new Error(`${path} is not in snapshot ${snapshotId}`);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.size || !Number.isSafeInteger(length) || length < 1) {
      throw new Error("Workspace Snapshot chunk range is invalid");
    }
    const handle = await open(join(snapshotDirectory(this.root, snapshotId), "blobs", file.contentHash), "r");
    try {
      const stat = await handle.stat();
      if (stat.size !== file.size) throw new Error(`Workspace Snapshot content is corrupted: ${path}`);
      const buffer = Buffer.alloc(Math.min(length, file.size - offset));
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }
}
