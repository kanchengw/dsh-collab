import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DshCanonicalWorkspace, type DshCanonicalFileSystem } from "../../src/canonical-workspace.js";
import { RoomStore } from "../../src/room.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-canonical-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/value.ts"), "old\n");
  const writeText = vi.fn(async (target: { targetKey: unknown }, content: string) => {
    const path = String(target.targetKey);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  });
  const fs: DshCanonicalFileSystem = {
    resolve: async (path, options) => {
      const target = resolve(options?.cwd ?? root, path);
      return { targetKey: target, displayPath: target };
    },
    contains: (parent, child) => {
      const path = relative(String(parent.targetKey), String(child.targetKey));
      return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
    },
    processPath: (target) => String(target.targetKey),
    lstat: async (path, options) => {
      try {
        const value = await stat(resolve(options?.cwd ?? root, path));
        return { type: value.isFile() ? "file" as const : value.isDirectory() ? "directory" as const : "other" as const };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    readBytes: async (target, _signal, maxBytes) => {
      const bytes = await readFile(String(target.targetKey));
      if (bytes.byteLength > maxBytes) throw new Error("too large");
      return bytes;
    },
    writeText,
  };
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", now: 1 });
  const workspace = new DshCanonicalWorkspace({
    rooms,
    sessions: { owns: () => true, workspacePath: () => root, followup() {}, steer() {}, cancel() {} },
    fs,
  });
  return { root, workspace, writeText };
}

describe("DSH canonical workspace adapter", () => {
  it("uses DSH containment, byte reads, and atomic writeText while exposing journal operations", async () => {
    const { root, workspace, writeText } = await setup();
    const bound = workspace.forRoom("room-1");

    expect(await workspace.inspect("room-1", "src/value.ts")).toMatchObject({ size: 4 });
    await bound.replace("src/value.ts", new TextEncoder().encode("new\n"));
    await bound.replace("src/added.ts", new TextEncoder().encode("added\n"));
    await bound.remove("src/value.ts");

    expect(writeText).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, "src/added.ts"), "utf8")).toBe("added\n");
    await expect(readFile(join(root, "src/value.ts"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects traversal, Git metadata, directories, and non-UTF-8 results", async () => {
    const { workspace } = await setup();
    const bound = workspace.forRoom("room-1");

    await expect(workspace.inspect("room-1", "../outside.ts")).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    await expect(workspace.inspect("room-1", ".git/config")).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    await expect(workspace.inspect("room-1", "src")).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    await expect(bound.replace("src/binary.ts", new Uint8Array([0xff]))).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
  });

  it("preserves an explicit UTF-8 byte-order mark through DSH writeText", async () => {
    const { root, workspace } = await setup();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]);

    await workspace.forRoom("room-1").replace("src/bom.ts", bytes);

    expect(await readFile(join(root, "src/bom.ts"))).toEqual(Buffer.from(bytes));
  });
});
