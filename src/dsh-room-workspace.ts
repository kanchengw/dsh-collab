import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import type { RoomSessionLink, RoomSessionLinkStore } from "./room-session-links.js";
import type { RoomWorkspace } from "./room-workspace.js";
import { createDshRepositoryCommandPort, type DshRepositorySubprocess, type RepositoryCommandPort, type RepositoryCommandResult } from "./repository-inspector.js";
import { validateWorkspaceVersionRecord } from "./workspace-versions.js";

const BASELINE_COMMIT = "dsh-collab workspace baseline";

export interface DshRoomWorkspaceAgentRegistry {
  get(sessionId: string): { readonly session?: { readonly header?: { readonly cwd?: string } } } | undefined;
}

export interface DshNativeWorkspace {
  readonly id: string;
  readonly path: string;
  attachSession(sessionId: string): Promise<void>;
  detachSession(sessionId: string): Promise<void>;
}

export interface DshNativeWorkspaceRegistry {
  create(path: string): Promise<DshNativeWorkspace>;
  resolveByPath(path: string): Promise<DshNativeWorkspace | undefined>;
}

export interface RoomWorkspaceLookup {
  open(roomId: string): Promise<RoomWorkspace | undefined>;
}

function hash(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function failure(command: string, result: RepositoryCommandResult): Error {
  const detail = result.stderr.trim();
  return new Error(`git ${command} failed with exit code ${String(result.exitCode)}${detail === "" ? "" : `: ${detail}`}`);
}

async function requiredRun(commands: RepositoryCommandPort, argv: readonly string[]): Promise<RepositoryCommandResult> {
  const result = await commands.run(argv);
  if (result.exitCode !== 0) throw failure(argv.join(" "), result);
  return result;
}

async function canonical(path: string): Promise<string> {
  return await realpath(resolve(path));
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

async function workspaceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (directory === root && entry.name === ".git") continue;
      const path = resolve(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error("Room Workspace contains an unsupported symbolic link");
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files.push(relative(root, path).split(sep).join("/"));
      else throw new Error("Room Workspace contains an unsupported filesystem entry");
    }
  };
  await visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

async function assertUnchangedBase(workspace: RoomWorkspace): Promise<void> {
  const record = validateWorkspaceVersionRecord(workspace.record);
  const actual = await workspaceFiles(workspace.workspacePath);
  const expected = record.version.files.map((file) => file.path).sort((left, right) => left.localeCompare(right));
  if (actual.length !== expected.length || actual.some((path, index) => path !== expected[index])) {
    throw new Error("Room Workspace no longer matches its base version");
  }
  for (const file of record.version.files) {
    const content = await readFile(resolve(workspace.workspacePath, ...file.path.split("/")));
    if (content.byteLength !== file.size || hash(content) !== file.contentHash) {
      throw new Error("Room Workspace no longer matches its base version");
    }
  }
}

async function repositoryRoot(commands: RepositoryCommandPort): Promise<string | undefined> {
  const result = await commands.run(["rev-parse", "--show-toplevel"]);
  if (result.exitCode !== 0) {
    if (/not a git repository/i.test(result.stderr)) return undefined;
    throw failure("rev-parse --show-toplevel", result);
  }
  const root = result.stdout.trim();
  if (root === "") throw new Error("git rev-parse returned an empty repository root");
  return await canonical(root);
}

async function configValue(commands: RepositoryCommandPort, key: string): Promise<string | undefined> {
  const result = await commands.run(["config", "--local", "--get", key]);
  if (result.exitCode === 1) return undefined;
  if (result.exitCode !== 0) throw failure(`config --local --get ${key}`, result);
  return result.stdout.trim();
}

async function ensureSyntheticGitBaseline(workspace: RoomWorkspace, subprocess: DshRepositorySubprocess): Promise<void> {
  const commands = createDshRepositoryCommandPort({ subprocess, cwd: workspace.workspacePath });
  const workspaceRoot = await canonical(workspace.workspacePath);
  let root = await repositoryRoot(commands);
  if (root === undefined || !samePath(root, workspaceRoot)) {
    await assertUnchangedBase(workspace);
    await requiredRun(commands, ["init"]);
    root = await repositoryRoot(commands);
  }
  if (root === undefined || !samePath(root, workspaceRoot)) throw new Error("Synthetic Git repository does not belong to the Room Workspace");

  const expectedRoomId = workspace.roomId;
  const expectedVersionId = workspace.record.version.workspaceVersionId;
  const storedRoomId = await configValue(commands, "collab.roomid");
  const storedVersionId = await configValue(commands, "collab.workspaceversion");
  const head = await commands.run(["rev-parse", "--verify", "--quiet", "HEAD"]);
  if (head.exitCode === 0) {
    if (storedRoomId !== expectedRoomId || storedVersionId !== expectedVersionId) {
      throw new Error("Room Workspace Git baseline belongs to a different room or base version");
    }
    return;
  }
  if (head.exitCode !== 1) throw failure("rev-parse --verify HEAD", head);

  if ((storedRoomId !== undefined && storedRoomId !== expectedRoomId)
    || (storedVersionId !== undefined && storedVersionId !== expectedVersionId)) {
    throw new Error("Room Workspace Git baseline belongs to a different room or base version");
  }
  await assertUnchangedBase(workspace);
  await requiredRun(commands, ["config", "--local", "collab.roomid", expectedRoomId]);
  await requiredRun(commands, ["config", "--local", "collab.workspaceversion", expectedVersionId]);
  await requiredRun(commands, ["add", "--all"]);
  await requiredRun(commands, [
    "-c", "user.name=DSH Collab",
    "-c", "user.email=dsh-collab@localhost",
    "commit", "--allow-empty", "--no-gpg-sign", "--no-verify", "-m", BASELINE_COMMIT,
  ]);
}

export class DshRoomWorkspaceBindingService {
  constructor(private readonly options: {
    agents: DshRoomWorkspaceAgentRegistry;
    nativeWorkspaces: DshNativeWorkspaceRegistry;
    subprocess: DshRepositorySubprocess;
    roomWorkspaces: RoomWorkspaceLookup;
    links: RoomSessionLinkStore;
  }) {}

  async bind(input: { roomId: string; memberId: string; sessionId: string }): Promise<RoomSessionLink> {
    const workspace = await this.options.roomWorkspaces.open(input.roomId);
    if (!workspace) throw new Error("Room Workspace does not exist");
    const agent = this.options.agents.get(input.sessionId);
    if (!agent) throw new Error("The selected live native Session does not exist");
    const sessionCwd = agent.session?.header?.cwd;
    if (!sessionCwd) throw new Error("The selected native Session does not expose a cwd");
    const [workspacePath, cwd] = await Promise.all([canonical(workspace.workspacePath), canonical(sessionCwd)]);
    if (!samePath(workspacePath, cwd)) throw new Error("Native Session cwd does not match the Room Workspace");

    await ensureSyntheticGitBaseline(workspace, this.options.subprocess);
    const nativeWorkspace = await this.options.nativeWorkspaces.create(workspacePath);
    if (!samePath(await canonical(nativeWorkspace.path), workspacePath)) {
      throw new Error("DSH native Workspace resolved to a different path");
    }
    await nativeWorkspace.attachSession(input.sessionId);
    try {
      return this.options.links.bind({ ...input, workspacePath, sessionCwd: cwd });
    } catch (error) {
      await nativeWorkspace.detachSession(input.sessionId).catch(() => undefined);
      throw error;
    }
  }

  async unbind(sessionId: string): Promise<boolean> {
    const link = this.options.links.getBySession(sessionId);
    if (!link) return false;
    const nativeWorkspace = await this.options.nativeWorkspaces.resolveByPath(link.workspacePath);
    await nativeWorkspace?.detachSession(sessionId);
    return this.options.links.unbind(sessionId);
  }
}
