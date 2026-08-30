import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChangeSetApplyPlan, ChangeSetApplyPlanOperation } from "./change-set-apply.js";
import { CollabError } from "./errors.js";
import { isSafeWorkspaceSnapshotPath } from "./workspace-snapshot-store.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;

export interface IntegrationJournalWorkspace {
  read(path: string): Promise<Uint8Array | undefined>;
  replace(path: string, bytes: Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
}

export interface IntegrationJournalOperation {
  path: string;
  previousPath?: string;
  operation: ChangeSetApplyPlanOperation["operation"];
  base?: { path: string; contentHash: string; size: number };
  result?: { contentHash: string; size: number };
}

export type IntegrationJournalOriginal =
  | { path: string; present: false }
  | { path: string; present: true; contentHash: string; size: number };

export interface IntegrationJournal {
  version: 1;
  integrationId: string;
  roomId: string;
  changeSetId: string;
  baseWorkspaceVersionId: string;
  executorStepCount: number;
  operations: IntegrationJournalOperation[];
  originals: IntegrationJournalOriginal[];
}

interface IntegrationJournalCheckpoint {
  version: 1;
  integrationId: string;
  executorCompletedSteps: number;
  recovery: {
    phase: "pending" | "rolling-back";
    completedSteps: number;
  };
}

type OriginalExpectation =
  | { present: false }
  | { present: true; contentHash: string; size: number };

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

function sameExpectation(left: OriginalExpectation, right: OriginalExpectation): boolean {
  return left.present === right.present
    && (!left.present || (right.present && left.contentHash === right.contentHash && left.size === right.size));
}

function addExpectation(expectations: Map<string, OriginalExpectation>, path: string, expectation: OriginalExpectation): void {
  const existing = expectations.get(path);
  if (existing && !sameExpectation(existing, expectation)) throw invalidJournal("Integration plan has conflicting original path states");
  expectations.set(path, expectation);
}

function validatePlanOperation(operation: ChangeSetApplyPlanOperation): IntegrationJournalOperation {
  if (!operation || !isSafePath(operation.path) || !["add", "modify", "delete", "rename"].includes(operation.operation)
    || (operation.previousPath !== undefined && !isSafePath(operation.previousPath))) {
    throw invalidJournal("Integration plan contains an unsafe or invalid operation");
  }
  const baseValid = operation.base !== undefined && isSafePath(operation.base.path)
    && HASH_PATTERN.test(operation.base.contentHash) && isSize(operation.base.size);
  const resultValid = operation.result !== undefined && HASH_PATTERN.test(operation.result.contentHash)
    && isSize(operation.result.size) && operation.result.bytes instanceof Uint8Array
    && operation.result.bytes.byteLength === operation.result.size && hash(operation.result.bytes) === operation.result.contentHash;
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

function validatePlan(plan: ChangeSetApplyPlan): {
  operations: IntegrationJournalOperation[];
  expectations: Map<string, OriginalExpectation>;
  executorStepCount: number;
} {
  if (!plan || typeof plan.roomId !== "string" || plan.roomId === "" || !HASH_PATTERN.test(plan.changeSetId)
    || typeof plan.baseWorkspaceVersionId !== "string" || plan.baseWorkspaceVersionId === ""
    || !Array.isArray(plan.operations) || plan.operations.length === 0) {
    throw invalidJournal("Integration plan envelope is invalid");
  }
  const operations = plan.operations.map(validatePlanOperation);
  const targets = new Set<string>();
  const bases = new Set<string>();
  const expectations = new Map<string, OriginalExpectation>();
  let executorStepCount = 0;
  for (const operation of operations) {
    if (targets.has(operation.path)) throw invalidJournal("Integration plan contains duplicate targets");
    targets.add(operation.path);
    executorStepCount += operation.operation === "rename" ? 2 : 1;
    if (operation.base) {
      if (bases.has(operation.base.path)) throw invalidJournal("Integration plan contains duplicate bases");
      bases.add(operation.base.path);
      addExpectation(expectations, operation.base.path, {
        present: true,
        contentHash: operation.base.contentHash,
        size: operation.base.size,
      });
    }
    if (operation.operation === "add" || operation.operation === "rename") {
      addExpectation(expectations, operation.path, { present: false });
    }
  }
  return { operations, expectations, executorStepCount };
}

function journalIdentity(input: Pick<IntegrationJournal, "roomId" | "changeSetId" | "baseWorkspaceVersionId" | "operations">): string {
  return hash(JSON.stringify({
    roomId: input.roomId,
    changeSetId: input.changeSetId,
    baseWorkspaceVersionId: input.baseWorkspaceVersionId,
    operations: input.operations,
  }));
}

function validateJournal(value: IntegrationJournal, expectedId: string): IntegrationJournal {
  if (!value || value.version !== 1 || value.integrationId !== expectedId || !HASH_PATTERN.test(value.integrationId)
    || typeof value.roomId !== "string" || value.roomId === "" || !HASH_PATTERN.test(value.changeSetId)
    || typeof value.baseWorkspaceVersionId !== "string" || value.baseWorkspaceVersionId === ""
    || !Array.isArray(value.operations) || !Array.isArray(value.originals)) {
    throw invalidJournal("Integration journal manifest is invalid");
  }
  let validated: ReturnType<typeof validatePlan>;
  try {
    validated = validateStoredOperations(value.operations);
  } catch {
    throw invalidJournal("Integration journal operations are invalid");
  }
  if (value.executorStepCount !== validated.executorStepCount
    || journalIdentity(value) !== value.integrationId
    || value.originals.length !== validated.expectations.size) {
    throw invalidJournal("Integration journal identity is invalid");
  }
  const originals = [...value.originals].sort((left, right) => left.path.localeCompare(right.path));
  if (originals.some((original, index) => original !== value.originals[index])) {
    throw invalidJournal("Integration journal originals are not canonical");
  }
  for (const original of originals) {
    const expected = original && typeof original.path === "string" ? validated.expectations.get(original.path) : undefined;
    if (!expected || original.present !== expected.present
      || (original.present && (!HASH_PATTERN.test(original.contentHash) || !isSize(original.size)
        || !expected.present || original.contentHash !== expected.contentHash || original.size !== expected.size))) {
      throw invalidJournal("Integration journal original state is invalid");
    }
  }
  return structuredClone(value);
}

function validateStoredOperations(operations: IntegrationJournalOperation[]): ReturnType<typeof validatePlan> {
  const expectations = new Map<string, OriginalExpectation>();
  const targets = new Set<string>();
  const bases = new Set<string>();
  let executorStepCount = 0;
  for (const operation of operations) {
    if (!operation || !isSafePath(operation.path) || !["add", "modify", "delete", "rename"].includes(operation.operation)
      || (operation.previousPath !== undefined && !isSafePath(operation.previousPath))) {
      throw invalidJournal("Integration journal operation is invalid");
    }
    const baseValid = operation.base !== undefined && isSafePath(operation.base.path)
      && HASH_PATTERN.test(operation.base.contentHash) && isSize(operation.base.size);
    const resultValid = operation.result !== undefined && HASH_PATTERN.test(operation.result.contentHash) && isSize(operation.result.size);
    if ((operation.operation === "add" && (operation.base !== undefined || !resultValid || operation.previousPath !== undefined))
      || (operation.operation === "modify" && (!baseValid || !resultValid || operation.previousPath !== undefined || operation.base!.path !== operation.path))
      || (operation.operation === "delete" && (!baseValid || operation.result !== undefined || operation.previousPath !== undefined || operation.base!.path !== operation.path))
      || (operation.operation === "rename" && (!baseValid || !resultValid || operation.previousPath === undefined
        || operation.previousPath === operation.path || operation.base!.path !== operation.previousPath))) {
      throw invalidJournal("Integration journal operation shape is invalid");
    }
    if (targets.has(operation.path)) throw invalidJournal("Integration journal contains duplicate targets");
    targets.add(operation.path);
    executorStepCount += operation.operation === "rename" ? 2 : 1;
    if (operation.base) {
      if (bases.has(operation.base.path)) throw invalidJournal("Integration journal contains duplicate bases");
      bases.add(operation.base.path);
      addExpectation(expectations, operation.base.path, { present: true, contentHash: operation.base.contentHash, size: operation.base.size });
    }
    if (operation.operation === "add" || operation.operation === "rename") addExpectation(expectations, operation.path, { present: false });
  }
  return { operations: structuredClone(operations), expectations, executorStepCount };
}

function validateCheckpoint(value: IntegrationJournalCheckpoint, journal: IntegrationJournal): IntegrationJournalCheckpoint {
  const recoveryStepCount = journal.originals.length;
  if (!value || value.version !== 1 || value.integrationId !== journal.integrationId
    || !Number.isSafeInteger(value.executorCompletedSteps) || value.executorCompletedSteps < 0
    || value.executorCompletedSteps > journal.executorStepCount || !value.recovery
    || !["pending", "rolling-back"].includes(value.recovery.phase)
    || !Number.isSafeInteger(value.recovery.completedSteps) || value.recovery.completedSteps < 0
    || value.recovery.completedSteps > recoveryStepCount
    || (value.recovery.phase === "pending" && value.recovery.completedSteps !== 0)) {
    throw invalidJournal("Integration journal checkpoint is invalid");
  }
  return structuredClone(value);
}

function parseJson<T>(text: string, kind: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw invalidJournal(`Integration journal ${kind} is malformed`);
  }
}

export class IntegrationJournalStore {
  constructor(readonly root: string) {}

