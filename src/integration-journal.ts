import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeSetApplyPlan, ChangeSetApplyPlanOperation } from "./change-set-apply.js";
import { CollabError } from "./errors.js";
import { isSafeWorkspaceSnapshotPath } from "./workspace-snapshot-store.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface IntegrationJournalWorkspace {
  checkPatch(roomId: string, patch: Uint8Array, reverse?: boolean): Promise<boolean>;
  applyPatch(roomId: string, patch: Uint8Array, reverse?: boolean): Promise<void>;
}

export interface IntegrationJournalOperation {
  path: string;
  previousPath?: string;
  operation: ChangeSetApplyPlanOperation["operation"];
  base?: { path: string; contentHash: string; size: number };
  result?: { contentHash: string; size: number };
}

export interface IntegrationJournal {
  version: 1;
  integrationId: string;
  roomId: string;
  changeSetId: string;
  baseWorkspaceVersionId: string;
  patchHash: string;
  patchBytes: number;
  operations: IntegrationJournalOperation[];
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function invalidJournal(message: string): CollabError {
  return new CollabError("SNAPSHOT_INVALID", message);
}

function isSafePath(path: string): boolean {
  return isSafeWorkspaceSnapshotPath(path) && !path.split("/").includes(".git");
}

function isSize(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validateOperation(operation: ChangeSetApplyPlanOperation | IntegrationJournalOperation): IntegrationJournalOperation {
  if (!operation || !isSafePath(operation.path) || !["add", "modify", "delete", "rename"].includes(operation.operation)
    || (operation.previousPath !== undefined && !isSafePath(operation.previousPath))) {
    throw invalidJournal("Integration plan contains an unsafe or invalid operation");
  }
  const baseValid = operation.base !== undefined && isSafePath(operation.base.path)
    && HASH_PATTERN.test(operation.base.contentHash) && isSize(operation.base.size);
  const resultValid = operation.result !== undefined && HASH_PATTERN.test(operation.result.contentHash) && isSize(operation.result.size)
    && (!("bytes" in operation.result) || (operation.result.bytes instanceof Uint8Array
      && operation.result.bytes.byteLength === operation.result.size && hash(operation.result.bytes) === operation.result.contentHash));
  if ((operation.base !== undefined && !baseValid) || (operation.result !== undefined && !resultValid)) {
    throw invalidJournal("Integration plan hashes or sizes are invalid");
  }
  if ((operation.operation === "add" && (operation.base !== undefined || !resultValid || operation.previousPath !== undefined))
    || (operation.operation === "modify" && (!baseValid || !resultValid || operation.previousPath !== undefined || operation.base!.path !== operation.path))
    || (operation.operation === "delete" && (!baseValid || operation.result !== undefined || operation.previousPath !== undefined || operation.base!.path !== operation.path))
    || (operation.operation === "rename" && (!baseValid || !resultValid || operation.previousPath === undefined
      || operation.previousPath === operation.path || operation.base!.path !== operation.previousPath))) {
    throw invalidJournal("Integration plan operation shape is invalid");
  }
  return {
    path: operation.path,
    ...(operation.previousPath ? { previousPath: operation.previousPath } : {}),
    operation: operation.operation,
    ...(operation.base ? { base: { ...operation.base } } : {}),
    ...(operation.result ? { result: { contentHash: operation.result.contentHash, size: operation.result.size } } : {}),
  };
}

function validateOperations(operations: readonly (ChangeSetApplyPlanOperation | IntegrationJournalOperation)[]): IntegrationJournalOperation[] {
  if (!Array.isArray(operations) || operations.length === 0) throw invalidJournal("Integration plan operations are invalid");
  const validated = operations.map(validateOperation);
  const targets = new Set<string>();
  const bases = new Set<string>();
  for (const operation of validated) {
    if (targets.has(operation.path)) throw invalidJournal("Integration plan contains duplicate targets");
    targets.add(operation.path);
    if (operation.base) {
      if (bases.has(operation.base.path)) throw invalidJournal("Integration plan contains duplicate bases");
      bases.add(operation.base.path);
    }
  }
  return validated;
}

function journalIdentity(input: Omit<IntegrationJournal, "version" | "integrationId">): string {
  return hash(JSON.stringify(input));
}

function validatePlan(plan: ChangeSetApplyPlan): { journal: IntegrationJournal; patch: Uint8Array } {
  if (!plan || typeof plan.roomId !== "string" || plan.roomId === "" || !HASH_PATTERN.test(plan.changeSetId)
    || typeof plan.baseWorkspaceVersionId !== "string" || plan.baseWorkspaceVersionId === ""
    || !(plan.patch instanceof Uint8Array) || plan.patch.byteLength < 1) {
    throw invalidJournal("Integration plan envelope is invalid");
  }
  const patch = structuredClone(plan.patch);
  const input = {
    roomId: plan.roomId,
    changeSetId: plan.changeSetId,
    baseWorkspaceVersionId: plan.baseWorkspaceVersionId,
    patchHash: hash(patch),
    patchBytes: patch.byteLength,
    operations: validateOperations(plan.operations),
  };
  return { journal: { version: 1, integrationId: journalIdentity(input), ...input }, patch };
}

function validateJournal(value: IntegrationJournal, expectedId: string): IntegrationJournal {
  if (!value || value.version !== 1 || value.integrationId !== expectedId || !HASH_PATTERN.test(value.integrationId)
    || typeof value.roomId !== "string" || value.roomId === "" || !HASH_PATTERN.test(value.changeSetId)
    || typeof value.baseWorkspaceVersionId !== "string" || value.baseWorkspaceVersionId === ""
    || !HASH_PATTERN.test(value.patchHash) || !Number.isSafeInteger(value.patchBytes) || value.patchBytes < 1) {
    throw invalidJournal("Integration journal manifest is invalid");
  }
  const input = {
    roomId: value.roomId,
    changeSetId: value.changeSetId,
    baseWorkspaceVersionId: value.baseWorkspaceVersionId,
    patchHash: value.patchHash,
    patchBytes: value.patchBytes,
    operations: validateOperations(value.operations),
  };
  if (journalIdentity(input) !== expectedId) throw invalidJournal("Integration journal identity is invalid");
  return structuredClone({ version: 1, integrationId: expectedId, ...input });
}

function parseJson(text: string): IntegrationJournal {
  try {
    return JSON.parse(text) as IntegrationJournal;
  } catch {
    throw invalidJournal("Integration journal manifest is malformed");
  }
}

export class IntegrationJournalStore {
  constructor(readonly root: string) {}

  async prepare(plan: ChangeSetApplyPlan): Promise<IntegrationJournal> {
    const { journal, patch } = validatePlan(plan);
    for (const pendingId of await this.list()) {
      const pending = await this.loadRequired(pendingId);
      if (pending.journal.roomId === plan.roomId && pending.journal.changeSetId === plan.changeSetId) {
        if (pending.journal.integrationId === journal.integrationId) return pending.journal;
        throw new CollabError("REQUEST_STATE", "A different integration journal already exists for this ChangeSet");
      }
    }
    await this.publish(journal, patch);
    return structuredClone(journal);
  }

  async list(): Promise<string[]> {
    try {
      return (await readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && HASH_PATTERN.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async load(integrationId: string): Promise<IntegrationJournal | undefined> {
    if (!HASH_PATTERN.test(integrationId)) throw invalidJournal("Integration ID is invalid");
    try {
      await access(this.directory(integrationId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return (await this.loadRequired(integrationId)).journal;
  }

  async recover(integrationId: string, workspace: IntegrationJournalWorkspace): Promise<"recovered" | "not-found"> {
    const loaded = await this.loadOptional(integrationId);
    if (!loaded) return "not-found";
    const forward = await workspace.checkPatch(loaded.journal.roomId, loaded.patch);
    const reverse = await workspace.checkPatch(loaded.journal.roomId, loaded.patch, true);
    if (forward === reverse) {
      throw new CollabError("REQUEST_CONFLICT", "Owner workspace no longer matches either side of the interrupted ChangeSet");
    }
    if (reverse) {
      await workspace.applyPatch(loaded.journal.roomId, loaded.patch, true);
      if (!await workspace.checkPatch(loaded.journal.roomId, loaded.patch)) {
        throw new CollabError("REQUEST_CONFLICT", "Interrupted ChangeSet rollback did not restore an applicable base");
      }
    }
    await this.retire(integrationId);
    return "recovered";
  }

  async complete(integrationId: string): Promise<"completed" | "not-found"> {
    const loaded = await this.loadOptional(integrationId);
    if (!loaded) return "not-found";
    await this.retire(integrationId);
    return "completed";
  }

  private directory(integrationId: string): string {
    return join(this.root, integrationId);
  }

  private async publish(journal: IntegrationJournal, patch: Uint8Array): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.${journal.integrationId}.${randomUUID()}.tmp`);
    try {
      await mkdir(temporary, { mode: 0o700 });
      await writeFile(join(temporary, "patch.diff"), patch, { flag: "wx", mode: 0o600 });
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(journal, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, this.directory(journal.integrationId));
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  private async loadOptional(integrationId: string): Promise<{ journal: IntegrationJournal; patch: Uint8Array } | undefined> {
    const journal = await this.load(integrationId);
    return journal ? await this.loadRequired(integrationId) : undefined;
  }

  private async loadRequired(integrationId: string): Promise<{ journal: IntegrationJournal; patch: Uint8Array }> {
    try {
      const journal = validateJournal(parseJson(await readFile(join(this.directory(integrationId), "manifest.json"), "utf8")), integrationId);
      const patch = await readFile(join(this.directory(integrationId), "patch.diff"));
      if (patch.byteLength !== journal.patchBytes || hash(patch) !== journal.patchHash) {
        throw invalidJournal("Integration journal patch is corrupt");
      }
      return { journal, patch };
    } catch (error) {
      if (error instanceof CollabError && error.code === "SNAPSHOT_INVALID") throw error;
      throw invalidJournal("Integration journal is incomplete or unreadable");
    }
  }

  private async retire(integrationId: string): Promise<void> {
    const retired = join(this.root, `.retired.${integrationId}.${randomUUID()}`);
    await rename(this.directory(integrationId), retired);
    await rm(retired, { recursive: true, force: true });
  }
}
