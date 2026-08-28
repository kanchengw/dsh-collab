import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LocalSideTaskFile } from "../../src/local-sidecar-store.js";
import type { LocalSidecarServiceSnapshot } from "../../src/local-sidecar.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const snapshot: LocalSidecarServiceSnapshot = { version: 1, tasks: [] };

describe("local SideTask persistence", () => {
  it("writes a versioned snapshot atomically and restores it", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-side-tasks-"));
    roots.push(root);
    const path = join(root, "nested", "side-tasks.json");
    const store = new LocalSideTaskFile(path);

    await store.save(snapshot);

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(snapshot);
    expect(new LocalSideTaskFile(path).loadSync()).toEqual(snapshot);
  });

  it("fails closed for malformed state", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-side-tasks-"));
    roots.push(root);
    const path = join(root, "side-tasks.json");
    await writeFile(path, "{bad", "utf8");

    expect(() => new LocalSideTaskFile(path).loadSync()).toThrow(/malformed/i);
  });

  it("can retry the same snapshot after a write failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-side-tasks-"));
    roots.push(root);
    const blocker = join(root, "blocker");
    const path = join(blocker, "side-tasks.json");
    await writeFile(blocker, "not a directory", "utf8");
    const store = new LocalSideTaskFile(path);

    await expect(store.save(snapshot)).rejects.toThrow();
    await rm(blocker);
    await expect(store.save(snapshot)).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(snapshot);
  });
});
