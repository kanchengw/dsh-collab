import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { LocalSidecarServiceSnapshot } from "./local-sidecar.js";

function parse(text: string): LocalSidecarServiceSnapshot {
  try {
    const value = JSON.parse(text) as LocalSidecarServiceSnapshot;
    if (!value || value.version !== 1 || !Array.isArray(value.tasks)) throw new Error("unsupported version");
    return value;
  } catch (error) {
    throw new Error("dsh-collab local SideTask state is malformed", { cause: error });
  }
}

export class LocalSideTaskFile {
  private writes = Promise.resolve();
  private serialized: string | undefined;

  constructor(readonly path: string) {}

  loadSync(): LocalSidecarServiceSnapshot | undefined {
    try {
      const text = readFileSync(this.path, "utf8");
      this.serialized = text;
      return parse(text);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  save(snapshot: LocalSidecarServiceSnapshot): Promise<void> {
    const serialized = JSON.stringify(snapshot, null, 2) + "\n";
    if (serialized === this.serialized) return this.writes;
    this.writes = this.writes.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temporary = this.path + ".tmp";
      await writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, this.path);
      this.serialized = serialized;
    });
    return this.writes;
  }

  flush(): Promise<void> { return this.writes; }
}
