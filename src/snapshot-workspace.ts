import { createHash, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { WorkspaceSnapshotPackage } from "./collaboration-types.js";
import { isSafeWorkspaceSnapshotPath, validateWorkspaceSnapshotPackage } from "./workspace-snapshot-store.js";
import type { WorkspaceSnapshotProvider } from "./workspace-service.js";

const LOCAL_READ_CHUNK_BYTES = 256 * 1024;

function hash(content: Uint8Array | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export class MaterializedSnapshotWorkspace {
  constructor(readonly root: string, readonly snapshot: WorkspaceSnapshotPackage) {}

  get snapshotId(): string { return this.snapshot.snapshotId; }

  async readFile(path: string): Promise<Uint8Array> {
    if (!isSafeWorkspaceSnapshotPath(path)) throw new Error("Workspace Snapshot path is unsafe");
    const file = this.snapshot.files.find((candidate) => candidate.path === path);
    if (!file) throw new Error(`${path} is not in Workspace Snapshot`);
    const target = join(this.root, ...path.split("/"));
    const info = await lstat(target);
    const contained = relative(await realpath(this.root), await realpath(target));
    if (!info.isFile() || info.isSymbolicLink() || contained.startsWith("..") || isAbsolute(contained)) throw new Error("Materialized Workspace Snapshot path is unsafe");
    const content = await readFile(target);
    if (content.byteLength !== file.size || hash(content) !== file.contentHash) throw new Error(`Materialized Workspace Snapshot is corrupted: ${path}`);
    return content;
  }

  async dispose(): Promise<void> {
    await rm(dirname(this.root), { recursive: true, force: true, maxRetries: 3 });
  }
}

export async function materializeSnapshotFromProvider(input: {
  snapshotId: string;
  provider: WorkspaceSnapshotProvider;
  materializer: SnapshotWorkspaceMaterializer;
}): Promise<MaterializedSnapshotWorkspace> {
  const snapshot = await input.provider.load(input.snapshotId);
  if (!snapshot) throw new Error(`Workspace Snapshot ${input.snapshotId} does not exist`);
  const contents = new Map<string, Uint8Array>();
  for (const file of snapshot.files) {
    const content = Buffer.alloc(file.size);
    let offset = 0;
    while (offset < file.size) {
      const bytes = await input.provider.readChunk(snapshot.snapshotId, file.path, offset, Math.min(LOCAL_READ_CHUNK_BYTES, file.size - offset));
      if (bytes.byteLength < 1 || offset + bytes.byteLength > file.size) throw new Error(`Workspace Snapshot content is truncated: ${file.path}`);
      content.set(bytes, offset);
      offset += bytes.byteLength;
    }
    contents.set(file.path, content);
  }
  return await input.materializer.materialize(snapshot, contents);
}

export class SnapshotWorkspaceMaterializer {
  constructor(private readonly options: { root: string }) {}

  async materialize(snapshot: WorkspaceSnapshotPackage, contents: ReadonlyMap<string, Uint8Array>): Promise<MaterializedSnapshotWorkspace> {
    const validated = validateWorkspaceSnapshotPackage(snapshot, snapshot.snapshotId);
    await mkdir(this.options.root, { recursive: true, mode: 0o700 });
    const destination = join(this.options.root, validated.snapshotId);
    if (await this.exists(destination)) return await this.loadExisting(destination, validated);

    const temporary = join(this.options.root, `.${validated.snapshotId}.${randomUUID()}.tmp`);
    const workspaceRoot = join(temporary, "workspace");
    await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
    try {
      const directories = new Set<string>([workspaceRoot]);
      const targets: string[] = [];
      for (const file of validated.files) {
        const content = contents.get(file.path);
        if (!content || content.byteLength !== file.size || hash(content) !== file.contentHash) {
          throw new Error(`Workspace Snapshot content does not match manifest: ${file.path}`);
        }
        const target = join(workspaceRoot, ...file.path.split("/"));
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        for (let current = dirname(target); current.startsWith(workspaceRoot); current = dirname(current)) {
          directories.add(current);
          if (current === workspaceRoot) break;
        }
        await writeFile(target, content, { flag: "wx", mode: 0o600 });
        targets.push(target);
      }
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(validated, null, 2) + "\n", { flag: "wx", mode: 0o400 });
      for (const target of targets) await chmod(target, 0o400);
      for (const directory of [...directories].sort((left, right) => right.length - left.length)) await chmod(directory, 0o500);
      await rename(temporary, destination);
      return new MaterializedSnapshotWorkspace(join(destination, "workspace"), validated);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      if (await this.exists(destination)) return await this.loadExisting(destination, validated);
      throw error;
    }
  }

  private async loadExisting(directory: string, expected: WorkspaceSnapshotPackage): Promise<MaterializedSnapshotWorkspace> {
    const stored = validateWorkspaceSnapshotPackage(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as WorkspaceSnapshotPackage, expected.snapshotId);
    if (JSON.stringify(stored) !== JSON.stringify(expected)) throw new Error("Materialized Workspace Snapshot identity conflicts with existing content");
    const workspace = new MaterializedSnapshotWorkspace(join(directory, "workspace"), stored);
    for (const file of stored.files) await workspace.readFile(file.path);
    return workspace;
  }

  private async exists(path: string): Promise<boolean> {
    try { await access(path); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
