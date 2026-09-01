import { mkdtemp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DshCanonicalWorkspace, type DshCanonicalFileSystem } from "../../src/canonical-workspace.js";
import { RoomStore } from "../../src/room.js";
import { gitCommand, localDshSubprocess } from "../helpers/local-dsh-subprocess.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "dsh-collab-canonical-"));
  roots.push(root);
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/value.ts"), "old\n");
  await writeFile(join(root, "src/deleted.ts"), "delete me\n");
  await writeFile(join(root, "src/old-name.ts"), "rename me\n");
  const subprocess = localDshSubprocess();
  for (const args of [
    ["init"],
    ["config", "user.email", "collab@example.test"],
    ["config", "user.name", "Collab Test"],
    ["add", "--all"],
    ["commit", "--no-gpg-sign", "--no-verify", "-m", "baseline"],
  ]) {
    const result = await gitCommand(subprocess, root, args);
    if (result.exitCode !== 0) throw new Error(result.stderr);
  }
  const version = async (path: string): Promise<string | undefined> => {
    try {
      const info = await stat(path);
      return `${String(info.size)}:${String(info.mtimeMs)}`;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
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
    stat: async (target) => {
      const path = String(target.targetKey);
      const current = await version(path);
      if (current === undefined) return undefined;
      const value = await stat(path);
      return { version: current, type: value.isFile() ? "file" as const : value.isDirectory() ? "directory" as const : "other" as const, size: value.size };
    },
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
  };
  const rooms = new RoomStore();
  rooms.createRoom({ roomId: "room-1", hostId: "host", hostSessionId: "session-1", title: "Room", hostDisplayName: "Host", now: 1 });
  const workspace = new DshCanonicalWorkspace({
    rooms,
    sessions: { owns: () => true, workspacePath: () => root, followup() {}, steer() {}, cancel() {} },
    fs,
    subprocess,
  });
  return { root, subprocess, workspace, rooms, fs };
}

describe("DSH canonical workspace adapter", () => {
  it("uses DSH containment and byte reads for strict preflight inspection", async () => {
    const { workspace } = await setup();
    expect(await workspace.inspect("room-1", "src/value.ts")).toMatchObject({ size: 4 });
    expect(await workspace.inspect("room-1", "src/missing.ts")).toBeUndefined();
  });

  it("rejects traversal, Git metadata, and directories during preflight", async () => {
    const { workspace } = await setup();

    await expect(workspace.inspect("room-1", "../outside.ts")).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    await expect(workspace.inspect("room-1", ".git/config")).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
    await expect(workspace.inspect("room-1", "src")).rejects.toMatchObject({ code: "SNAPSHOT_INVALID" });
  });

  it("rejects applying a repository-root patch from a nested Session workspace", async () => {
    const { root, subprocess, rooms, fs } = await setup();
    const workspace = new DshCanonicalWorkspace({
      rooms,
      sessions: { owns: () => true, workspacePath: () => join(root, "src"), followup() {}, steer() {}, cancel() {} },
      fs,
      subprocess,
    });

    await expect(workspace.checkPatch("room-1", new TextEncoder().encode("not a patch\n")))
      .rejects.toMatchObject({ code: "ACTION_FORBIDDEN" });
  });

  it("applies one immutable Git patch for add, modify, delete, and rename without touching the index", async () => {
    const { root, subprocess, workspace } = await setup();
    await writeFile(join(root, "src/value.ts"), "new\n");
    await rm(join(root, "src/deleted.ts"));
    await rename(join(root, "src/old-name.ts"), join(root, "src/new-name.ts"));
    await writeFile(join(root, "src/added.ts"), "added\n");
    expect((await gitCommand(subprocess, root, ["add", "--all"])).exitCode).toBe(0);
    const rendered = await gitCommand(subprocess, root, [
      "diff", "--cached", "--find-renames=100%", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD", "--",
    ]);
    expect(rendered.exitCode).toBe(0);
    expect(rendered.stdout).toContain("rename from src/old-name.ts");

    expect((await gitCommand(subprocess, root, ["reset", "HEAD", "--"])).exitCode).toBe(0);
    await writeFile(join(root, "src/value.ts"), "old\n");
    await writeFile(join(root, "src/deleted.ts"), "delete me\n");
    await rename(join(root, "src/new-name.ts"), join(root, "src/old-name.ts"));
    await rm(join(root, "src/added.ts"));
    expect((await gitCommand(subprocess, root, ["diff", "--cached", "--name-only"])).stdout).toBe("");

    await workspace.applyPatch("room-1", new TextEncoder().encode(rendered.stdout));

    expect((await readFile(join(root, "src/value.ts"), "utf8")).replaceAll("\r\n", "\n")).toBe("new\n");
    expect((await readFile(join(root, "src/added.ts"), "utf8")).replaceAll("\r\n", "\n")).toBe("added\n");
    await expect(readFile(join(root, "src/deleted.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(root, "src/old-name.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect((await readFile(join(root, "src/new-name.ts"), "utf8")).replaceAll("\r\n", "\n")).toBe("rename me\n");
    expect((await gitCommand(subprocess, root, ["diff", "--cached", "--name-only"])).stdout).toBe("");
  });

  it("does not partially apply a multi-file patch when one target has changed", async () => {
    const { root, subprocess, workspace } = await setup();
    await writeFile(join(root, "src/second.ts"), "old second\n");
    expect((await gitCommand(subprocess, root, ["add", "src/second.ts"])).exitCode).toBe(0);
    expect((await gitCommand(subprocess, root, ["commit", "--no-gpg-sign", "--no-verify", "-m", "second baseline"])).exitCode).toBe(0);
    await writeFile(join(root, "src/value.ts"), "new first\n");
    await writeFile(join(root, "src/second.ts"), "new second\n");
    const rendered = await gitCommand(subprocess, root, ["diff", "--full-index", "--no-color", "--no-ext-diff", "--no-textconv", "HEAD", "--"]);
    expect(rendered.exitCode).toBe(0);
    await writeFile(join(root, "src/value.ts"), "old\n");
    await writeFile(join(root, "src/second.ts"), "owner edit\n");

    await expect(workspace.applyPatch("room-1", new TextEncoder().encode(rendered.stdout)))
      .rejects.toMatchObject({ code: "REQUEST_CONFLICT" });

    expect(await readFile(join(root, "src/value.ts"), "utf8")).toBe("old\n");
    expect(await readFile(join(root, "src/second.ts"), "utf8")).toBe("owner edit\n");
  });
});
