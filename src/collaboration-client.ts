import { createHash, randomUUID } from "node:crypto";
import { CHANGE_SET_CAPABILITY, SIDECAR_REVIEW_CAPABILITY, type WorkspaceSnapshotChunk, type WorkspaceSnapshotPackage } from "./collaboration-types.js";
import { validateChangeSetDraft, type ChangeSetDraftStore } from "./change-sets.js";
import type { StagedChangeSet } from "./change-set-staging.js";
import type { ParticipantGatewayTransport } from "./participant.js";
import { SnapshotWorkspaceMaterializer, type MaterializedSnapshotWorkspace } from "./snapshot-workspace.js";
import { validateWorkspaceSnapshotPackage } from "./workspace-snapshot-store.js";
import { DEFAULT_WORKSPACE_SNAPSHOT_MAX_TOTAL_BYTES } from "./workspace-snapshot.js";

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = DEFAULT_WORKSPACE_SNAPSHOT_MAX_TOTAL_BYTES;
const DEFAULT_CHANGE_SET_CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_CHANGE_SET_PATCH_BYTES = 16 * 1024 * 1024;

function hash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function body<T>(response: { status: number; body: unknown }): T {
  if (response.status >= 400) throw new Error(`Workspace Snapshot request failed (${String(response.status)})`);
  return response.body as T;
}

function decodeChunk(value: WorkspaceSnapshotChunk, expected: { snapshotId: string; fileIndex: number; offset: number }): Uint8Array {
  if (!value || value.snapshotId !== expected.snapshotId || value.fileIndex !== expected.fileIndex || value.offset !== expected.offset
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || typeof value.data !== "string"
    || !/^[a-f0-9]{64}$/.test(value.chunkHash) || typeof value.eof !== "boolean"
    || value.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
    throw new Error("Workspace Snapshot chunk is malformed");
  }
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.byteLength !== value.byteLength) throw new Error("Workspace Snapshot chunk byte length does not match");
  if (hash(bytes) !== value.chunkHash) throw new Error("Workspace Snapshot chunk hash does not match");
  return bytes;
}

export class CollaborationWorkspaceClient {
  private readonly chunkBytes: number;
  private readonly maxTotalBytes: number;
  private readonly clientRequestIdFactory: () => string;

  constructor(private readonly options: {
    transport: ParticipantGatewayTransport;
    materializer: SnapshotWorkspaceMaterializer;
    chunkBytes?: number;
    maxTotalBytes?: number;
    clientRequestIdFactory?: () => string;
  }) {
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.clientRequestIdFactory = options.clientRequestIdFactory ?? randomUUID;
    if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > MAX_CHUNK_BYTES) throw new Error("Workspace Snapshot chunk limit is invalid");
    if (!Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < 1) throw new Error("Workspace Snapshot download limit is invalid");
  }

  async downloadLatest(input: { roomId: string; token: string; clientRequestId?: string }): Promise<MaterializedSnapshotWorkspace> {
    const response = await this.options.transport.request({
      method: "POST",
      path: `/v1/rooms/${encodeURIComponent(input.roomId)}/workspace-snapshots`,
      token: input.token,
      capabilities: [SIDECAR_REVIEW_CAPABILITY],
      body: { clientRequestId: input.clientRequestId ?? this.clientRequestIdFactory() },
    });
    const snapshot = body<{ snapshot: WorkspaceSnapshotPackage }>(response).snapshot;
    return await this.downloadPackage(input, snapshot);
  }

  async downloadSnapshot(input: { roomId: string; token: string; snapshotId: string }): Promise<MaterializedSnapshotWorkspace> {
    const response = await this.options.transport.request({
      method: "GET",
      path: `/v1/rooms/${encodeURIComponent(input.roomId)}/workspace-snapshots/${encodeURIComponent(input.snapshotId)}`,
      token: input.token,
      capabilities: [SIDECAR_REVIEW_CAPABILITY],
    });
    const snapshot = body<{ snapshot: WorkspaceSnapshotPackage }>(response).snapshot;
    if (snapshot.snapshotId !== input.snapshotId) throw new Error("Workspace Snapshot response identity does not match request");
    return await this.downloadPackage(input, snapshot);
  }

  private async downloadPackage(input: { roomId: string; token: string }, raw: WorkspaceSnapshotPackage): Promise<MaterializedSnapshotWorkspace> {
    const snapshot = validateWorkspaceSnapshotPackage(raw);
    if (snapshot.roomId !== input.roomId) throw new Error("Workspace Snapshot does not belong to requested room");
    const totalBytes = snapshot.files.reduce((total, file) => total + file.size, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > this.maxTotalBytes) throw new Error("Workspace Snapshot size exceeds download limit");

    const contents = new Map<string, Uint8Array>();
    for (let fileIndex = 0; fileIndex < snapshot.files.length; fileIndex += 1) {
      const file = snapshot.files[fileIndex]!;
      const content = Buffer.alloc(file.size);
      let offset = 0;
      while (offset < file.size) {
        const response = await this.options.transport.request({
          method: "GET",
          path: `/v1/rooms/${encodeURIComponent(input.roomId)}/workspace-snapshots/${encodeURIComponent(snapshot.snapshotId)}/files/${String(fileIndex)}?offset=${String(offset)}&limit=${String(this.chunkBytes)}`,
          token: input.token,
          capabilities: [SIDECAR_REVIEW_CAPABILITY],
        });
        const chunk = body<{ chunk: WorkspaceSnapshotChunk }>(response).chunk;
        const bytes = decodeChunk(chunk, { snapshotId: snapshot.snapshotId, fileIndex, offset });
        if (bytes.byteLength === 0 || offset + bytes.byteLength > file.size || chunk.eof !== (offset + bytes.byteLength === file.size)) {
          throw new Error("Workspace Snapshot chunk range is inconsistent");
        }
        content.set(bytes, offset);
        offset += bytes.byteLength;
      }
      if (hash(content) !== file.contentHash) throw new Error(`Workspace Snapshot file hash does not match: ${file.path}`);
      contents.set(file.path, content);
    }
    return await this.options.materializer.materialize(snapshot, contents);
  }
}

