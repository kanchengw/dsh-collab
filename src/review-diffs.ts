import { createHash } from "node:crypto";
import type { ReviewPointDiff, WorkspaceSnapshotPackage } from "./collaboration-types.js";
import type { RepositoryCommandPort } from "./repository-inspector.js";
import { isSafeWorkspaceSnapshotPath, validateWorkspaceSnapshotPackage } from "./workspace-snapshot-store.js";

const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_TEXT_BYTES = 8 * 1024 * 1024;

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function text(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

async function baseText(commands: RepositoryCommandPort, headOid: string, path: string, allowMissing: boolean): Promise<string | null | undefined> {
  const spec = `${headOid}:${path}`;
  const exists = await commands.run(["cat-file", "-e", spec]);
  if (exists.exitCode !== 0) {
    if (allowMissing) return null;
    throw new Error(`Review Point base content does not exist: ${path}`);
  }
  const size = await commands.run(["cat-file", "-s", spec]);
  if (size.exitCode !== 0 || !/^\d+\s*$/.test(size.stdout)) throw new Error(`Unable to inspect Review Point base content: ${path}`);
  if (Number(size.stdout.trim()) > MAX_TEXT_FILE_BYTES) return undefined;
  const content = await commands.run(["cat-file", "blob", spec]);
  if (content.exitCode !== 0) throw new Error(`Unable to read Review Point base content: ${path}`);
  return content.stdout.includes("\0") ? undefined : content.stdout;
}

export async function captureReviewDiffs(input: {
  snapshot: WorkspaceSnapshotPackage;
  files: readonly { path: string; previousPath?: string; status: "added" | "modified" | "deleted" | "renamed" }[];
  commands: RepositoryCommandPort;
  readSnapshotFile(path: string): Promise<Uint8Array | undefined>;
}): Promise<ReviewPointDiff[]> {
  const snapshot = validateWorkspaceSnapshotPackage(input.snapshot, input.snapshot.snapshotId);
  if (!snapshot.headOid) throw new Error("Review Point requires a Git HEAD");
  const manifest = new Map(snapshot.files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const diffs: ReviewPointDiff[] = [];
  let totalTextBytes = 0;
  for (const file of input.files) {
    if (!file || !isSafeWorkspaceSnapshotPath(file.path) || seen.has(file.path)
      || (file.previousPath !== undefined && !isSafeWorkspaceSnapshotPath(file.previousPath))
      || !["added", "modified", "deleted", "renamed"].includes(file.status)) {
      throw new Error("Review Point diff path is invalid");
    }
    seen.add(file.path);
    const currentFile = manifest.get(file.path);
    const currentBytes = currentFile && currentFile.size <= MAX_TEXT_FILE_BYTES ? await input.readSnapshotFile(file.path) : undefined;
    if (currentFile && currentFile.size <= MAX_TEXT_FILE_BYTES && (!currentBytes || currentBytes.byteLength !== currentFile.size || sha256(currentBytes) !== currentFile.contentHash)) {
      throw new Error(`Review Point snapshot content is invalid: ${file.path}`);
    }
    const oldText = await baseText(input.commands, snapshot.headOid, file.previousPath ?? file.path, file.status === "added");
    const newText = currentBytes ? text(currentBytes) : currentFile ? undefined : null;
    if (oldText !== undefined && newText !== undefined) {
      totalTextBytes += (oldText === null ? 0 : Buffer.byteLength(oldText)) + (newText === null ? 0 : Buffer.byteLength(newText));
      if (totalTextBytes > MAX_TOTAL_TEXT_BYTES) throw new Error("Review Point aggregate text limit exceeded");
    }
    diffs.push(oldText === undefined || newText === undefined
      ? { path: file.path, kind: "binary" }
      : { path: file.path, kind: "text", oldText, newText });
  }
  return diffs;
}
