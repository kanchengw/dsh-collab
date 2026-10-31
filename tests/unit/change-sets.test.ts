import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChangeSetDraftService, ChangeSetDraftStore } from "../../src/change-sets.js";
import type { WorkspaceSnapshotFile, WorkspaceSnapshotPackage } from "../../src/collaboration-types.js";
import { RoomWorkspaceMaterializer, type RoomWorkspace } from "../../src/room-workspace.js";
import { WorkspaceSnapshotStore } from "../../src/workspace-snapshot-store.js";
import type { WorkspaceVersionArtifactStore, WorkspaceVersionFile, WorkspaceVersionRecord } from "../../src/workspace-versions.js";
import { gitCommand, localDshSubprocess } from "../helpers/local-dsh-subprocess.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function roomWorkspace(source: Record<string, Uint8Array | string>): Promise<{
  artifacts: WorkspaceSnapshotStore;
  workspace: RoomWorkspace;
}> {
  const artifactRoot = await mkdtemp(join(tmpdir(), "dsh-collab-changeset-artifacts-"));
  const roomRoot = await mkdtemp(join(tmpdir(), "dsh-collab-changeset-rooms-"));
  roots.push(artifactRoot, roomRoot);
  const artifacts = new WorkspaceSnapshotStore(artifactRoot);
  const contents = new Map(Object.entries(source).map(([path, value]) => [path, typeof value === "string" ? Buffer.from(value) : Buffer.from(value)]));
  const snapshotFiles: WorkspaceSnapshotFile[] = [...contents]
    .map(([path, content]) => ({ path, contentHash: sha256(content), size: content.byteLength, source: "tracked" as const }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const snapshot: WorkspaceSnapshotPackage = {
    snapshotId: "base-1",
    roomId: "room-1",
    hostSessionId: "session-owner",
    roomEventSeq: 1,
    headOid: "a".repeat(40),
    manifestHash: sha256(JSON.stringify(snapshotFiles)),
    files: snapshotFiles,
    createdAt: 10,
  };
  await artifacts.save(snapshot, contents);
  const versionFiles: WorkspaceVersionFile[] = snapshotFiles.map((file) => ({
    path: file.path,
    contentHash: file.contentHash,
    size: file.size,
    mode: contents.get(file.path)!.includes(0) ? "binary" : "text",
  }));
  const record: WorkspaceVersionRecord = {
    version: {
      workspaceVersionId: "base-1",
      roomId: "room-1",
      headOid: snapshot.headOid,
      files: versionFiles,
      createdBy: "owner",
      createdAt: 10,
    },
    manifestHash: sha256(JSON.stringify(versionFiles)),
    artifact: {
      kind: "workspace-snapshot.v1",
      snapshotId: "base-1",
      manifestHash: snapshot.manifestHash,
      totalBytes: versionFiles.reduce((total, file) => total + file.size, 0),
    },
  };
  const workspace = await new RoomWorkspaceMaterializer({ root: roomRoot, artifacts }).materialize({ roomId: "room-1", record });
  if (!source[".git/config"]) {
    const subprocess = localDshSubprocess();
    await gitCommand(subprocess, workspace.workspacePath, ["init", "--quiet"]);
    await gitCommand(subprocess, workspace.workspacePath, ["add", "--all"]);
    await gitCommand(subprocess, workspace.workspacePath, [
      "-c", "user.name=DSH Collab", "-c", "user.email=dsh-collab@localhost",
      "commit", "--quiet", "--no-gpg-sign", "--no-verify", "-m", "test baseline",
    ]);
  }
  return { artifacts, workspace };
}

function service(input: {
  artifacts: WorkspaceSnapshotStore;
  limits?: { maxFiles?: number; maxFileBytes?: number; maxTotalTextBytes?: number; maxManifestBytes?: number };
  now?: () => number;
}): ChangeSetDraftService {
  return new ChangeSetDraftService({
    artifacts: input.artifacts,
    subprocess: localDshSubprocess(),
    now: input.now ?? (() => 100),
    ...input.limits,
  });
}

describe("ChangeSet draft and immutable diff", () => {
  it("persists a deterministic add/modify/delete/exact-rename artifact with hashes and one unified diff", async () => {
    const fixture = await roomWorkspace({
      "README.md": "old\n",
      "delete.txt": "delete\n",
      "src/old.ts": "export const moved = true;\n",
      "unchanged.txt": "same\n",
    });
    await writeFile(join(fixture.workspace.workspacePath, "README.md"), "new\nmore\n");
    await rm(join(fixture.workspace.workspacePath, "delete.txt"));
    await rename(join(fixture.workspace.workspacePath, "src/old.ts"), join(fixture.workspace.workspacePath, "src/new.ts"));
    await writeFile(join(fixture.workspace.workspacePath, "added.txt"), "add\n");
    let now = 99;
    const drafts = service({ ...fixture, now: () => ++now });

    const first = await drafts.create({
      workspace: fixture.workspace,
      authorId: "participant-1",
      title: "Move module",
      summary: "Updates the sample files.",
    });
    expect(first.draft).toMatchObject({
      version: 1,
      roomId: "room-1",
      authorId: "participant-1",
      baseWorkspaceVersionId: "base-1",
      title: "Move module",
      summary: "Updates the sample files.",
      createdAt: 100,
      artifact: { kind: "changeset-draft.v1", artifactId: first.draft.draftId },
    });
    expect(first.draft.files).toEqual([
      {
        path: "README.md", operation: "modify",
        baseContentHash: sha256("old\n"), resultContentHash: sha256("new\nmore\n"),
        baseSize: 4, resultSize: 9,
        additions: 2, deletions: 1,
      },
      {
        path: "added.txt", operation: "add",
        resultContentHash: sha256("add\n"), resultSize: 4, additions: 1, deletions: 0,
      },
      {
        path: "delete.txt", operation: "delete",
        baseContentHash: sha256("delete\n"), baseSize: 7, additions: 0, deletions: 1,
      },
      {
        path: "src/new.ts", previousPath: "src/old.ts", operation: "rename",
        baseContentHash: sha256("export const moved = true;\n"),
        resultContentHash: sha256("export const moved = true;\n"),
        baseSize: 27, resultSize: 27, additions: 0, deletions: 0,
      },
    ]);
    expect(first.patch).toContain("diff --git a/README.md b/README.md");
    expect(first.patch).toContain("diff --git a/added.txt b/added.txt");
    expect(first.patch).toContain("deleted file mode");
    expect(first.patch).toContain("rename from src/old.ts");
    expect(first.patch).not.toContain(tmpdir());
    expect(first.draft.artifact.patchHash).toBe(sha256(first.patch));

    const stored = await new ChangeSetDraftStore(fixture.workspace.draftsPath).load(first.draft.draftId);
    expect(stored).toEqual(first);
    expect(await readdir(fixture.workspace.draftsPath)).toEqual([first.draft.draftId]);
    expect(await readFile(join(fixture.workspace.draftsPath, first.draft.draftId, "blobs", sha256("new\nmore\n")), "utf8")).toBe("new\nmore\n");
  }, 10_000);

  it("returns the first persisted draft when deterministic content is regenerated later", async () => {
    const fixture = await roomWorkspace({ "README.md": "old\n" });
    await writeFile(join(fixture.workspace.workspacePath, "README.md"), "new\n");
    let now = 99;
    const drafts = service({ ...fixture, now: () => ++now });
    const input = {
      workspace: fixture.workspace,
      authorId: "participant-1",
      title: "Retry",
      summary: "Same content",
    };

    const first = await drafts.create(input);
    const second = await drafts.create(input);

    expect(second).toEqual(first);
    expect(second.draft.createdAt).toBe(100);
  });

  it("restores persisted drafts after restart with the newest draft first", async () => {
    const fixture = await roomWorkspace({ "README.md": "old\n" });
    let now = 99;
    const drafts = service({ ...fixture, now: () => ++now });
    await writeFile(join(fixture.workspace.workspacePath, "README.md"), "first\n");
    const first = await drafts.create({ workspace: fixture.workspace, authorId: "participant-1", title: "First", summary: "First draft" });
    await writeFile(join(fixture.workspace.workspacePath, "README.md"), "second\n");
    const second = await drafts.create({ workspace: fixture.workspace, authorId: "participant-1", title: "Second", summary: "Second draft" });

    const restored = await new ChangeSetDraftStore(fixture.workspace.draftsPath).list();

    expect(restored.map(({ draft }) => draft.draftId)).toEqual([second.draft.draftId, first.draft.draftId]);
    expect(restored.map(({ draft }) => draft.title)).toEqual(["Second", "First"]);
  });

  it("removes a submitted draft without affecting other persisted drafts", async () => {
    const fixture = await roomWorkspace({ "README.md": "old\n" });
    let now = 99;
    const drafts = service({ ...fixture, now: () => ++now });
    await writeFile(join(fixture.workspace.workspacePath, "README.md"), "first\n");
    const first = await drafts.create({ workspace: fixture.workspace, authorId: "participant-1", title: "First", summary: "First draft" });
    await writeFile(join(fixture.workspace.workspacePath, "README.md"), "second\n");
    const second = await drafts.create({ workspace: fixture.workspace, authorId: "participant-1", title: "Second", summary: "Second draft" });
    const store = new ChangeSetDraftStore(fixture.workspace.draftsPath);

    await store.remove(second.draft.draftId);

    await expect(store.load(second.draft.draftId)).resolves.toBeUndefined();
    await expect(store.load(first.draft.draftId)).resolves.toEqual(first);
    await expect(store.remove(second.draft.draftId)).resolves.toBeUndefined();
  });

  it("uses manifest contents rather than local Git history and represents a modified rename as delete plus add", async () => {
    const fixture = await roomWorkspace({ "src/old.ts": "old\n" });
    await rm(join(fixture.workspace.workspacePath, "src/old.ts"));
    await writeFile(join(fixture.workspace.workspacePath, "src/new.ts"), "changed while moving\n");
    const subprocess = localDshSubprocess();
    await gitCommand(subprocess, fixture.workspace.workspacePath, ["add", "--all"]);
    await gitCommand(subprocess, fixture.workspace.workspacePath, ["-c", "user.name=Participant", "-c", "user.email=participant@localhost", "commit", "--no-gpg-sign", "--no-verify", "-m", "local commit"]);

    const result = await service(fixture).create({
      workspace: fixture.workspace,
      authorId: "participant-1",
      title: "Move and change",
      summary: "No heuristic rename.",
    });

    expect(result.draft.files.map(({ path, operation }) => ({ path, operation }))).toEqual([
      { path: "src/new.ts", operation: "add" },
      { path: "src/old.ts", operation: "delete" },
    ]);
  });

  it("excludes ignored local dependencies while retaining base and non-ignored files", async () => {
    const fixture = await roomWorkspace({ ".gitignore": "node_modules/\n", "README.md": "old\n" });
    await mkdir(join(fixture.workspace.workspacePath, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(fixture.workspace.workspacePath, "node_modules", "pkg", "cache.js"), "generated\n");
    await writeFile(join(fixture.workspace.workspacePath, "README.md"), "new\n");
    await writeFile(join(fixture.workspace.workspacePath, "notes.txt"), "include me\n");

    const result = await service(fixture).create({
      workspace: fixture.workspace, authorId: "participant-1", title: "Scoped", summary: "Exclude ignored files",
    });

    expect(result.draft.files.map((file) => file.path)).toEqual(["README.md", "notes.txt"]);
    expect(result.patch).not.toContain("node_modules");
  });

  it("creates a draft from a materialized workspace without a Git directory", async () => {
    const fixture = await roomWorkspace({ "README.md": "old\n" });
    await rm(join(fixture.workspace.workspacePath, ".git"), { recursive: true, force: true });
    await writeFile(join(fixture.workspace.workspacePath, "README.md"), "new\n");

    const result = await service(fixture).create({
      workspace: fixture.workspace, authorId: "participant-1", title: "No Git", summary: "Materialized workspace",
    });

    expect(result.draft.files).toEqual([expect.objectContaining({ path: "README.md", operation: "modify" })]);
  });

  it("does not guess rename pairings when identical content has multiple old and new paths", async () => {
    const fixture = await roomWorkspace({ "old/a.txt": "same\n", "old/b.txt": "same\n" });
    await rm(join(fixture.workspace.workspacePath, "old"), { recursive: true });
    await mkdir(join(fixture.workspace.workspacePath, "new"));
    await writeFile(join(fixture.workspace.workspacePath, "new/a.txt"), "same\n");
    await writeFile(join(fixture.workspace.workspacePath, "new/b.txt"), "same\n");

    const result = await service(fixture).create({
      workspace: fixture.workspace, authorId: "participant-1", title: "Ambiguous", summary: "Do not guess renames",
    });

    expect(result.draft.files.map(({ path, operation }) => ({ path, operation }))).toEqual([
      { path: "new/a.txt", operation: "add" },
      { path: "new/b.txt", operation: "add" },
      { path: "old/a.txt", operation: "delete" },
      { path: "old/b.txt", operation: "delete" },
    ]);
  });

  it("rejects binary, empty and bounded-resource drafts explicitly", async () => {
    const binary = await roomWorkspace({ "README.md": "old\n" });
    await writeFile(join(binary.workspace.workspacePath, "image.bin"), Buffer.from([0, 1, 2]));
    await expect(service(binary).create({
      workspace: binary.workspace, authorId: "participant-1", title: "Binary", summary: "Binary update",
    })).rejects.toThrow(/binary.*image\.bin/i);

    const unchanged = await roomWorkspace({ "README.md": "same\n" });
    await expect(service(unchanged).create({
      workspace: unchanged.workspace, authorId: "participant-1", title: "Empty", summary: "No changes",
    })).rejects.toThrow(/no changes/i);

    const reserved = await roomWorkspace({ ".git/config": "not a repository config\n" });
    await expect(service(reserved).create({
      workspace: reserved.workspace, authorId: "participant-1", title: "Reserved", summary: "Reject reserved paths",
    })).rejects.toThrow(/reserved.*\.git/i);

    const limited = await roomWorkspace({ "a.txt": "a\n", "b.txt": "b\n" });
    await writeFile(join(limited.workspace.workspacePath, "a.txt"), "aa\n");
    await writeFile(join(limited.workspace.workspacePath, "b.txt"), "bb\n");
    await expect(service({ ...limited, limits: { maxFiles: 1 } }).create({
      workspace: limited.workspace, authorId: "participant-1", title: "Many", summary: "Too many files",
    })).rejects.toThrow(/file count limit/i);
    await expect(service({ ...limited, limits: { maxFileBytes: 2 } }).create({
      workspace: limited.workspace, authorId: "participant-1", title: "Large", summary: "File too large",
    })).rejects.toThrow(/file size limit/i);
    await expect(service({ ...limited, limits: { maxTotalTextBytes: 6 } }).create({
      workspace: limited.workspace, authorId: "participant-1", title: "Total", summary: "Total too large",
    })).rejects.toThrow(/aggregate text limit/i);
    await expect(service({ ...limited, limits: { maxManifestBytes: 300 } }).create({
      workspace: limited.workspace, authorId: "participant-1", title: "Manifest", summary: "Manifest too large",
    })).rejects.toThrow(/manifest.*upload limit/i);
  });

  it("fails closed when a persisted draft manifest or result blob is modified", async () => {
    const fixture = await roomWorkspace({ "README.md": "old\n" });
    await writeFile(join(fixture.workspace.workspacePath, "README.md"), "new\n");
    const created = await service(fixture).create({
      workspace: fixture.workspace, authorId: "participant-1", title: "Tamper", summary: "Validate persisted data",
    });
    const directory = join(fixture.workspace.draftsPath, created.draft.draftId);
    const manifestPath = join(directory, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as { draft: { title: string } };
    manifest.draft.title = "tampered";
    await writeFile(manifestPath, JSON.stringify(manifest));

    await expect(new ChangeSetDraftStore(fixture.workspace.draftsPath).load(created.draft.draftId)).rejects.toThrow(/manifest/i);
  });

  it("rejects base artifact bytes that do not match the Workspace Version manifest", async () => {
    const fixture = await roomWorkspace({ "README.md": "old\n" });
    await writeFile(join(fixture.workspace.workspacePath, "README.md"), "new\n");
    const corrupted: WorkspaceVersionArtifactStore = {
      load: (snapshotId) => fixture.artifacts.load(snapshotId),
      readFile: async () => Buffer.from("wrong base\n"),
    };
    const drafts = new ChangeSetDraftService({ artifacts: corrupted, subprocess: localDshSubprocess(), now: () => 100 });

    await expect(drafts.create({
      workspace: fixture.workspace, authorId: "participant-1", title: "Corrupt", summary: "Reject corrupt base",
    })).rejects.toThrow(/base content.*README\.md/i);
  });
});