  async prepare(plan: ChangeSetApplyPlan, workspace: IntegrationJournalWorkspace): Promise<IntegrationJournal> {
    const validated = validatePlan(plan);
    const identityInput = {
      roomId: plan.roomId,
      changeSetId: plan.changeSetId,
      baseWorkspaceVersionId: plan.baseWorkspaceVersionId,
      operations: validated.operations,
    };
    const integrationId = journalIdentity(identityInput);
    for (const pendingId of await this.list()) {
      const pending = await this.loadRequired(pendingId, true);
      if (pending.roomId === plan.roomId && pending.changeSetId === plan.changeSetId) {
        if (pending.integrationId === integrationId) return pending;
        throw new CollabError("REQUEST_STATE", "A different integration journal already exists for this ChangeSet");
      }
    }

    const originals: IntegrationJournalOriginal[] = [];
    const blobs = new Map<string, Uint8Array>();
    for (const [path, expected] of [...validated.expectations].sort(([left], [right]) => left.localeCompare(right))) {
      const bytes = await workspace.read(path);
      if (!expected.present) {
        if (bytes !== undefined) throw new CollabError("REQUEST_STATE", `Owner workspace changed before integration journal prepare: ${path}`);
        originals.push({ path, present: false });
        continue;
      }
      if (bytes === undefined || bytes.byteLength !== expected.size || hash(bytes) !== expected.contentHash) {
        throw new CollabError("REQUEST_STATE", `Owner workspace changed before integration journal prepare: ${path}`);
      }
      originals.push({ path, present: true, contentHash: expected.contentHash, size: expected.size });
      blobs.set(expected.contentHash, structuredClone(bytes));
    }
    const journal: IntegrationJournal = {
      version: 1,
      integrationId,
      ...identityInput,
      executorStepCount: validated.executorStepCount,
      originals,
    };
    const checkpoint: IntegrationJournalCheckpoint = {
      version: 1,
      integrationId,
      executorCompletedSteps: 0,
      recovery: { phase: "pending", completedSteps: 0 },
    };
    await this.publish(journal, checkpoint, blobs);
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
    return this.loadRequired(integrationId, true);
  }

