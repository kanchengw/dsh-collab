export type RepositoryChangeKind = "added" | "modified" | "deleted" | "renamed" | "type-changed" | "unmerged";

export interface RepositoryChange {
  kind: RepositoryChangeKind;
  additions?: number;
  deletions?: number;
  binary?: boolean;
}

export interface RepositoryFileChange {
  path: string;
  previousPath?: string;
  staged?: RepositoryChange;
  unstaged?: RepositoryChange;
}

export interface RepositoryDiff {
  path: string;
  layer: "staged" | "unstaged";
  patch: string;
}

export type RepositoryInspection =
  | { kind: "not-git" }
  | {
      kind: "repository";
      root: string;
      files: RepositoryFileChange[];
      summary: { stagedFiles: number; unstagedFiles: number; additions: number; deletions: number; binaryFiles: number };
    };

export interface RepositoryCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RepositoryCommandPort {
  run(argv: readonly string[], signal?: AbortSignal): Promise<RepositoryCommandResult>;
}

interface DiffStat {
  additions: number;
  deletions: number;
  binary: boolean;
}

function changeKind(code: string): RepositoryChangeKind | undefined {
  if (code === "A" || code === "?") return "added";
  if (code === "D") return "deleted";
  if (code === "R" || code === "C") return "renamed";
  if (code === "T") return "type-changed";
  if (code === "U") return "unmerged";
  if (code === "M") return "modified";
  return undefined;
}

function parseStatus(output: string): Map<string, RepositoryFileChange> {
  const records = output.split("\0");
  const files = new Map<string, RepositoryFileChange>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record === "") continue;
    if (record.length < 4 || record[2] !== " ") throw new Error("git status returned malformed porcelain output");
    const x = record[0]!;
    const y = record[1]!;
    const path = record.slice(3);
    const previousPath = x === "R" || x === "C" || y === "R" || y === "C" ? records[++index] : undefined;
    if (path === "" || previousPath === "") throw new Error("git status returned an empty path");
    const file: RepositoryFileChange = { path };
    if (previousPath !== undefined) file.previousPath = previousPath;
    if (x === "?" && y === "?") {
      file.unstaged = { kind: "added" };
    } else {
      const stagedKind = changeKind(x);
      const unstagedKind = changeKind(y);
      if (stagedKind) file.staged = { kind: stagedKind };
      if (unstagedKind) file.unstaged = { kind: unstagedKind };
    }
    files.set(path, file);
  }
  return files;
}

function parseDiffStats(output: string): Map<string, DiffStat> {
  const records = output.split("\0");
  const stats = new Map<string, DiffStat>();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (record === "") continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 1 || secondTab < firstTab + 2) throw new Error("git diff returned malformed numstat output");
    const additions = record.slice(0, firstTab);
    const deletions = record.slice(firstTab + 1, secondTab);
    let path = record.slice(secondTab + 1);
    if (path === "") {
      index += 2;
      path = records[index] ?? "";
    }
    if (path === "") throw new Error("git diff returned an empty path");
    const binary = additions === "-" && deletions === "-";
    if (!binary && (!/^\d+$/.test(additions) || !/^\d+$/.test(deletions))) {
      throw new Error("git diff returned malformed line counts");
    }
    stats.set(path, {
      additions: binary ? 0 : Number(additions),
      deletions: binary ? 0 : Number(deletions),
      binary,
    });
  }
  return stats;
}

function applyStats(change: RepositoryChange | undefined, stats: DiffStat | undefined): void {
  if (!change || !stats) return;
  change.binary = stats.binary;
  if (!stats.binary) {
    change.additions = stats.additions;
    change.deletions = stats.deletions;
  }
}

function failure(command: string, result: RepositoryCommandResult): Error {
  const detail = result.stderr.trim();
  return new Error(`git ${command} failed with exit code ${String(result.exitCode)}${detail === "" ? "" : `: ${detail}`}`);
}

export class RepositoryInspector {
  constructor(private readonly commands: RepositoryCommandPort) {}