function changeSetBody<T>(response: { status: number; body: unknown }): T {
  if (response.status >= 400) throw new Error(`ChangeSet request failed (${String(response.status)})`);
  return response.body as T;
}

function stagedChangeSet(value: unknown, roomId: string, expectedId?: string): StagedChangeSet {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ChangeSet response is malformed");
  const changeSet = value as Record<string, unknown>;
  const fields = new Set(["version", "changeSetId", "draft", "submittedAt"]);
  if (Object.keys(changeSet).some((field) => !fields.has(field)) || changeSet.version !== 1
    || typeof changeSet.changeSetId !== "string" || !/^[a-f0-9]{64}$/.test(changeSet.changeSetId)
    || (expectedId !== undefined && changeSet.changeSetId !== expectedId)
    || !Number.isSafeInteger(changeSet.submittedAt) || (changeSet.submittedAt as number) < 0) {
    throw new Error("ChangeSet response is malformed");
  }
  const draft = validateChangeSetDraft(changeSet.draft, changeSet.changeSetId);
  if (draft.roomId !== roomId) throw new Error("ChangeSet response belongs to another room");
  return { version: 1, changeSetId: changeSet.changeSetId, draft, submittedAt: changeSet.submittedAt as number };
}

export class ChangeSetClient {
  private readonly chunkBytes: number;
  private readonly maxPatchBytes: number;

