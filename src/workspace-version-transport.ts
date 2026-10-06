import { createHash } from "node:crypto";
import { WORKSPACE_VERSION_CAPABILITY, type WorkspaceSnapshotChunk, type WorkspaceSnapshotPackage } from "./collaboration-types.js";
import type { ParticipantGatewayTransport } from "./participant.js";
import { validateWorkspaceSnapshotPackage, WorkspaceSnapshotStore } from "./workspace-snapshot-store.js";
import { validateWorkspaceVersionRecord, type WorkspaceVersionRecord } from "./workspace-versions.js";
import { DEFAULT_WORKSPACE_SNAPSHOT_MAX_FILES, DEFAULT_WORKSPACE_SNAPSHOT_MAX_TOTAL_BYTES } from "./workspace-snapshot.js";

const DEFAULT_CHUNK_BYTES = 64 * 1024;
const MAX_CHUNK_BYTES = 256 * 1024;
const DEFAULT_MAX_FILES = DEFAULT_WORKSPACE_SNAPSHOT_MAX_FILES;
const DEFAULT_MAX_TOTAL_BYTES = DEFAULT_WORKSPACE_SNAPSHOT_MAX_TOTAL_BYTES;

export interface DownloadedWorkspaceVersion {
  record: WorkspaceVersionRecord;
  stored: boolean;
}

function hash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function responseBody<T>(response: { status: number; body: unknown }): T {
  if (response.status >= 400) throw new Error(`Workspace Version request failed (${String(response.status)})`);
  return response.body as T;
}

function decodeChunk(value: WorkspaceSnapshotChunk, expected: { snapshotId: string; fileIndex: number; offset: number }): Uint8Array {
  if (!value || value.snapshotId !== expected.snapshotId || value.fileIndex !== expected.fileIndex || value.offset !== expected.offset
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || typeof value.data !== "string"
    || !/^[a-f0-9]{64}$/.test(value.chunkHash) || typeof value.eof !== "boolean"
    || value.data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
    throw new Error("Workspace Version chunk is malformed");
  }
  const bytes = Buffer.from(value.data, "base64");
  if (bytes.byteLength !== value.byteLength || hash(bytes) !== value.chunkHash) throw new Error("Workspace Version chunk integrity check failed");
  return bytes;
}

function validateBinding(roomId: string, rawRecord: unknown, rawSnapshot: unknown): { record: WorkspaceVersionRecord; snapshot: WorkspaceSnapshotPackage } {
  const record = validateWorkspaceVersionRecord(rawRecord);
  const snapshot = validateWorkspaceSnapshotPackage(rawSnapshot as WorkspaceSnapshotPackage, record.artifact.snapshotId);
  if (record.version.roomId !== roomId || snapshot.roomId !== roomId || record.artifact.manifestHash !== snapshot.manifestHash
    || record.version.files.length !== snapshot.files.length
    || record.version.files.some((file, index) => {
      const source = snapshot.files[index];
      return !source || file.path !== source.path || file.contentHash !== source.contentHash || file.size !== source.size;
    })) {
    throw new Error("Workspace Version artifact binding is invalid");
  }
  return { record, snapshot };
}

export class WorkspaceVersionClient {
  private readonly chunkBytes: number;
  private readonly maxFiles: number;
  private readonly maxTotalBytes: number;

  constructor(private readonly options: {
    transport: ParticipantGatewayTransport;
    artifacts: WorkspaceSnapshotStore;
    chunkBytes?: number;
    maxFiles?: number;
    maxTotalBytes?: number;
  }) {
    this.chunkBytes = options.chunkBytes ?? DEFAULT_CHUNK_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    if (!Number.isSafeInteger(this.chunkBytes) || this.chunkBytes < 1 || this.chunkBytes > MAX_CHUNK_BYTES) throw new Error("Workspace Version chunk limit is invalid");
    if (!Number.isSafeInteger(this.maxFiles) || this.maxFiles < 1 || !Number.isSafeInteger(this.maxTotalBytes) || this.maxTotalBytes < 1) {
      throw new Error("Workspace Version download limit is invalid");
    }
  }

