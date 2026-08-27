import { createHash, randomUUID } from "node:crypto";
import { SIDECAR_REVIEW_CAPABILITY, type WorkspaceSnapshotChunk, type WorkspaceSnapshotPackage } from "./collaboration-types.js";
import type { ParticipantGatewayTransport } from "./participant.js";
import { SnapshotWorkspaceMaterializer, type MaterializedSnapshotWorkspace } from "./snapshot-workspace.js";
import { validateWorkspaceSnapshotPackage } from "./workspace-snapshot-store.js";

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = 10_000;
const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

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
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;
  private readonly clientRequestIdFactory: () => string;

  constructor(private readonly options: {
    transport: ParticipantGatewayTransport;
    materializer: SnapshotWorkspaceMaterializer;
    chunkBytes?: number;
    maxFiles?: number;
    maxTotalBytes?: number;
    clientRequestIdFactory?: () => string;
  }) {
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    this.clientRequestIdFactory = options.clientRequestIdFactory ?? randomUUID;
    if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > MAX_CHUNK_BYTES) throw new Error("Workspace Snapshot chunk limit is invalid");
    if (!Number.isSafeInteger(this.maxFiles) || this.maxFiles < 1 || !Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < 1) throw new Error("Workspace Snapshot download limit is invalid");
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
    if (snapshot.files.length > this.maxFiles) throw new Error("Workspace Snapshot file count exceeds download limit");
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