  constructor(private readonly options: {
    transport: ParticipantGatewayTransport;
    chunkBytes?: number;
    maxPatchBytes?: number;
  }) {
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHANGE_SET_CHUNK_BYTES;
    this.maxPatchBytes = options.maxPatchBytes ?? DEFAULT_MAX_CHANGE_SET_PATCH_BYTES;
    if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > MAX_CHUNK_BYTES) throw new Error("ChangeSet chunk limit is invalid");
    if (!Number.isSafeInteger(this.maxPatchBytes) || this.maxPatchBytes < 1) throw new Error("ChangeSet patch limit is invalid");
  }

  async submit(input: {
    roomId: string;
    token: string;
    clientRequestId: string;
    draftId: string;
    drafts: ChangeSetDraftStore;
    signal?: AbortSignal;
  }): Promise<StagedChangeSet> {
    const bundle = await input.drafts.load(input.draftId);
    if (!bundle) throw new Error("ChangeSet draft does not exist");
    if (bundle.draft.roomId !== input.roomId) throw new Error("ChangeSet draft belongs to another room");
    const response = await this.options.transport.request({
      method: "POST",
      path: `/v1/rooms/${encodeURIComponent(input.roomId)}/change-sets/uploads`,
      token: input.token,
      capabilities: [CHANGE_SET_CAPABILITY],
      body: { clientRequestId: input.clientRequestId, draft: bundle.draft },
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const upload = changeSetBody<{ upload?: unknown }>(response).upload;
    if (!upload || typeof upload !== "object" || Array.isArray(upload)) throw new Error("ChangeSet upload response is malformed");
    const record = upload as Record<string, unknown>;
    if (typeof record.uploadId !== "string" || !/^[a-f0-9]{64}$/.test(record.uploadId)
      || record.changeSetId !== bundle.draft.draftId || (record.state !== "uploading" && record.state !== "finalized")
      || !Number.isSafeInteger(record.patchOffset) || (record.patchOffset as number) < 0 || (record.patchOffset as number) > bundle.draft.artifact.patchBytes
      || !Array.isArray(record.resultOffsets) || record.resultOffsets.length !== bundle.draft.files.length
      || record.resultOffsets.some((offset, fileIndex) => !Number.isSafeInteger(offset) || offset < 0 || offset > (bundle.draft.files[fileIndex]!.resultSize ?? 0))) {
      throw new Error("ChangeSet upload response is malformed");
    }
    if (record.state === "uploading") {
      await this.uploadBytes(input, record.uploadId, "patch", undefined, Buffer.from(bundle.patch), record.patchOffset as number);
      for (let fileIndex = 0; fileIndex < bundle.draft.files.length; fileIndex += 1) {
        const file = bundle.draft.files[fileIndex]!;
        if (!file.resultContentHash || file.resultSize === 0) continue;
        await this.uploadBytes(
          input,
          record.uploadId,
          "result",
          fileIndex,
          await input.drafts.readResult(bundle.draft.draftId, file.path),
          record.resultOffsets[fileIndex] as number,
        );
      }
    }
    const finalized = await this.options.transport.request({
      method: "POST",
      path: `/v1/rooms/${encodeURIComponent(input.roomId)}/change-sets/uploads/${record.uploadId}/finalize`,
      token: input.token,
      capabilities: [CHANGE_SET_CAPABILITY],
      body: {},
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return stagedChangeSet(changeSetBody<{ changeSet: unknown }>(finalized).changeSet, input.roomId, bundle.draft.draftId);
  }

  async get(input: { roomId: string; token: string; changeSetId: string; signal?: AbortSignal }): Promise<StagedChangeSet> {
    const response = await this.options.transport.request({
      method: "GET",
      path: `/v1/rooms/${encodeURIComponent(input.roomId)}/change-sets/${encodeURIComponent(input.changeSetId)}`,
      token: input.token,
      capabilities: [CHANGE_SET_CAPABILITY],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return stagedChangeSet(changeSetBody<{ changeSet: unknown }>(response).changeSet, input.roomId, input.changeSetId);
  }

  async readPatch(input: { roomId: string; token: string; changeSetId: string; signal?: AbortSignal }): Promise<string> {
    const changeSet = await this.get(input);
    const patchBytes = changeSet.draft.artifact.patchBytes;
    if (patchBytes > this.maxPatchBytes) throw new Error("ChangeSet patch exceeds the client limit");
    const patch = Buffer.alloc(patchBytes);
    let offset = 0;
    while (offset < patchBytes) {
      const response = await this.options.transport.request({
        method: "GET",
        path: `/v1/rooms/${encodeURIComponent(input.roomId)}/change-sets/${encodeURIComponent(input.changeSetId)}/patch?offset=${String(offset)}&limit=${String(this.chunkBytes)}`,
        token: input.token,
        capabilities: [CHANGE_SET_CAPABILITY],
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const chunk = changeSetBody<{ chunk?: unknown }>(response).chunk;
      if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) throw new Error("ChangeSet patch chunk is malformed");
      const value = chunk as Record<string, unknown>;
      if (value.changeSetId !== input.changeSetId || value.offset !== offset || !Number.isSafeInteger(value.byteLength)
        || (value.byteLength as number) < 1 || typeof value.chunkHash !== "string" || !/^[a-f0-9]{64}$/.test(value.chunkHash)
        || typeof value.data !== "string" || value.data.length % 4 !== 0
        || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)
        || typeof value.eof !== "boolean") {
        throw new Error("ChangeSet patch chunk is malformed");
      }
      const bytes = Buffer.from(value.data, "base64");
      if (bytes.byteLength !== value.byteLength || hash(bytes) !== value.chunkHash || offset + bytes.byteLength > patchBytes
        || value.eof !== (offset + bytes.byteLength === patchBytes)) {
        throw new Error("ChangeSet patch chunk integrity check failed");
      }
      patch.set(bytes, offset);
      offset += bytes.byteLength;
    }
    if (hash(patch) !== changeSet.draft.artifact.patchHash) throw new Error("ChangeSet patch hash does not match its manifest");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(patch);
    } catch {
      throw new Error("ChangeSet patch is not UTF-8 text");
    }
  }

  private async uploadBytes(
    input: { roomId: string; token: string; signal?: AbortSignal },
    uploadId: string,
    target: "patch" | "result",
    fileIndex: number | undefined,
    bytes: Uint8Array,
    startOffset: number,
  ): Promise<void> {
    for (let offset = startOffset; offset < bytes.byteLength; offset += this.chunkBytes) {
      const chunk = Buffer.from(bytes).subarray(offset, Math.min(offset + this.chunkBytes, bytes.byteLength));
      changeSetBody(await this.options.transport.request({
        method: "POST",
        path: `/v1/rooms/${encodeURIComponent(input.roomId)}/change-sets/uploads/${uploadId}/chunks`,
        token: input.token,
        capabilities: [CHANGE_SET_CAPABILITY],
        body: {
          target,
          ...(fileIndex === undefined ? {} : { fileIndex }),
          offset,
          byteLength: chunk.byteLength,
          chunkHash: hash(chunk),
          data: chunk.toString("base64"),
        },
        ...(input.signal ? { signal: input.signal } : {}),
      }));
    }
  }
}
