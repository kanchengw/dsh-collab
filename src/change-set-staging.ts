import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CollabError, invalidInput } from "./errors.js";
import { MAX_CHANGE_SET_MANIFEST_BYTES, validateChangeSetDraft, verifyChangeSetDraftBundle, type ChangeSetDraft } from "./change-sets.js";
import type { DshRepositorySubprocess } from "./repository-inspector.js";
import type { RoomStore } from "./room.js";
import type { WorkspaceVersionArtifactStore, WorkspaceVersionService } from "./workspace-versions.js";

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const MAX_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_UPLOAD_CHUNKS = 4_096;

export interface StagedChangeSet {
  version: 1;
  changeSetId: string;
  draft: ChangeSetDraft;
  submittedAt: number;
}

export interface ChangeSetUpload {
  uploadId: string;
  changeSetId: string;
  state: "uploading" | "finalized";
  patchOffset: number;
  resultOffsets: number[];
}

interface UploadSession {
  version: 1;
  uploadId: string;
  roomId: string;
  memberId: string;
  principalId: string;
  clientRequestId: string;
  draft: ChangeSetDraft;
  state: "uploading" | "finalized";
  createdAt: number;
  finalizedAt?: number;
}

function hash(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
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

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 128) {
    throw invalidInput(`${field} is invalid`, { field });
  }
  return value.trim();
}

function validateSession(value: unknown, uploadId: string): UploadSession {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ChangeSet upload session is malformed");
  const session = value as Record<string, unknown>;
  const allowed = new Set(["version", "uploadId", "roomId", "memberId", "principalId", "clientRequestId", "draft", "state", "createdAt", "finalizedAt"]);
  if (Object.keys(session).some((field) => !allowed.has(field)) || session.version !== 1 || session.uploadId !== uploadId
    || typeof session.roomId !== "string" || session.roomId === "" || typeof session.memberId !== "string" || session.memberId === ""
    || typeof session.principalId !== "string" || session.principalId === "" || typeof session.clientRequestId !== "string" || session.clientRequestId === ""
    || (session.state !== "uploading" && session.state !== "finalized") || !Number.isSafeInteger(session.createdAt) || (session.createdAt as number) < 0
    || (session.finalizedAt !== undefined && (!Number.isSafeInteger(session.finalizedAt) || (session.finalizedAt as number) < 0))) {
    throw new Error("ChangeSet upload session is malformed");
  }
  const draft = validateChangeSetDraft(session.draft);
  if (draft.roomId !== session.roomId || draft.authorId !== session.memberId
    || (session.state === "finalized" && session.finalizedAt === undefined)
    || (session.state === "uploading" && session.finalizedAt !== undefined)) {
    throw new Error("ChangeSet upload session binding is malformed");
  }
  return structuredClone({ ...session, draft } as UploadSession);
}

function validateStaged(value: unknown, roomId: string, changeSetId: string): StagedChangeSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Staged ChangeSet manifest is malformed");
  const manifest = value as Record<string, unknown>;
  const allowed = new Set(["version", "changeSetId", "draft", "submittedAt"]);
  if (Object.keys(manifest).some((field) => !allowed.has(field)) || manifest.version !== 1 || manifest.changeSetId !== changeSetId
    || !Number.isSafeInteger(manifest.submittedAt) || (manifest.submittedAt as number) < 0) {
    throw new Error("Staged ChangeSet manifest is malformed");
  }
  const draft = validateChangeSetDraft(manifest.draft, changeSetId);
  if (draft.roomId !== roomId) throw new Error("Staged ChangeSet room binding is malformed");
  return { version: 1, changeSetId, draft, submittedAt: manifest.submittedAt as number };
}

export class ChangeSetStagingService {
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(private readonly options: {
    root: string;
    rooms: RoomStore;
    workspaceVersions: WorkspaceVersionService;
    artifacts: WorkspaceVersionArtifactStore;
    subprocess: DshRepositorySubprocess;
    now?: () => number;
    maxUploadChunks?: number;
  }) {
    if (options.maxUploadChunks !== undefined && (!Number.isSafeInteger(options.maxUploadChunks) || options.maxUploadChunks < 1)) {
      throw new Error("ChangeSet upload chunk count limit is invalid");
    }
  }

