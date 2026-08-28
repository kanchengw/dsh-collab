import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { captureReviewDiffs } from "../../src/review-diffs.js";
import type { RepositoryCommandPort } from "../../src/repository-inspector.js";

const hash = (value: Uint8Array | string): string => createHash("sha256").update(value).digest("hex");

function snapshot(contents: Record<string, string>): { value: WorkspaceSnapshotPackage; bytes: Map<string, Uint8Array> } {
  const bytes = new Map(Object.entries(contents).map(([path, value]) => [path, Buffer.from(value)]));
  const files = [...bytes].map(([path, value]) => ({ path, contentHash: hash(value), size: value.byteLength, source: "tracked" as const }));
  return {
    value: {
      snapshotId: "snapshot-1", roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 0,
      headOid: "a".repeat(40), manifestHash: hash(JSON.stringify(files)), files, createdAt: 10,
    },
    bytes,
  };
}

describe("Review Point immutable diffs", () => {
  it("anchors old text to HEAD and new text to the captured snapshot, including rename/add/delete", async () => {
    const captured = snapshot({ "src/new.ts": "new name\nchanged\n", "src/added.ts": "added\n" });
    const base = new Map([
      ["src/old.ts", "old name\n"],
      ["src/deleted.ts", "deleted\n"],
    ]);
    const commands: RepositoryCommandPort = {
      async run(argv) {
        const spec = argv.at(-1) ?? "";
        const path = spec.slice(spec.indexOf(":") + 1);
        if (argv[1] === "-e") return { exitCode: base.has(path) ? 0 : 1, stdout: "", stderr: "" };
        if (argv[1] === "-s") return { exitCode: 0, stdout: String(Buffer.byteLength(base.get(path)!)), stderr: "" };
        return { exitCode: 0, stdout: base.get(path)!, stderr: "" };
      },
    };

    await expect(captureReviewDiffs({
      snapshot: captured.value,
      files: [
        { path: "src/new.ts", previousPath: "src/old.ts", status: "renamed" },
        { path: "src/added.ts", status: "added" },
        { path: "src/deleted.ts", status: "deleted" },
      ],
      commands,
      readSnapshotFile: async (path) => captured.bytes.get(path),
    })).resolves.toEqual([
      { path: "src/new.ts", kind: "text", oldText: "old name\n", newText: "new name\nchanged\n" },
      { path: "src/added.ts", kind: "text", oldText: null, newText: "added\n" },
      { path: "src/deleted.ts", kind: "text", oldText: "deleted\n", newText: null },
    ]);
  });

  it("marks binary or oversized content unavailable instead of persisting it in Host state", async () => {
    const binary = Buffer.from([0, 1, 2]);
    const files = [{ path: "image.bin", contentHash: hash(binary), size: binary.byteLength, source: "tracked" as const }];
    const captured: WorkspaceSnapshotPackage = {
      snapshotId: "snapshot-1", roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 0,
      headOid: "a".repeat(40), manifestHash: hash(JSON.stringify(files)), files, createdAt: 10,
    };
    const commands: RepositoryCommandPort = { run: async (argv) => ({ exitCode: argv[1] === "-e" ? 1 : 0, stdout: "", stderr: "" }) };

    await expect(captureReviewDiffs({
      snapshot: captured,
      files: [{ path: "image.bin", status: "added" }],
      commands,
      readSnapshotFile: async () => binary,
    })).resolves.toEqual([{ path: "image.bin", kind: "binary" }]);
    await expect(captureReviewDiffs({
      snapshot: captured,
      files: [{ path: "image.bin", status: "modified" }],
      commands,
      readSnapshotFile: async () => binary,
    })).rejects.toThrow("base content does not exist");
  });

  it("stops capture when the aggregate text budget is exceeded", async () => {
    const content = Buffer.alloc(2 * 1024 * 1024, 97);
    const contents = Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`src/file-${String(index)}.ts`, content.toString()]));
    const captured = snapshot(contents);
    let reads = 0;

    await expect(captureReviewDiffs({
      snapshot: captured.value,
      files: Object.keys(contents).map((path) => ({ path, status: "added" as const })),
      commands: { run: async () => ({ exitCode: 1, stdout: "", stderr: "" }) },
      readSnapshotFile: async (path) => { reads += 1; return captured.bytes.get(path); },
    })).rejects.toThrow("aggregate text limit");
    expect(reads).toBe(5);
  });
});