  async markExecutorCheckpoint(integrationId: string, completedSteps: number): Promise<void> {
    const journal = await this.loadRequired(integrationId, true);
    const checkpoint = await this.readCheckpoint(journal);
    if (checkpoint.recovery.phase !== "pending") throw new CollabError("REQUEST_STATE", "Integration journal is already recovering");
    if (completedSteps === checkpoint.executorCompletedSteps) return;
    if (completedSteps !== checkpoint.executorCompletedSteps + 1 || completedSteps > journal.executorStepCount) {
      throw new CollabError("REQUEST_STATE", "Integration executor checkpoints must advance one step at a time");
    }
    await this.writeCheckpoint(journal.integrationId, { ...checkpoint, executorCompletedSteps: completedSteps });
  }

  async recover(integrationId: string, workspace: IntegrationJournalWorkspace): Promise<"recovered" | "not-found"> {
    const journal = await this.load(integrationId);
    if (!journal) return "not-found";
    const blobs = await this.readOriginalBlobs(journal);
    let checkpoint = await this.readCheckpoint(journal);
    if (checkpoint.recovery.phase === "pending") {
      checkpoint = { ...checkpoint, recovery: { phase: "rolling-back", completedSteps: 0 } };
      await this.writeCheckpoint(integrationId, checkpoint);
    }
    const absent = journal.originals.filter((original) => !original.present);
    const present = journal.originals.filter((original): original is Extract<IntegrationJournalOriginal, { present: true }> => original.present);
    const actions: Array<() => Promise<void>> = [
      ...absent.map((original) => () => workspace.remove(original.path)),
      ...present.map((original) => () => workspace.replace(original.path, blobs.get(original.contentHash)!)),
    ];
    for (let index = checkpoint.recovery.completedSteps; index < actions.length; index += 1) {
      await actions[index]!();
      checkpoint = { ...checkpoint, recovery: { phase: "rolling-back", completedSteps: index + 1 } };
      await this.writeCheckpoint(integrationId, checkpoint);
    }
    await this.retire(integrationId);
    return "recovered";
  }

