import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import type { DshCollabHostRuntimeSnapshot } from "./host-runtime.js";

export function resolveDefaultCollabStateFile(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v1", "state.json");
}

export function resolveDefaultCollabSnapshotDir(env: Record<string, string | undefined> = process.env): string {
  return join(resolveDshHome(undefined, env), "collab", "v1", "snapshots");
}

function parseSnapshot(text: string): DshCollabHostRuntimeSnapshot {
  try {
    const value = JSON.parse(text) as DshCollabHostRuntimeSnapshot;
    if (!value || value.version !== 1) throw new Error("unsupported version");
    return value;
  } catch (error) {
    throw new Error("dsh-collab state is malformed", { cause: error });
  }
}

export class HostSnapshotFile {
  private writes = Promise.resolve();

  constructor(readonly path: string) {}

  loadSync(): DshCollabHostRuntimeSnapshot | undefined {
    try {
      return parseSnapshot(readFileSync(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async load(): Promise<DshCollabHostRuntimeSnapshot | undefined> {
    try {
      return parseSnapshot(await readFile(this.path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(snapshot: DshCollabHostRuntimeSnapshot): Promise<void> {
    const serialized = JSON.stringify(snapshot, null, 2) + "\n";
    this.writes = this.writes.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = this.path + ".tmp";
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
    });
    return this.writes;
  }

  flush(): Promise<void> {
    return this.writes;
  }
}