  async createUpload(input: { roomId: string; principalId: string; clientRequestId: string; draft: unknown }): Promise<ChangeSetUpload> {
    const member = this.options.rooms.authorize(input.roomId, input.principalId, "changeSet");
    const clientRequestId = requiredId(input.clientRequestId, "clientRequestId");
    const uploadId = hash(JSON.stringify({ roomId: input.roomId, memberId: member.memberId, clientRequestId }));
    return await this.serial(uploadId, async () => {
      const existing = await this.loadSession(uploadId);
      if (existing) {
        let repeatedDraft: ChangeSetDraft;
        try {
          repeatedDraft = validateChangeSetDraft(input.draft);
        } catch {
          throw new CollabError("REQUEST_CONFLICT", "ChangeSet upload request conflicts with an existing request", { clientRequestId });
        }
        if (existing.roomId !== input.roomId || existing.memberId !== member.memberId || existing.draft.draftId !== repeatedDraft.draftId) {
          throw new CollabError("REQUEST_CONFLICT", "ChangeSet upload request conflicts with an existing request", { clientRequestId });
        }
        return await this.uploadView(existing);
      }

      let draft: ChangeSetDraft;
      try {
        draft = validateChangeSetDraft(input.draft);
      } catch (error) {
        throw invalidInput(error instanceof Error ? error.message : "ChangeSet draft is invalid");
      }
      if (Buffer.byteLength(JSON.stringify(draft)) > MAX_CHANGE_SET_MANIFEST_BYTES) {
        throw invalidInput("ChangeSet manifest exceeds the upload limit");
      }
      if (draft.roomId !== input.roomId || draft.authorId !== member.memberId) {
        throw invalidInput("ChangeSet draft identity does not match the authenticated member");
      }
      if (!this.options.workspaceVersions.get(input.roomId, draft.baseWorkspaceVersionId)) {
        throw new CollabError("SNAPSHOT_NOT_FOUND", "ChangeSet base Workspace Version does not exist");
      }
      const now = this.options.now?.() ?? Date.now();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error("ChangeSet upload timestamp is invalid");
      const session: UploadSession = {
        version: 1,
        uploadId,
        roomId: input.roomId,
        memberId: member.memberId,
        principalId: member.principalId,
        clientRequestId,
        draft,
        state: "uploading",
        createdAt: now,
      };
      await this.publishSession(session);
      return await this.uploadView(session);
    });
  }