  async inspect(signal?: AbortSignal): Promise<RepositoryInspection> {
    const root = await this.commands.run(["rev-parse", "--show-toplevel"], signal);
    if (root.exitCode !== 0) {
      if (/not a git repository/i.test(root.stderr)) return { kind: "not-git" };
      throw failure("rev-parse", root);
    }
    const repositoryRoot = root.stdout.trim();
    if (repositoryRoot === "") throw new Error("git rev-parse returned an empty repository root");

    const status = await this.commands.run(["--no-optional-locks", "status", "--short", "-z", "--untracked-files=all"], signal);
    if (status.exitCode !== 0) throw failure("status", status);
    const staged = await this.commands.run(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--cached"], signal);
    if (staged.exitCode !== 0) throw failure("diff --cached", staged);
    const unstaged = await this.commands.run(["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z"], signal);
    if (unstaged.exitCode !== 0) throw failure("diff", unstaged);

    const files = parseStatus(status.stdout);
    const stagedStats = parseDiffStats(staged.stdout);
    const unstagedStats = parseDiffStats(unstaged.stdout);
    for (const file of files.values()) {
      applyStats(file.staged, stagedStats.get(file.path));
      applyStats(file.unstaged, unstagedStats.get(file.path));
    }
    const ordered = [...files.values()].sort((left, right) => left.path.localeCompare(right.path));
    const binaryPaths = new Set(ordered.filter((file) => file.staged?.binary || file.unstaged?.binary).map((file) => file.path));
    return {
      kind: "repository",
      root: repositoryRoot,
      files: ordered,
      summary: {
        stagedFiles: ordered.filter((file) => file.staged).length,
        unstagedFiles: ordered.filter((file) => file.unstaged).length,
        additions: [...stagedStats.values(), ...unstagedStats.values()].reduce((total, stat) => total + stat.additions, 0),
        deletions: [...stagedStats.values(), ...unstagedStats.values()].reduce((total, stat) => total + stat.deletions, 0),
        binaryFiles: binaryPaths.size,
      },
    };
  }

  async diff(input: { path: string; layer: "staged" | "unstaged" }, signal?: AbortSignal): Promise<RepositoryDiff> {
    const inspection = await this.inspect(signal);
    const file = inspection.kind === "repository" ? inspection.files.find((candidate) => candidate.path === input.path) : undefined;
    if (!file?.[input.layer]) throw new Error("requested path and layer are not present in current Git changes");
    const argv = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--unified=0"];
    if (input.layer === "staged") argv.push("--cached");
    argv.push("--", input.path);
    const result = await this.commands.run(argv, signal);
    if (result.exitCode !== 0) throw failure(input.layer === "staged" ? "diff --cached" : "diff", result);
    return { path: input.path, layer: input.layer, patch: result.stdout };
  }
}

interface DshCollectedReader {
  readFrom(offset: number): { text: string; lossy: boolean };
}

export interface DshRepositorySubprocess {
  resolveExecutable(command: string, env?: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<string>;
  spawn(spec: {
    argv: readonly string[];
    cwd: string;
    stdio: { stdin: "ignore"; stdout: { maxBytes: number }; stderr: { maxBytes: number } };
    graceMs: number;
    signal?: AbortSignal;
    env?: Record<string, string>;
  }): {
    collected: { stdout?: DshCollectedReader; stderr?: DshCollectedReader };
    done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  };
}

export function createDshRepositoryCommandPort(input: {
  subprocess: DshRepositorySubprocess;
  cwd: string;
}): RepositoryCommandPort {
  return {
    async run(argv, signal): Promise<RepositoryCommandResult> {
      const executable = await input.subprocess.resolveExecutable("git", undefined, signal);
      const handle = input.subprocess.spawn({
        argv: [executable, ...argv],
        cwd: input.cwd,
        stdio: {
          stdin: "ignore",
          stdout: { maxBytes: 4 * 1024 * 1024 },
          stderr: { maxBytes: 64 * 1024 },
        },
        graceMs: 1_000,
        ...(signal ? { signal } : {}),
        env: { GIT_OPTIONAL_LOCKS: "0", LANG: "C", LC_ALL: "C" },
      });
      const outcome = await handle.done;
      const stdout = handle.collected.stdout?.readFrom(0);
      const stderr = handle.collected.stderr?.readFrom(0);
      if (!stdout || !stderr || stdout.lossy || stderr.lossy) throw new Error("git output exceeded Repository Inspector limits");
      if (outcome.exitCode === null) throw new Error(`git process ended by signal ${outcome.signal ?? "unknown"}`);
      return { exitCode: outcome.exitCode, stdout: stdout.text, stderr: stderr.text };
    },
  };
}