  async complete(integrationId: string): Promise<"completed" | "not-found"> {
    const journal = await this.load(integrationId);
    if (!journal) return "not-found";
    const checkpoint = await this.readCheckpoint(journal);
    if (checkpoint.recovery.phase !== "pending" || checkpoint.executorCompletedSteps !== journal.executorStepCount) {
      throw new CollabError("REQUEST_STATE", "Integration journal cannot complete before every executor step is checkpointed");
    }
    await this.retire(integrationId);
    return "completed";
  }

  private directory(integrationId: string): string {
    return join(this.root, integrationId);
  }

  private async publish(journal: IntegrationJournal, checkpoint: IntegrationJournalCheckpoint, blobs: ReadonlyMap<string, Uint8Array>): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temporary = join(this.root, `.${journal.integrationId}.${randomUUID()}.tmp`);
    try {
      await mkdir(join(temporary, "blobs"), { recursive: true, mode: 0o700 });
      for (const [contentHash, bytes] of blobs) {
        await writeFile(join(temporary, "blobs", contentHash), bytes, { flag: "wx", mode: 0o600 });
      }
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(journal, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await writeFile(join(temporary, "checkpoint.json"), JSON.stringify(checkpoint, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, this.directory(journal.integrationId));
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  private async loadRequired(integrationId: string, validateBlobs: boolean): Promise<IntegrationJournal> {
    let journal: IntegrationJournal;
    try {
      journal = validateJournal(
        parseJson<IntegrationJournal>(await readFile(join(this.directory(integrationId), "manifest.json"), "utf8"), "manifest"),
        integrationId,
      );
      await this.readCheckpoint(journal);
      if (validateBlobs) await this.readOriginalBlobs(journal);
    } catch (error) {
      if (error instanceof CollabError && error.code === "SNAPSHOT_INVALID") throw error;
      throw invalidJournal("Integration journal is incomplete or unreadable");
    }
    return journal;
  }

  private async readCheckpoint(journal: IntegrationJournal): Promise<IntegrationJournalCheckpoint> {
    try {
      return validateCheckpoint(
        parseJson<IntegrationJournalCheckpoint>(await readFile(join(this.directory(journal.integrationId), "checkpoint.json"), "utf8"), "checkpoint"),
        journal,
      );
    } catch (error) {
      if (error instanceof CollabError && error.code === "SNAPSHOT_INVALID") throw error;
      throw invalidJournal("Integration journal checkpoint is unreadable");
    }
  }

  private async readOriginalBlobs(journal: IntegrationJournal): Promise<Map<string, Uint8Array>> {
    const blobs = new Map<string, Uint8Array>();
    try {
      for (const original of journal.originals) {
        if (!original.present || blobs.has(original.contentHash)) continue;
        const bytes = await readFile(join(this.directory(journal.integrationId), "blobs", original.contentHash));
        if (bytes.byteLength !== original.size || hash(bytes) !== original.contentHash) {
          throw invalidJournal(`Integration journal original blob is corrupt: ${original.path}`);
        }
        blobs.set(original.contentHash, bytes);
      }
    } catch (error) {
      if (error instanceof CollabError && error.code === "SNAPSHOT_INVALID") throw error;
      throw invalidJournal("Integration journal original blob is unreadable");
    }
    return blobs;
  }

  private async writeCheckpoint(integrationId: string, checkpoint: IntegrationJournalCheckpoint): Promise<void> {
    const temporary = join(this.directory(integrationId), `.checkpoint.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(checkpoint, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, join(this.directory(integrationId), "checkpoint.json"));
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async retire(integrationId: string): Promise<void> {
    const retired = join(this.root, `.retired.${integrationId}.${randomUUID()}`);
    await rename(this.directory(integrationId), retired);
    await rm(retired, { recursive: true, force: true });
  }
}
