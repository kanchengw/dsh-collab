import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HostSnapshotFile, resolveDefaultCollabSnapshotDir, resolveDefaultCollabStateFile, resolveDefaultCollabWorkspaceDir } from "../../src/persistence.js";
import type { DshCollabHostRuntimeSnapshot } from "../../src/host-runtime.js";

const dirs: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function snapshot(): DshCollabHostRuntimeSnapshot {
  return {
    version: 1,
    rooms: { version: 1, rooms: [] },
    ledger: { version: 1, rooms: [] },
    dispatcher: { version: 1, records: [], queue: [], nextQueueSeq: 1 },
  };
}

describe("Host snapshot file", () => {
  it("uses the DSH home convention and atomically round-trips a versioned snapshot", async () => {
    expect(resolveDefaultCollabStateFile({ DSH_HOME: "C:\\dsh-test" })).toBe(join("C:\\dsh-test", "collab", "v1", "state.json"));
    expect(resolveDefaultCollabSnapshotDir({ DSH_HOME: "C:\\dsh-test" })).toBe(join("C:\\dsh-test", "collab", "v1", "snapshots"));
    expect(resolveDefaultCollabWorkspaceDir({ DSH_HOME: "C:\\dsh-test" })).toBe(join("C:\\dsh-test", "collab", "v1", "workspaces"));
    const dir = await mkdtemp(join(tmpdir(), "dsh-collab-state-"));
    dirs.push(dir);
    const path = join(dir, "nested", "state.json");
    const store = new HostSnapshotFile(path);
    await store.save(snapshot());
    expect(await store.load()).toEqual(snapshot());
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(snapshot());
  });

  it("treats absence as a new room but fails closed on malformed state", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-collab-state-"));
    dirs.push(dir);
    const path = join(dir, "state.json");
    const store = new HostSnapshotFile(path);
    await expect(store.load()).resolves.toBeUndefined();
    await writeFile(path, "{", "utf8");
    await expect(store.load()).rejects.toThrow("state");
  });

  it("serializes overlapping saves so the newest snapshot wins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-collab-state-"));
    dirs.push(dir);
    const path = join(dir, "state.json");
    const store = new HostSnapshotFile(path);
    const first = snapshot();
    const second = { ...snapshot(), dispatcher: { ...snapshot().dispatcher, nextQueueSeq: 2 } };
    await Promise.all([store.save(first), store.save(second)]);
    expect(await store.load()).toEqual(second);
  });

  it("recovers the write queue after a transient filesystem failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dsh-collab-state-"));
    dirs.push(dir);
    const blocker = join(dir, "blocked");
    const path = join(blocker, "state.json");
    const store = new HostSnapshotFile(path);
    await writeFile(blocker, "not a directory", "utf8");

    await expect(store.save(snapshot())).rejects.toBeDefined();
    await rm(blocker);
    await mkdir(blocker);

    await expect(store.save(snapshot())).resolves.toBeUndefined();
    await expect(store.load()).resolves.toEqual(snapshot());
  });
});
