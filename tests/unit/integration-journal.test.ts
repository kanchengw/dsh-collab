import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeSetApplyPlan } from "../../src/change-set-apply.js";
import {
  IntegrationJournalStore,
  type IntegrationJournalWorkspace,
} from "../../src/integration-journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const oldModify = Buffer.from("old modify\n");
const oldDelete = Buffer.from("old delete\n");
const oldRename = Buffer.from("old rename\n");
const newModify = Buffer.from("new modify\n");
const newAdd = Buffer.from("new add\n");
const newRename = Buffer.from("new rename\n");

function applyPlan(overrides: Partial<ChangeSetApplyPlan> = {}): ChangeSetApplyPlan {
  return {
    roomId: "room-1",
    changeSetId: "a".repeat(64),
    baseWorkspaceVersionId: "version-1",
    operations: [{
      path: "src/modify.ts",
      operation: "modify",
      base: { path: "src/modify.ts", contentHash: hash(oldModify), size: oldModify.byteLength },
      result: { contentHash: hash(newModify), size: newModify.byteLength, bytes: new Uint8Array(newModify) },
    }, {
      path: "src/added.ts",
      operation: "add",
      result: { contentHash: hash(newAdd), size: newAdd.byteLength, bytes: new Uint8Array(newAdd) },
    }, {
      path: "src/deleted.ts",
      operation: "delete",
      base: { path: "src/deleted.ts", contentHash: hash(oldDelete), size: oldDelete.byteLength },
    }, {
      path: "src/renamed.ts",
      previousPath: "src/rename-me.ts",
      operation: "rename",
      base: { path: "src/rename-me.ts", contentHash: hash(oldRename), size: oldRename.byteLength },
      result: { contentHash: hash(newRename), size: newRename.byteLength, bytes: new Uint8Array(newRename) },
    }],
    ...overrides,
  };
}

class MemoryWorkspace implements IntegrationJournalWorkspace {
  readonly files: Map<string, Uint8Array>;
  mutations = 0;
  failAfterMutation?: number;

  constructor(files: ReadonlyMap<string, Uint8Array>) {
    this.files = new Map([...files].map(([path, bytes]) => [path, structuredClone(bytes)]));
  }

  async read(path: string): Promise<Uint8Array | undefined> {
    const bytes = this.files.get(path);
    return bytes ? structuredClone(bytes) : undefined;
  }

  async replace(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, structuredClone(bytes));
    this.afterMutation();
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.afterMutation();
  }

  private afterMutation(): void {
    this.mutations += 1;
    if (this.failAfterMutation === this.mutations) throw new Error("simulated process interruption");
  }
}

function initialFiles(): Map<string, Uint8Array> {
  return new Map([
    ["src/modify.ts", oldModify],
    ["src/deleted.ts", oldDelete],
    ["src/rename-me.ts", oldRename],
    ["unrelated.ts", Buffer.from("keep\n")],
  ]);
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-integration-journal-"));
  roots.push(root);
  return { root, store: new IntegrationJournalStore(root), workspace: new MemoryWorkspace(initialFiles()) };
}

function expectOriginalWorkspace(workspace: MemoryWorkspace): void {
  const actual = [...workspace.files].sort(([left], [right]) => left.localeCompare(right));
  const expected = [...initialFiles()].sort(([left], [right]) => left.localeCompare(right));
  expect(actual.map(([path, bytes]) => [path, [...bytes]])).toEqual(expected.map(([path, bytes]) => [path, [...bytes]]));
}

async function putFullyAppliedState(workspace: MemoryWorkspace): Promise<void> {
  await workspace.replace("src/modify.ts", newModify);
  await workspace.replace("src/added.ts", newAdd);
  await workspace.remove("src/deleted.ts");
  await workspace.remove("src/rename-me.ts");
  await workspace.replace("src/renamed.ts", newRename);
}

