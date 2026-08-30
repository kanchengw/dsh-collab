import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDshRepositoryCommandPort, type DshRepositorySubprocess, type RepositoryCommandPort, type RepositoryCommandResult } from "./repository-inspector.js";
import type { RoomWorkspace } from "./room-workspace.js";
import { isSafeWorkspaceSnapshotPath } from "./workspace-snapshot-store.js";
import { validateWorkspaceVersionRecord, type WorkspaceVersionArtifactStore, type WorkspaceVersionFile } from "./workspace-versions.js";

const DEFAULT_MAX_FILES = 1_000;
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_TOTAL_TEXT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_PATCH_BYTES = 16 * 1024 * 1024;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

export type ChangeSetOperation = "add" | "modify" | "delete" | "rename";

export interface ChangeSetDraftFile {
  path: string;
  previousPath?: string;
  operation: ChangeSetOperation;
  baseContentHash?: string;
  resultContentHash?: string;
  baseSize?: number;
  resultSize?: number;
  additions: number;
  deletions: number;
}

export interface ChangeSetDraft {
  version: 1;
  draftId: string;
  roomId: string;
  authorId: string;
  baseWorkspaceVersionId: string;
  title: string;
  summary: string;
  files: ChangeSetDraftFile[];
  artifact: {
    kind: "changeset-draft.v1";
    artifactId: string;
    manifestHash: string;
    patchHash: string;
    patchBytes: number;
    resultBytes: number;
  };
  createdAt: number;
}

export interface ChangeSetDraftBundle {
  draft: ChangeSetDraft;
  patch: string;
}

interface ChangedContent {
  path: string;
  bytes: Uint8Array;
  contentHash: string;
  size: number;
}