  async downloadLatest(input: { roomId: string; token: string; signal?: AbortSignal }): Promise<DownloadedWorkspaceVersion> {
    return await this.downloadResponse(input, `/v1/rooms/${encodeURIComponent(input.roomId)}/workspace-versions/latest`);
  }

  async download(input: { roomId: string; token: string; workspaceVersionId: string; signal?: AbortSignal }): Promise<DownloadedWorkspaceVersion> {
    return await this.downloadResponse(
      input,
      `/v1/rooms/${encodeURIComponent(input.roomId)}/workspace-versions/${encodeURIComponent(input.workspaceVersionId)}`,
      input.workspaceVersionId,
    );
  }

  private async downloadResponse(input: { roomId: string; token: string; signal?: AbortSignal }, path: string, expectedVersionId?: string): Promise<DownloadedWorkspaceVersion> {
    const response = await this.options.transport.request({
      method: "GET",
      path,
      token: input.token,
      capabilities: [WORKSPACE_VERSION_CAPABILITY],
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const value = responseBody<{ record: unknown; snapshot: unknown }>(response);
    const { record, snapshot } = validateBinding(input.roomId, value.record, value.snapshot);
    if (expectedVersionId !== undefined && record.version.workspaceVersionId !== expectedVersionId) {
      throw new Error("Workspace Version response identity does not match request");
    }
    if (snapshot.files.length > this.maxFiles) throw new Error("Workspace Version file count exceeds download limit");
    const totalBytes = snapshot.files.reduce((total, file) => total + file.size, 0);
    if (!Number.isSafeInteger(totalBytes) || totalBytes > this.maxTotalBytes) throw new Error("Workspace Version size exceeds download limit");
    const existing = await this.options.artifacts.load(snapshot.snapshotId);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(snapshot)) throw new Error("Workspace Version identity conflicts with local artifact");
      for (const file of snapshot.files) await this.options.artifacts.readFile(snapshot.snapshotId, file.path);
      return { record, stored: false };
    }

    const contents = new Map<string, Uint8Array>();
    for (let fileIndex = 0; fileIndex < snapshot.files.length; fileIndex += 1) {
      const file = snapshot.files[fileIndex]!;
      const content = Buffer.alloc(file.size);
      let offset = 0;
      while (offset < file.size) {
        const chunkResponse = await this.options.transport.request({
          method: "GET",
          path: `/v1/rooms/${encodeURIComponent(input.roomId)}/workspace-versions/${encodeURIComponent(record.version.workspaceVersionId)}/files/${String(fileIndex)}?offset=${String(offset)}&limit=${String(this.chunkBytes)}`,
          token: input.token,
          capabilities: [WORKSPACE_VERSION_CAPABILITY],
          ...(input.signal ? { signal: input.signal } : {}),
        });
        const chunk = responseBody<{ chunk: WorkspaceSnapshotChunk }>(chunkResponse).chunk;
        const bytes = decodeChunk(chunk, { snapshotId: snapshot.snapshotId, fileIndex, offset });
        if (bytes.byteLength === 0 || offset + bytes.byteLength > file.size || chunk.eof !== (offset + bytes.byteLength === file.size)) {
          throw new Error("Workspace Version chunk range is inconsistent");
        }
        content.set(bytes, offset);
        offset += bytes.byteLength;
      }
      if (hash(content) !== file.contentHash) throw new Error(`Workspace Version file hash does not match: ${file.path}`);
      contents.set(file.path, content);
    }
    try {
      await this.options.artifacts.save(snapshot, contents);
      return { record, stored: true };
    } catch (error) {
      const raced = await this.options.artifacts.load(snapshot.snapshotId);
      if (!raced || JSON.stringify(raced) !== JSON.stringify(snapshot)) throw error;
      for (const file of snapshot.files) await this.options.artifacts.readFile(snapshot.snapshotId, file.path);
      return { record, stored: false };
    }
  }
}
