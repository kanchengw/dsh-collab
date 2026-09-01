import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ChangeSetApplyPlan } from "../../src/change-set-apply.js";
import { IntegrationJournalStore, type IntegrationJournalWorkspace } from "../../src/integration-journal.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

const oldModify = Buffer.from("old modify\n");
const newModify = Buffer.from("new modify\n");
const patch = Buffer.from("diff --git a/src/modify.ts b/src/modify.ts\n--- a/src/modify.ts\n+++ b/src/modify.ts\n@@ -1 +1 @@\n-old modify\n+new modify\n");

function applyPlan(overrides: Partial<ChangeSetApplyPlan> = {}): ChangeSetApplyPlan {
  return {
    roomId: "room-1",
    changeSetId: "a".repeat(64),
    baseWorkspaceVersionId: "version-1",
    patch: new Uint8Array(patch),
    operations: [{
      path: "src/modify.ts",
      operation: "modify",
      base: { path: "src/modify.ts", contentHash: hash(oldModify), size: oldModify.byteLength },
      result: { contentHash: hash(newModify), size: newModify.byteLength, bytes: new Uint8Array(newModify) },
    }],
    ...overrides,
  };
}

class MemoryWorkspace implements IntegrationJournalWorkspace {
  state: "original" | "applied" | "conflicted" = "original";
  applications: boolean[] = [];
  failReverse = false;

  async checkPatch(_roomId: string, _patch: Uint8Array, reverse = false): Promise<boolean> {
    if (this.state === "conflicted") return false;
    return reverse ? this.state === "applied" : this.state === "original";
  }

  async applyPatch(_roomId: string, _patch: Uint8Array, reverse = false): Promise<void> {
    this.applications.push(reverse);
    if (reverse && this.failReverse) throw new Error("reverse failed");
    this.state = reverse ? "original" : "applied";
  }
}

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-integration-journal-"));
  roots.push(root);
  return { root, store: new IntegrationJournalStore(root), workspace: new MemoryWorkspace() };
}

describe("Integration journal", () => {
  it("publishes one immutable patch journal before apply", async () => {
    const { root, store, workspace } = await setup();
    const journal = await store.prepare(applyPlan());

    expect(journal).toMatchObject({
      version: 1,
      roomId: "room-1",
      changeSetId: "a".repeat(64),
      patchHash: hash(patch),
      patchBytes: patch.byteLength,
      operations: [{ path: "src/modify.ts", operation: "modify" }],
    });
    expect(await store.list()).toEqual([journal.integrationId]);
    expect(workspace.applications).toEqual([]);
    expect((await readdir(join(root, journal.integrationId))).sort()).toEqual(["manifest.json", "patch.diff"]);
    expect(await readFile(join(root, journal.integrationId, "patch.diff"))).toEqual(patch);
    await expect(store.prepare(applyPlan())).resolves.toEqual(journal);
  });

  it("rejects an invalid patch or a different pending plan for the same ChangeSet", async () => {
    const { store } = await setup();
    await expect(store.prepare(applyPlan({ patch: new Uint8Array() }))).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    expect(await store.list()).toEqual([]);

    await store.prepare(applyPlan());
    const changedPatch = Buffer.from(patch.toString("utf8").replace("new modify", "different"));
    await expect(store.prepare(applyPlan({ patch: new Uint8Array(changedPatch) })))
      .rejects.toMatchObject({ code: "REQUEST_STATE" });
    expect(await store.list()).toHaveLength(1);
  });

  it("retires a prepared journal when Git proves the patch was never applied", async () => {
    const { store, workspace } = await setup();
    const journal = await store.prepare(applyPlan());

    await expect(store.recover(journal.integrationId, workspace)).resolves.toBe("recovered");

    expect(workspace.applications).toEqual([]);
    expect(await store.list()).toEqual([]);
  });

  it("uses the same Git patch in reverse when recovery finds the fully applied state", async () => {
    const { store, workspace } = await setup();
    const journal = await store.prepare(applyPlan());
    workspace.state = "applied";

    await expect(store.recover(journal.integrationId, workspace)).resolves.toBe("recovered");

    expect(workspace.state).toBe("original");
    expect(workspace.applications).toEqual([true]);
    expect(await store.list()).toEqual([]);
  });

  it("keeps the journal and Owner files when neither patch direction is safe", async () => {
    const { store, workspace } = await setup();
    const journal = await store.prepare(applyPlan());
    workspace.state = "conflicted";

    await expect(store.recover(journal.integrationId, workspace)).rejects.toMatchObject({ code: "REQUEST_CONFLICT" });

    expect(workspace.applications).toEqual([]);
    expect(await store.list()).toEqual([journal.integrationId]);
  });

  it("retains a fully applied journal when reverse Git apply fails", async () => {
    const { store, workspace } = await setup();
    const journal = await store.prepare(applyPlan());
    workspace.state = "applied";
    workspace.failReverse = true;

    await expect(store.recover(journal.integrationId, workspace)).rejects.toThrow("reverse failed");

    expect(workspace.state).toBe("applied");
    expect(await store.list()).toEqual([journal.integrationId]);
  });

  it("fails closed on a corrupt manifest or patch before invoking Git", async () => {
    for (const corrupt of ["manifest", "patch"] as const) {
      const { root, store, workspace } = await setup();
      const journal = await store.prepare(applyPlan());
      await writeFile(join(root, journal.integrationId, corrupt === "manifest" ? "manifest.json" : "patch.diff"), "corrupt\n");

      await expect(store.recover(journal.integrationId, workspace)).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
      expect(workspace.applications).toEqual([]);
    }
  });

  it("retires a successful journal without modifying the already applied workspace", async () => {
    const { store, workspace } = await setup();
    const journal = await store.prepare(applyPlan());
    workspace.state = "applied";

    await expect(store.complete(journal.integrationId)).resolves.toBe("completed");

    expect(await store.list()).toEqual([]);
    expect(workspace.applications).toEqual([]);
  });
});