describe("Integration journal", () => {
  it("publishes a complete original-state journal before exposing it to apply", async () => {
    const { root, store, workspace } = await setup();

    const journal = await store.prepare(applyPlan(), workspace);

    expect(journal).toMatchObject({
      version: 1,
      roomId: "room-1",
      changeSetId: "a".repeat(64),
      executorStepCount: 5,
      originals: [
        { path: "src/added.ts", present: false },
        { path: "src/deleted.ts", present: true, contentHash: hash(oldDelete) },
        { path: "src/modify.ts", present: true, contentHash: hash(oldModify) },
        { path: "src/rename-me.ts", present: true, contentHash: hash(oldRename) },
        { path: "src/renamed.ts", present: false },
      ],
    });
    expect(await store.list()).toEqual([journal.integrationId]);
    expect(workspace.mutations).toBe(0);
    const files = await readdir(join(root, journal.integrationId));
    expect(files.sort()).toEqual(["blobs", "checkpoint.json", "manifest.json"]);
    expect(JSON.parse(await readFile(join(root, journal.integrationId, "checkpoint.json"), "utf8"))).toMatchObject({
      integrationId: journal.integrationId,
      executorCompletedSteps: 0,
      recovery: { phase: "pending", completedSteps: 0 },
    });

    await expect(store.prepare(applyPlan(), workspace)).resolves.toEqual(journal);
    expect((await readdir(root)).filter((name) => name.includes(".tmp"))).toEqual([]);
  });

  it("publishes nothing when originals changed after preflight or cannot all be read", async () => {
    const { store, workspace } = await setup();
    workspace.files.set("src/modify.ts", Buffer.from("owner changed\n"));

    await expect(store.prepare(applyPlan(), workspace)).rejects.toMatchObject({ code: "REQUEST_STATE" });
    expect(await store.list()).toEqual([]);

    workspace.files.set("src/modify.ts", oldModify);
    const originalRead = workspace.read.bind(workspace);
    workspace.read = async (path) => {
      if (path === "src/rename-me.ts") throw new Error("read failed");
      return originalRead(path);
    };
    await expect(store.prepare(applyPlan(), workspace)).rejects.toThrow("read failed");
    expect(await store.list()).toEqual([]);
  });

  it("rejects a different pending plan for the same ChangeSet", async () => {
    const { store, workspace } = await setup();
    await store.prepare(applyPlan(), workspace);
    const changedResult = Buffer.from("different result\n");
    const changed = applyPlan();
    changed.operations[0]!.result = {
      contentHash: hash(changedResult),
      size: changedResult.byteLength,
      bytes: new Uint8Array(changedResult),
    };

    await expect(store.prepare(changed, workspace)).rejects.toMatchObject({ code: "REQUEST_STATE" });
    expect(await store.list()).toHaveLength(1);
  });

  it("rolls every touched path back even when executor checkpoints lag writes", async () => {
    const { store, workspace } = await setup();
    const journal = await store.prepare(applyPlan(), workspace);
    await workspace.replace("src/modify.ts", newModify);
    await store.markExecutorCheckpoint(journal.integrationId, 1);
    await workspace.replace("src/added.ts", newAdd);
    await store.markExecutorCheckpoint(journal.integrationId, 2);
    await workspace.remove("src/deleted.ts");
    await workspace.remove("src/rename-me.ts");
    await workspace.replace("src/renamed.ts", newRename);

    await expect(store.recover(journal.integrationId, workspace)).resolves.toBe("recovered");
    expectOriginalWorkspace(workspace);
    expect(await store.list()).toEqual([]);
    await expect(store.recover(journal.integrationId, workspace)).resolves.toBe("not-found");
    expectOriginalWorkspace(workspace);
  });

  it("retries an interrupted rollback without trusting a stale recovery checkpoint", async () => {
    const { store, workspace } = await setup();
    const journal = await store.prepare(applyPlan(), workspace);
    await putFullyAppliedState(workspace);
    workspace.mutations = 0;
    workspace.failAfterMutation = 2;

    await expect(store.recover(journal.integrationId, workspace)).rejects.toThrow("simulated process interruption");
    expect(await store.list()).toEqual([journal.integrationId]);

    workspace.mutations = 0;
    workspace.failAfterMutation = undefined;
    await expect(store.recover(journal.integrationId, workspace)).resolves.toBe("recovered");
    expectOriginalWorkspace(workspace);
    await expect(store.recover(journal.integrationId, workspace)).resolves.toBe("not-found");
  });

  it("fails closed on a corrupt manifest, checkpoint, or original blob before mutating workspace", async () => {
    for (const corrupt of ["manifest", "checkpoint", "blob"] as const) {
      const { root, store, workspace } = await setup();
      const journal = await store.prepare(applyPlan(), workspace);
      if (corrupt === "manifest") await writeFile(join(root, journal.integrationId, "manifest.json"), "{}\n");
      if (corrupt === "checkpoint") await writeFile(join(root, journal.integrationId, "checkpoint.json"), "{}\n");
      if (corrupt === "blob") {
        const original = journal.originals.find((entry) => entry.present)!;
        await writeFile(join(root, journal.integrationId, "blobs", original.contentHash), "corrupt");
      }

      await expect(store.recover(journal.integrationId, workspace)).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
      expect(workspace.mutations).toBe(0);
    }
  });

  it("only discards a successful journal after every executor step is checkpointed", async () => {
    const { store, workspace } = await setup();
    const journal = await store.prepare(applyPlan(), workspace);
    await expect(store.markExecutorCheckpoint(journal.integrationId, 2)).rejects.toMatchObject({ code: "REQUEST_STATE" });
    for (let step = 1; step <= journal.executorStepCount; step += 1) {
      await store.markExecutorCheckpoint(journal.integrationId, step);
      await store.markExecutorCheckpoint(journal.integrationId, step);
    }
    await putFullyAppliedState(workspace);

    await expect(store.complete(journal.integrationId)).resolves.toBe("completed");
    expect(await store.list()).toEqual([]);
    await expect(store.recover(journal.integrationId, workspace)).resolves.toBe("not-found");
    expect(workspace.files.get("src/modify.ts")).toEqual(new Uint8Array(newModify));
    expect(workspace.files.has("src/deleted.ts")).toBe(false);
    expect(workspace.files.get("src/renamed.ts")).toEqual(new Uint8Array(newRename));
  });
});