  async writeChunk(input: {
    roomId: string;
    principalId: string;
    uploadId: string;
    target: "patch" | "result";
    fileIndex?: number;
    offset: number;
    bytes: Uint8Array;
  }): Promise<void> {
    if (!HASH_PATTERN.test(input.uploadId)) throw invalidInput("uploadId is invalid");
    if (!Number.isSafeInteger(input.offset) || input.offset < 0 || input.bytes.byteLength < 1 || input.bytes.byteLength > MAX_CHUNK_BYTES) {
      throw invalidInput("ChangeSet chunk range is invalid");
    }
    await this.serial(input.uploadId, async () => {
      const session = await this.requireSession(input.uploadId, input.roomId, input.principalId);
      if (session.state === "finalized") return;
      const target = this.chunkTarget(session.draft, input.target, input.fileIndex);
      if (input.offset + input.bytes.byteLength > target.bytes) throw invalidInput("ChangeSet chunk exceeds its declared artifact size");
      const directory = join(this.uploadDirectory(input.uploadId), "chunks", target.directory);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const destination = join(directory, `${String(input.offset).padStart(12, "0")}.chunk`);
      if (await exists(destination)) {
        const previous = await readFile(destination);
        if (!previous.equals(Buffer.from(input.bytes))) throw new CollabError("REQUEST_CONFLICT", "ChangeSet chunk conflicts with uploaded data");
        return;
      }
      const existingChunks = (await readdir(directory)).filter((name) => name.endsWith(".chunk")).sort();
      let nextOffset = 0;
      const lastName = existingChunks.at(-1);
      if (lastName) {
        const match = /^(\d{12})\.chunk$/.exec(lastName);
        if (!match) throw new Error("ChangeSet upload chunk state is malformed");
        nextOffset = Number(match[1]) + (await stat(join(directory, lastName))).size;
      }
      if (input.offset !== nextOffset) throw invalidInput("ChangeSet chunks must be uploaded in order");
      const allEntries = await readdir(join(this.uploadDirectory(input.uploadId), "chunks"), { recursive: true });
      const chunkCount = allEntries.filter((name) => name.endsWith(".chunk")).length;
      if (chunkCount >= (this.options.maxUploadChunks ?? DEFAULT_MAX_UPLOAD_CHUNKS)) {
        throw new CollabError("RESOURCE_LIMIT", "ChangeSet upload has too many chunks");
      }
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, input.bytes, { flag: "wx", mode: 0o600 });
        await rename(temporary, destination);
      } catch (error) {
        await rm(temporary, { force: true });
        if (await exists(destination)) {
          const previous = await readFile(destination);
          if (previous.equals(Buffer.from(input.bytes))) return;
        }
        throw error;
      }
    });
  }

  async finalize(input: { roomId: string; principalId: string; uploadId: string }): Promise<StagedChangeSet> {
    if (!HASH_PATTERN.test(input.uploadId)) throw invalidInput("uploadId is invalid");
    return await this.serial(input.uploadId, async () => {
      const session = await this.requireSession(input.uploadId, input.roomId, input.principalId);
      const existing = await this.get(session.roomId, session.draft.draftId);
      if (existing) {
        if (existing.draft.draftId !== session.draft.draftId) throw new CollabError("REQUEST_CONFLICT", "ChangeSet identity conflicts with staged data");
        if (session.state !== "finalized") await this.markFinalized(session, existing.submittedAt);
        return existing;
      }
      if (session.state === "finalized") throw new Error("Finalized ChangeSet artifact is missing");

      let patchBytes: Buffer;
      const results = new Map<string, Uint8Array>();
      try {
        patchBytes = await this.assemble(input.uploadId, "patch", session.draft.artifact.patchBytes);
        for (let fileIndex = 0; fileIndex < session.draft.files.length; fileIndex += 1) {
          const file = session.draft.files[fileIndex]!;
          if (file.resultContentHash === undefined) continue;
          results.set(file.path, await this.assemble(input.uploadId, `result-${String(fileIndex)}`, file.resultSize!));
        }
      } catch (error) {
        throw invalidInput(error instanceof Error ? error.message : "ChangeSet upload is incomplete");
      }
      let patch: string;
      try {
        patch = new TextDecoder("utf-8", { fatal: true }).decode(patchBytes);
      } catch {
        throw invalidInput("ChangeSet patch is not UTF-8 text");
      }
      const baseRecord = this.options.workspaceVersions.get(session.roomId, session.draft.baseWorkspaceVersionId);
      if (!baseRecord) throw new CollabError("SNAPSHOT_NOT_FOUND", "ChangeSet base Workspace Version does not exist");
      try {
        await verifyChangeSetDraftBundle({
          draft: session.draft,
          patch,
          results,
          baseRecord,
          artifacts: this.options.artifacts,
          subprocess: this.options.subprocess,
        });
      } catch (error) {
        throw invalidInput(error instanceof Error ? error.message : "ChangeSet artifact verification failed");
      }

      const submittedAt = this.options.now?.() ?? Date.now();
      if (!Number.isSafeInteger(submittedAt) || submittedAt < 0) throw new Error("ChangeSet submission timestamp is invalid");
      const changeSet: StagedChangeSet = { version: 1, changeSetId: session.draft.draftId, draft: session.draft, submittedAt };
      await this.publishChangeSet(changeSet, patchBytes, results);
      await this.markFinalized(session, submittedAt);
      return changeSet;
    });
  }

  async get(roomId: string, changeSetId: string): Promise<StagedChangeSet | undefined> {
    if (!HASH_PATTERN.test(changeSetId)) throw invalidInput("changeSetId is invalid");
    const directory = this.stagedDirectory(roomId, changeSetId);
    const changeSet = await this.loadManifest(roomId, changeSetId);
    if (!changeSet) return undefined;
    const patch = await readFile(join(directory, "patch.diff"));
    if (patch.byteLength !== changeSet.draft.artifact.patchBytes || hash(patch) !== changeSet.draft.artifact.patchHash) {
      throw new Error("Staged ChangeSet patch is corrupted");
    }
    for (const file of changeSet.draft.files) {
      if (!file.resultContentHash) continue;
      const content = await readFile(join(directory, "blobs", file.resultContentHash));
      if (content.byteLength !== file.resultSize || hash(content) !== file.resultContentHash) {
        throw new Error(`Staged ChangeSet result is corrupted: ${file.path}`);
      }
    }
    return structuredClone(changeSet);
  }

  async readPatchChunk(roomId: string, changeSetId: string, offset: number, limit: number): Promise<{ changeSet: StagedChangeSet; bytes: Uint8Array }> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_CHUNK_BYTES) {
      throw invalidInput("ChangeSet patch chunk range is invalid");
    }
    const changeSet = await this.loadManifest(roomId, changeSetId);
    if (!changeSet) throw new CollabError("CHANGE_SET_NOT_FOUND", "ChangeSet does not exist");
    if (offset > changeSet.draft.artifact.patchBytes) throw invalidInput("ChangeSet patch offset exceeds its size");
    const byteLength = Math.min(limit, changeSet.draft.artifact.patchBytes - offset);
    const bytes = Buffer.alloc(byteLength);
    const handle = await open(join(this.stagedDirectory(roomId, changeSetId), "patch.diff"), "r");
    try {
      const result = await handle.read(bytes, 0, byteLength, offset);
      if (result.bytesRead !== byteLength) throw new Error("Staged ChangeSet patch is truncated");
    } finally {
      await handle.close();
    }
    return { changeSet, bytes };
  }

  async readResult(roomId: string, changeSetId: string, path: string): Promise<Uint8Array> {
    const changeSet = await this.loadManifest(roomId, changeSetId);
    const file = changeSet?.draft.files.find((candidate) => candidate.path === path);
    if (!file?.resultContentHash) throw new CollabError("CHANGE_SET_NOT_FOUND", "ChangeSet result does not exist");
    const content = await readFile(join(this.stagedDirectory(roomId, changeSetId), "blobs", file.resultContentHash));
    if (content.byteLength !== file.resultSize || hash(content) !== file.resultContentHash) throw new Error(`Staged ChangeSet result is corrupted: ${file.path}`);
    return content;
  }

  private async requireSession(uploadId: string, roomId: string, principalId: string): Promise<UploadSession> {
    const member = this.options.rooms.authorize(roomId, principalId, "changeSet");
    const session = await this.loadSession(uploadId);
    if (!session) throw new CollabError("UPLOAD_NOT_FOUND", "ChangeSet upload does not exist");
    if (session.roomId !== roomId || session.memberId !== member.memberId || session.principalId !== member.principalId) {
      throw new CollabError("ACTION_FORBIDDEN", "ChangeSet upload belongs to another member or room");
    }
    return session;
  }

  private async uploadView(session: UploadSession): Promise<ChangeSetUpload> {
    if (session.state === "finalized") {
      return {
        uploadId: session.uploadId,
        changeSetId: session.draft.draftId,
        state: session.state,
        patchOffset: session.draft.artifact.patchBytes,
        resultOffsets: session.draft.files.map((file) => file.resultSize ?? 0),
      };
    }
    return {
      uploadId: session.uploadId,
      changeSetId: session.draft.draftId,
      state: session.state,
      patchOffset: await this.receivedBytes(session.uploadId, "patch"),
      resultOffsets: await Promise.all(session.draft.files.map((file, fileIndex) => file.resultContentHash === undefined
        ? 0
        : this.receivedBytes(session.uploadId, `result-${String(fileIndex)}`))),
    };
  }

  private async receivedBytes(uploadId: string, target: string): Promise<number> {
    const directory = join(this.uploadDirectory(uploadId), "chunks", target);
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".chunk")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
      throw error;
    }
    let offset = 0;
    for (const name of names) {
      const match = /^(\d{12})\.chunk$/.exec(name);
      if (!match || Number(match[1]) !== offset) throw new Error("ChangeSet upload chunk state is malformed");
      offset += (await stat(join(directory, name))).size;
    }
    return offset;
  }

  private chunkTarget(draft: ChangeSetDraft, target: "patch" | "result", fileIndex?: number): { directory: string; bytes: number } {
    if (target === "patch") {
      if (fileIndex !== undefined) throw invalidInput("Patch chunks must not include fileIndex");
      return { directory: "patch", bytes: draft.artifact.patchBytes };
    }
    if (!Number.isSafeInteger(fileIndex) || (fileIndex as number) < 0 || (fileIndex as number) >= draft.files.length) {
      throw invalidInput("Result chunk fileIndex is invalid");
    }
    const file = draft.files[fileIndex as number]!;
    if (file.resultContentHash === undefined) throw invalidInput("ChangeSet file has no result content");
    return { directory: `result-${String(fileIndex)}`, bytes: file.resultSize! };
  }

  private async assemble(uploadId: string, target: string, expectedBytes: number): Promise<Buffer> {
    if (expectedBytes === 0) return Buffer.alloc(0);
    const directory = join(this.uploadDirectory(uploadId), "chunks", target);
    let names: string[];
    try {
      names = (await readdir(directory)).filter((name) => name.endsWith(".chunk")).sort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ChangeSet upload is incomplete");
      throw error;
    }
    const chunks: Buffer[] = [];
    let offset = 0;
    for (const name of names) {
      const match = /^(\d{12})\.chunk$/.exec(name);
      if (!match || Number(match[1]) !== offset) throw new Error("ChangeSet upload chunks are not contiguous");
      const chunk = await readFile(join(directory, name));
      if (chunk.byteLength < 1 || chunk.byteLength > MAX_CHUNK_BYTES || offset + chunk.byteLength > expectedBytes) {
        throw new Error("ChangeSet upload chunk range is invalid");
      }
      chunks.push(chunk);
      offset += chunk.byteLength;
    }
    if (offset !== expectedBytes) throw new Error("ChangeSet upload is incomplete");
    return Buffer.concat(chunks, expectedBytes);
  }

  private async publishSession(session: UploadSession): Promise<void> {
    const destination = this.uploadDirectory(session.uploadId);
    await mkdir(join(this.options.root, "uploads"), { recursive: true, mode: 0o700 });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await mkdir(temporary, { recursive: false, mode: 0o700 });
      await writeFile(join(temporary, "session.json"), JSON.stringify(session, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      const raced = await this.loadSession(session.uploadId).catch(() => undefined);
      if (raced?.draft.draftId === session.draft.draftId) return;
      throw error;
    }
  }

  private async markFinalized(session: UploadSession, finalizedAt: number): Promise<void> {
    const finalized: UploadSession = { ...session, state: "finalized", finalizedAt };
    const path = join(this.uploadDirectory(session.uploadId), "session.json");
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(finalized, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    await rm(join(this.uploadDirectory(session.uploadId), "chunks"), { recursive: true, force: true });
  }

  private async publishChangeSet(changeSet: StagedChangeSet, patch: Uint8Array, results: ReadonlyMap<string, Uint8Array>): Promise<void> {
    const roomRoot = join(this.options.root, "staged", hash(changeSet.draft.roomId));
    const destination = join(roomRoot, changeSet.changeSetId);
    await mkdir(roomRoot, { recursive: true, mode: 0o700 });
    const temporary = join(roomRoot, `.${changeSet.changeSetId}.${randomUUID()}.tmp`);
    try {
      await mkdir(join(temporary, "blobs"), { recursive: true, mode: 0o700 });
      const written = new Set<string>();
      for (const file of changeSet.draft.files) {
        if (!file.resultContentHash || written.has(file.resultContentHash)) continue;
        await writeFile(join(temporary, "blobs", file.resultContentHash), results.get(file.path)!, { flag: "wx", mode: 0o600 });
        written.add(file.resultContentHash);
      }
      await writeFile(join(temporary, "patch.diff"), patch, { flag: "wx", mode: 0o600 });
      await writeFile(join(temporary, "manifest.json"), JSON.stringify(changeSet, null, 2) + "\n", { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      const raced = await this.get(changeSet.draft.roomId, changeSet.changeSetId).catch(() => undefined);
      if (raced?.draft.draftId === changeSet.draft.draftId) return;
      throw error;
    }
  }

  private async loadSession(uploadId: string): Promise<UploadSession | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.uploadDirectory(uploadId), "session.json"), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("ChangeSet upload session is malformed", { cause: error });
    }
    return validateSession(parsed, uploadId);
  }

  private async loadManifest(roomId: string, changeSetId: string): Promise<StagedChangeSet | undefined> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.stagedDirectory(roomId, changeSetId), "manifest.json"), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error("Staged ChangeSet manifest is malformed", { cause: error });
    }
    return validateStaged(parsed, roomId, changeSetId);
  }

  private uploadDirectory(uploadId: string): string {
    return join(this.options.root, "uploads", uploadId);
  }

  private stagedDirectory(roomId: string, changeSetId: string): string {
    return join(this.options.root, "staged", hash(roomId), changeSetId);
  }

  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    this.queues.set(key, current);
    void current.finally(() => { if (this.queues.get(key) === current) this.queues.delete(key); }).catch(() => undefined);
    return current;
  }
}
