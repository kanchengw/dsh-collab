import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { DshLocalSidecarWorkspace } from "../../src/local-sidecar-workspace.js";
import type { WorkspaceSnapshotProvider } from "../../src/workspace-service.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function sha256(value: Uint8Array | string): string { return createHash("sha256").update(value).digest("hex"); }

function snapshot(snapshotId: string, content: Buffer): WorkspaceSnapshotPackage {
  const files = [{ path: "src/value.ts", contentHash: sha256(content), size: content.byteLength, source: "tracked" as const }];
  return { snapshotId, roomId: "room-1", hostSessionId: "session-1", roomEventSeq: 7, manifestHash: sha256(JSON.stringify(files)), files, createdAt: 10 };
}

describe("DSH local Sidecar workspace", () => {
  it("uses the trusted Host provider directly and captures latest code without Workspace Sharing", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-sidecar-local-"));
    roots.push(root);
    const content = Buffer.from("export const value = 1;\n");
    const stored = new Map<string, WorkspaceSnapshotPackage>();
    const provider: WorkspaceSnapshotProvider = {
      capture: vi.fn(async (input) => {
        const value = snapshot(input.snapshotId, content);
        stored.set(input.snapshotId, value);
        return value;
      }),
      load: async (snapshotId) => stored.get(snapshotId),
      readChunk: async (_snapshotId, _path, offset, length) => content.subarray(offset, offset + length),
    };
    const workspace = new DshLocalSidecarWorkspace({ root, local: () => ({ provider, hostSessionId: "session-1", roomEventSeq: 7 }) });

    const prepared = await workspace.prepare({ roomId: "room-1", requestedBy: "host", roomEventSeq: 7 });

    expect(provider.capture).toHaveBeenCalledOnce();
    await expect(prepared.readFile("src/value.ts")).resolves.toEqual(content);
    await prepared.dispose();
  });

  it("downloads a Participant snapshot with transient endpoint and token", async () => {
    const root = await mkdtemp(join(tmpdir(), "dsh-collab-sidecar-remote-"));
    roots.push(root);
    const content = Buffer.from("remote\n");
    const packageValue = snapshot("a".repeat(64), content);
    const fetcher = vi.fn(async (url: string, init: { headers: Record<string, string> }) => {
      expect(url).toContain("/collab/v1/rooms/room-1/workspace-snapshots/");
      expect(init.headers.authorization).toBe("Bearer transient-token");
      if (!url.includes("/files/")) return { status: 200, json: async () => ({ ok: true, data: { snapshot: packageValue } }) };
      return { status: 200, json: async () => ({ ok: true, data: { chunk: {
        snapshotId: packageValue.snapshotId,
        fileIndex: 0,
        offset: 0,
        byteLength: content.byteLength,
        chunkHash: sha256(content),
        data: content.toString("base64"),
        eof: true,
      } } }) };
    });
    const workspace = new DshLocalSidecarWorkspace({ root, local: () => undefined, fetch: fetcher });

    const prepared = await workspace.prepare({
      roomId: "room-1",
      requestedBy: "participant",
      roomEventSeq: 7,
      snapshotId: packageValue.snapshotId,
      remote: { gatewayEndpoint: "ws://192.168.1.10:4312/collab", roomToken: "transient-token" },
    });

    await expect(prepared.readFile("src/value.ts")).resolves.toEqual(content);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