interface DraftOperation {
  path: string;
  previousPath?: string;
  operation: ChangeSetOperation;
  base?: WorkspaceVersionFile;
  result?: ChangedContent;
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function requiredText(value: string, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must not be blank`);
  return value.trim();
}

function isText(content: Uint8Array): boolean {
  if (content.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

function isSafeChangeSetPath(path: string): boolean {
  return isSafeWorkspaceSnapshotPath(path) && !path.split("/").includes(".git");
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function failure(command: string, result: RepositoryCommandResult): Error {
  const detail = result.stderr.trim();
  return new Error(`git ${command} failed with exit code ${String(result.exitCode)}${detail === "" ? "" : `: ${detail}`}`);
}

async function requiredRun(commands: RepositoryCommandPort, argv: readonly string[]): Promise<RepositoryCommandResult> {
  const result = await commands.run(argv);
  if (result.exitCode !== 0) throw failure(argv.join(" "), result);
  return result;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function nulPaths(output: string): string[] {
  const paths = output.split("\0").filter((path) => path !== "");
  if (paths.some((path) => !isSafeChangeSetPath(path))) throw new Error("ChangeSet repository scope contains an unsafe path");
  return paths;
}

async function workspacePaths(input: {
  workspace: RoomWorkspace;
  basePaths: readonly string[];
  subprocess: DshRepositorySubprocess;
}): Promise<string[]> {
  const commands = createDshRepositoryCommandPort({ subprocess: input.subprocess, cwd: input.workspace.workspacePath });
  const root = (await requiredRun(commands, ["rev-parse", "--show-toplevel"])).stdout.trim();
  if (root === "" || !samePath(await realpath(root), await realpath(input.workspace.workspacePath))) {
    throw new Error("ChangeSet Room Workspace Git root does not match its files");
  }
  const [tracked, untracked] = await Promise.all([
    requiredRun(commands, ["ls-files", "-z", "--cached"]),
    requiredRun(commands, ["ls-files", "-z", "--others", "--exclude-standard"]),
  ]);
  const candidates = new Set([...input.basePaths, ...nulPaths(tracked.stdout), ...nulPaths(untracked.stdout)]);
  const paths: string[] = [];
  for (const path of [...candidates].sort(comparePath)) {
    if (!isSafeChangeSetPath(path)) throw new Error(`ChangeSet reserved .git path is unsupported: ${path}`);
    try {
      const info = await lstat(join(input.workspace.workspacePath, ...path.split("/")));
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`ChangeSet contains an unsupported filesystem entry: ${path}`);
      paths.push(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return paths;
}

interface Numstat {
  path: string;
  additions: number;
  deletions: number;
}

function parseNumstat(output: string): Map<string, Numstat> {
  const records = output.split("\0");
  const result = new Map<string, Numstat>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record === "") continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2) throw new Error("ChangeSet numstat is malformed");
    const additions = record.slice(0, firstTab);
    const deletions = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (!/^\d+$/.test(additions) || !/^\d+$/.test(deletions)) throw new Error("ChangeSet binary diff is unsupported");
    if (path === "") {
      index += 2;
      path = records[index] ?? "";
    }
    if (!isSafeChangeSetPath(path) || result.has(path)) throw new Error("ChangeSet numstat path is invalid");
    result.set(path, { path, additions: Number(additions), deletions: Number(deletions) });
  }
  return result;
}

async function writeContent(root: string, path: string, content: Uint8Array): Promise<void> {
  const destination = join(root, ...path.split("/"));
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  await writeFile(destination, content, { mode: 0o600 });
}

async function renderDiffGroup(input: {
  operations: readonly DraftOperation[];
  baseContents: ReadonlyMap<string, Uint8Array>;
  subprocess: DshRepositorySubprocess;
  maxPatchBytes: number;
  detectRenames: boolean;
}): Promise<{ patch: string; stats: Map<string, Numstat> }> {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-changeset-diff-"));
  try {
    const commands = createDshRepositoryCommandPort({
      subprocess: input.subprocess,
      cwd: root,
      maxStdoutBytes: input.maxPatchBytes + 64 * 1024,
    });
    await requiredRun(commands, ["init", "--quiet", "--object-format=sha1"]);
    await requiredRun(commands, ["config", "core.autocrlf", "false"]);
    await requiredRun(commands, ["config", "core.filemode", "false"]);
    await requiredRun(commands, ["config", "core.quotepath", "false"]);
    for (const operation of input.operations) {
      if (operation.base) await writeContent(root, operation.previousPath ?? operation.path, input.baseContents.get(operation.previousPath ?? operation.path)!);
    }
    await requiredRun(commands, ["add", "--all"]);
    await requiredRun(commands, [
      "-c", "user.name=DSH Collab", "-c", "user.email=dsh-collab@localhost",
      "commit", "--quiet", "--allow-empty", "--no-gpg-sign", "--no-verify", "-m", "changeset base",
    ]);
    for (const operation of input.operations) {
      if (operation.operation === "delete" || operation.operation === "rename") {
        await rm(join(root, ...(operation.previousPath ?? operation.path).split("/")), { force: true });
      }
      if (operation.result) await writeContent(root, operation.path, operation.result.bytes);
    }
    await requiredRun(commands, ["add", "--all"]);
    const renameArg = input.detectRenames ? "--find-renames=100%" : "--no-renames";
    const diffArgs = ["diff", "--cached", renameArg, "--diff-algorithm=myers", "--no-indent-heuristic", "--no-color", "--no-ext-diff", "--no-textconv", "--full-index", "--src-prefix=a/", "--dst-prefix=b/", "--unified=3", "HEAD", "--"];
    const patch = (await requiredRun(commands, diffArgs)).stdout;
    if (Buffer.byteLength(patch) > input.maxPatchBytes) throw new Error("ChangeSet unified diff exceeds the patch limit");
    const numstat = await requiredRun(commands, ["diff", "--cached", renameArg, "--numstat", "-z", "HEAD", "--"]);
    return { patch, stats: parseNumstat(numstat.stdout) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function renderDiff(input: {
  operations: readonly DraftOperation[];
  baseContents: ReadonlyMap<string, Uint8Array>;
  subprocess: DshRepositorySubprocess;
  maxPatchBytes: number;
}): Promise<{ patch: string; stats: Map<string, Numstat> }> {
  const groups = [
    { operations: input.operations.filter((operation) => operation.operation !== "rename"), detectRenames: false },
    { operations: input.operations.filter((operation) => operation.operation === "rename"), detectRenames: true },
  ].filter((group) => group.operations.length > 0);
  let patch = "";
  const stats = new Map<string, Numstat>();
  for (const group of groups) {
    const rendered = await renderDiffGroup({ ...input, ...group });
    patch += rendered.patch;
    for (const [path, stat] of rendered.stats) {
      if (stats.has(path)) throw new Error(`ChangeSet unified diff contains duplicate stats: ${path}`);
      stats.set(path, stat);
    }
  }
  if (Buffer.byteLength(patch) > input.maxPatchBytes) throw new Error("ChangeSet unified diff exceeds the patch limit");
  return { patch, stats };
}

function identity(input: Omit<ChangeSetDraft, "version" | "draftId" | "artifact" | "createdAt"> & {
  patchHash: string;
  patchBytes: number;
  resultBytes: number;
}): string {
  return hash(JSON.stringify(input));
}

function exactFields(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const allowed = new Set(fields);
  if (Object.keys(value).some((field) => !allowed.has(field))) throw new Error(`${label} contains an unsupported field`);
}

function validateDraft(value: unknown, expectedId?: string): ChangeSetDraft {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ChangeSet draft manifest is malformed");
  const draft = value as Record<string, unknown>;
  exactFields(draft, ["version", "draftId", "roomId", "authorId", "baseWorkspaceVersionId", "title", "summary", "files", "artifact", "createdAt"], "ChangeSet draft manifest");
  if (draft.version !== 1 || typeof draft.draftId !== "string" || !HASH_PATTERN.test(draft.draftId)
    || (expectedId !== undefined && draft.draftId !== expectedId) || typeof draft.roomId !== "string" || draft.roomId === ""
    || typeof draft.authorId !== "string" || draft.authorId === "" || typeof draft.baseWorkspaceVersionId !== "string" || draft.baseWorkspaceVersionId === ""
    || typeof draft.title !== "string" || draft.title === "" || typeof draft.summary !== "string" || draft.summary === ""
    || !Array.isArray(draft.files) || !Number.isSafeInteger(draft.createdAt) || (draft.createdAt as number) < 0
    || !draft.artifact || typeof draft.artifact !== "object" || Array.isArray(draft.artifact)) {
    throw new Error("ChangeSet draft manifest is malformed");
  }
  const files: ChangeSetDraftFile[] = draft.files.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("ChangeSet draft file manifest is malformed");
    const file = raw as Record<string, unknown>;
    exactFields(file, ["path", "previousPath", "operation", "baseContentHash", "resultContentHash", "baseSize", "resultSize", "additions", "deletions"], "ChangeSet draft file manifest");
    if (typeof file.path !== "string" || !isSafeChangeSetPath(file.path)
      || (file.previousPath !== undefined && (typeof file.previousPath !== "string" || !isSafeChangeSetPath(file.previousPath)))
      || !["add", "modify", "delete", "rename"].includes(file.operation as string)
      || (file.baseContentHash !== undefined && (typeof file.baseContentHash !== "string" || !HASH_PATTERN.test(file.baseContentHash)))
      || (file.resultContentHash !== undefined && (typeof file.resultContentHash !== "string" || !HASH_PATTERN.test(file.resultContentHash)))
      || (file.baseSize !== undefined && (!Number.isSafeInteger(file.baseSize) || (file.baseSize as number) < 0))
      || (file.resultSize !== undefined && (!Number.isSafeInteger(file.resultSize) || (file.resultSize as number) < 0))
      || !Number.isSafeInteger(file.additions) || (file.additions as number) < 0
      || !Number.isSafeInteger(file.deletions) || (file.deletions as number) < 0) {
      throw new Error("ChangeSet draft file manifest is malformed");
    }
    const parsed = file as unknown as ChangeSetDraftFile;
    if ((parsed.operation === "add" && (parsed.baseContentHash !== undefined || parsed.baseSize !== undefined || parsed.resultContentHash === undefined || parsed.resultSize === undefined || parsed.previousPath !== undefined))
      || (parsed.operation === "modify" && (parsed.baseContentHash === undefined || parsed.baseSize === undefined || parsed.resultContentHash === undefined || parsed.resultSize === undefined || parsed.previousPath !== undefined))
      || (parsed.operation === "delete" && (parsed.baseContentHash === undefined || parsed.baseSize === undefined || parsed.resultContentHash !== undefined || parsed.resultSize !== undefined || parsed.previousPath !== undefined))
      || (parsed.operation === "rename" && (parsed.baseContentHash === undefined || parsed.baseSize === undefined || parsed.resultContentHash === undefined || parsed.resultSize === undefined || parsed.previousPath === undefined))) {
      throw new Error("ChangeSet draft file operation is malformed");
    }
    return structuredClone(parsed);
  });
  if (files.length === 0 || files.some((file, index) => index > 0 && comparePath(files[index - 1]!.path, file.path) >= 0)) {
    throw new Error("ChangeSet draft file order is malformed");
  }
  const artifact = draft.artifact as Record<string, unknown>;
  exactFields(artifact, ["kind", "artifactId", "manifestHash", "patchHash", "patchBytes", "resultBytes"], "ChangeSet draft artifact");
  if (artifact.kind !== "changeset-draft.v1" || artifact.artifactId !== draft.draftId || artifact.manifestHash !== draft.draftId
    || typeof artifact.patchHash !== "string" || !HASH_PATTERN.test(artifact.patchHash)
    || !Number.isSafeInteger(artifact.patchBytes) || (artifact.patchBytes as number) < 0
    || !Number.isSafeInteger(artifact.resultBytes) || (artifact.resultBytes as number) < 0) {
    throw new Error("ChangeSet draft artifact is malformed");
  }
  const calculated = identity({
    roomId: draft.roomId,
    authorId: draft.authorId,
    baseWorkspaceVersionId: draft.baseWorkspaceVersionId,
    title: draft.title,
    summary: draft.summary,
    files,
    patchHash: artifact.patchHash,
    patchBytes: artifact.patchBytes,
    resultBytes: artifact.resultBytes,
  } as Parameters<typeof identity>[0]);
  if (calculated !== draft.draftId) throw new Error("ChangeSet draft manifest hash does not match");
  return structuredClone(value as ChangeSetDraft);
}

export class ChangeSetDraftStore {
  constructor(readonly root: string) {}

  async save(draftValue: ChangeSetDraft, patch: string, results: ReadonlyMap<string, Uint8Array>): Promise<ChangeSetDraftBundle> {
    const draft = validateDraft(draftValue, draftValue.draftId);
    if (Buffer.byteLength(patch) !== draft.artifact.patchBytes || hash(patch) !== draft.artifact.patchHash) throw new Error("ChangeSet draft patch does not match manifest");
    let resultBytes = 0;
    for (const file of draft.files) {
      if (!file.resultContentHash) continue;
      const content = results.get(file.path);
      if (!content || content.byteLength !== file.resultSize || hash(content) !== file.resultContentHash) throw new Error(`ChangeSet result content does not match manifest: ${file.path}`);
      resultBytes += content.byteLength;
    }
    if (!Number.isSafeInteger(resultBytes) || resultBytes !== draft.artifact.resultBytes) throw new Error("ChangeSet result size does not match manifest");
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const destination = join(this.root, draft.draftId);
    if (await exists(destination)) {
      const existing = await this.load(draft.draftId);
      if (!existing || existing.patch !== patch) throw new Error("ChangeSet draft identity conflicts with existing data");
      return existing;
    }
    const temporary = join(this.root, `.${draft.draftId}.${randomUUID()}.tmp`);
    try {
      await mkdir(join(temporary, "blobs"), { recursive: true, mode: 0o700 });
      const written = new Set<string>();
      for (const file of draft.files) {
        if (!file.resultContentHash || written.has(file.resultContentHash)) continue;
        await writeFile(join(temporary, "blobs", file.resultContentHash), results.get(file.path)!, { flag: "wx", mode: 0o600 });
        written.add(file.resultContentHash);
      }
      await writeFile(join(temporary, "patch.diff"), patch, { flag: "wx", mode: 0o600 });
      await writeFile(join(temporary, "manifest.json"), JSON.stringify({ version: 1, draft }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      const raced = await this.load(draft.draftId).catch(() => undefined);
      if (raced?.patch === patch) return raced;
      throw error;
    }
    return (await this.load(draft.draftId))!;
  }

  async load(draftId: string): Promise<ChangeSetDraftBundle | undefined> {
    if (!HASH_PATTERN.test(draftId)) throw new Error("ChangeSet draft id is invalid");
    const directory = join(this.root, draftId);
    let stored: unknown;
    try {
      stored = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("ChangeSet draft manifest is malformed", { cause: error });
    }
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) throw new Error("ChangeSet draft manifest is malformed");
    exactFields(stored as Record<string, unknown>, ["version", "draft"], "ChangeSet draft stored manifest");
    if ((stored as { version?: unknown }).version !== 1) throw new Error("ChangeSet draft manifest is malformed");
    const draft = validateDraft((stored as { draft?: unknown }).draft, draftId);
    const patch = await readFile(join(directory, "patch.diff"), "utf8");
    if (Buffer.byteLength(patch) !== draft.artifact.patchBytes || hash(patch) !== draft.artifact.patchHash) throw new Error("ChangeSet draft patch is corrupted");
    let resultBytes = 0;
    for (const file of draft.files) {
      if (!file.resultContentHash) continue;
      const content = await readFile(join(directory, "blobs", file.resultContentHash));
      if (content.byteLength !== file.resultSize || hash(content) !== file.resultContentHash) throw new Error(`ChangeSet draft result is corrupted: ${file.path}`);
      resultBytes += content.byteLength;
    }
    if (!Number.isSafeInteger(resultBytes) || resultBytes !== draft.artifact.resultBytes) throw new Error("ChangeSet draft result size is corrupted");
    return { draft, patch };
  }

  async readResult(draftId: string, path: string): Promise<Uint8Array> {
    const bundle = await this.load(draftId);
    const file = bundle?.draft.files.find((candidate) => candidate.path === path);
    if (!file?.resultContentHash) throw new Error("ChangeSet draft result does not exist");
    return await readFile(join(this.root, draftId, "blobs", file.resultContentHash));
  }
}

export class ChangeSetDraftService {
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;
  private readonly maxTotalTextBytes: number;
  private readonly maxPatchBytes: number;

  constructor(private readonly options: {
    artifacts: WorkspaceVersionArtifactStore;
    subprocess: DshRepositorySubprocess;
    now?: () => number;
    maxFiles?: number;
    maxFileBytes?: number;
    maxTotalTextBytes?: number;
    maxPatchBytes?: number;
  }) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    this.maxTotalTextBytes = options.maxTotalTextBytes ?? DEFAULT_MAX_TOTAL_TEXT_BYTES;
    this.maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_PATCH_BYTES;
    for (const value of [this.maxFiles, this.maxFileBytes, this.maxTotalTextBytes, this.maxPatchBytes]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("ChangeSet draft limit is invalid");
    }
  }

  async create(input: { workspace: RoomWorkspace; authorId: string; title: string; summary: string }): Promise<ChangeSetDraftBundle> {
    const record = validateWorkspaceVersionRecord(input.workspace.record);
    if (record.version.roomId !== input.workspace.roomId) throw new Error("Room Workspace base belongs to a different room");
    if (record.version.files.some((file) => !isSafeChangeSetPath(file.path))) throw new Error("ChangeSet reserved .git path is unsupported");
    const authorId = requiredText(input.authorId, "authorId");
    const title = requiredText(input.title, "title");
    const summary = requiredText(input.summary, "summary");
    const base = new Map(record.version.files.map((file) => [file.path, file]));
    const actualPaths = await workspacePaths({
      workspace: input.workspace,
      basePaths: record.version.files.map((file) => file.path),
      subprocess: this.options.subprocess,
    });
    const actual = new Set(actualPaths);
    const modified: DraftOperation[] = [];
    const added: ChangedContent[] = [];
    for (const path of actualPaths) {
      if (!isSafeChangeSetPath(path)) throw new Error(`ChangeSet reserved .git path is unsupported: ${path}`);
      const bytes = await readFile(join(input.workspace.workspacePath, ...path.split("/")));
      const contentHash = hash(bytes);
      const baseFile = base.get(path);
      if (baseFile && baseFile.size === bytes.byteLength && baseFile.contentHash === contentHash) continue;
      if (!isText(bytes)) throw new Error(`ChangeSet binary file is unsupported: ${path}`);
      const result = { path, bytes, contentHash, size: bytes.byteLength };
      if (baseFile) modified.push({ path, operation: "modify", base: baseFile, result });
      else added.push(result);
    }
    const deleted = record.version.files.filter((file) => !actual.has(file.path));
    for (const operation of modified) {
      if (operation.base!.mode === "binary") throw new Error(`ChangeSet binary file is unsupported: ${operation.path}`);
    }
    for (const file of deleted) {
      if (file.mode === "binary") throw new Error(`ChangeSet binary file is unsupported: ${file.path}`);
    }

    const addedByHash = new Map<string, ChangedContent[]>();
    for (const file of added) addedByHash.set(file.contentHash, [...(addedByHash.get(file.contentHash) ?? []), file]);
    const deletedByHash = new Map<string, WorkspaceVersionFile[]>();
    for (const file of deleted) deletedByHash.set(file.contentHash, [...(deletedByHash.get(file.contentHash) ?? []), file]);
    const operations = [...modified];
    const pairedAdded = new Set<string>();
    const pairedDeleted = new Set<string>();
    for (const [contentHash, oldFiles] of [...deletedByHash].sort(([left], [right]) => comparePath(left, right))) {
      const newFiles = addedByHash.get(contentHash);
      if (oldFiles.length !== 1 || newFiles?.length !== 1) continue;
      oldFiles.sort((left, right) => comparePath(left.path, right.path));
      newFiles.sort((left, right) => comparePath(left.path, right.path));
      for (let index = 0; index < Math.min(oldFiles.length, newFiles.length); index += 1) {
        const oldFile = oldFiles[index]!;
        const newFile = newFiles[index]!;
        operations.push({ path: newFile.path, previousPath: oldFile.path, operation: "rename", base: oldFile, result: newFile });
        pairedAdded.add(newFile.path);
        pairedDeleted.add(oldFile.path);
      }
    }
    for (const file of added) if (!pairedAdded.has(file.path)) operations.push({ path: file.path, operation: "add", result: file });
    for (const file of deleted) if (!pairedDeleted.has(file.path)) operations.push({ path: file.path, operation: "delete", base: file });
    operations.sort((left, right) => comparePath(left.path, right.path));
    if (operations.length === 0) throw new Error("ChangeSet draft has no changes");
    if (operations.length > this.maxFiles) throw new Error("ChangeSet draft exceeds the file count limit");

    let totalTextBytes = 0;
    let resultBytes = 0;
    const baseContents = new Map<string, Uint8Array>();
    const resultContents = new Map<string, Uint8Array>();
    for (const operation of operations) {
      if (operation.base) {
        if (operation.base.size > this.maxFileBytes) throw new Error(`ChangeSet file size limit exceeded: ${operation.previousPath ?? operation.path}`);
        const basePath = operation.previousPath ?? operation.path;
        const content = await this.options.artifacts.readFile(record.artifact.snapshotId, basePath);
        if (content.byteLength !== operation.base.size || hash(content) !== operation.base.contentHash) {
          throw new Error(`ChangeSet base content does not match Workspace Version: ${basePath}`);
        }
        if (!isText(content)) throw new Error(`ChangeSet binary file is unsupported: ${basePath}`);
        baseContents.set(basePath, content);
        totalTextBytes += content.byteLength;
      }
      if (operation.result) {
        if (operation.result.size > this.maxFileBytes) throw new Error(`ChangeSet file size limit exceeded: ${operation.path}`);
        resultContents.set(operation.path, operation.result.bytes);
        totalTextBytes += operation.result.size;
        resultBytes += operation.result.size;
      }
      if (!Number.isSafeInteger(totalTextBytes) || totalTextBytes > this.maxTotalTextBytes) throw new Error("ChangeSet aggregate text limit exceeded");
    }

    const rendered = await renderDiff({ operations, baseContents, subprocess: this.options.subprocess, maxPatchBytes: this.maxPatchBytes });
    const files: ChangeSetDraftFile[] = operations.map((operation) => {
      const stats = rendered.stats.get(operation.path);
      if (!stats) throw new Error(`ChangeSet unified diff is missing stats: ${operation.path}`);
      return {
        path: operation.path,
        ...(operation.previousPath ? { previousPath: operation.previousPath } : {}),
        operation: operation.operation,
        ...(operation.base ? { baseContentHash: operation.base.contentHash } : {}),
        ...(operation.result ? { resultContentHash: operation.result.contentHash } : {}),
        ...(operation.base ? { baseSize: operation.base.size } : {}),
        ...(operation.result ? { resultSize: operation.result.size } : {}),
        additions: stats.additions,
        deletions: stats.deletions,
      };
    });
    const patchHash = hash(rendered.patch);
    const patchBytes = Buffer.byteLength(rendered.patch);
    const manifestHash = identity({
      roomId: input.workspace.roomId,
      authorId,
      baseWorkspaceVersionId: record.version.workspaceVersionId,
      title,
      summary,
      files,
      patchHash,
      patchBytes,
      resultBytes,
    });
    const draft: ChangeSetDraft = {
      version: 1,
      draftId: manifestHash,
      roomId: input.workspace.roomId,
      authorId,
      baseWorkspaceVersionId: record.version.workspaceVersionId,
      title,
      summary,
      files,
      artifact: {
        kind: "changeset-draft.v1",
        artifactId: manifestHash,
        manifestHash,
        patchHash,
        patchBytes,
        resultBytes,
      },
      createdAt: this.options.now?.() ?? Date.now(),
    };
    if (!Number.isSafeInteger(draft.createdAt) || draft.createdAt < 0) throw new Error("ChangeSet draft timestamp is invalid");
    return await new ChangeSetDraftStore(input.workspace.draftsPath).save(draft, rendered.patch, resultContents);
  }
}
