import { describe, expect, it, vi } from "vitest";
import {
  RepositoryInspector,
  createDshRepositoryCommandPort,
  type RepositoryCommandPort,
} from "../../src/repository-inspector.js";

function commandPort(outputs: Record<string, { exitCode: number; stdout?: string; stderr?: string }>) {
  const calls: string[][] = [];
  const port: RepositoryCommandPort = {
    async run(argv) {
      calls.push([...argv]);
      const output = outputs[argv.join(" ")];
      if (!output) throw new Error(`unexpected command: ${argv.join(" ")}`);
      return { exitCode: output.exitCode, stdout: output.stdout ?? "", stderr: output.stderr ?? "" };
    },
  };
  return { calls, port };
}

describe("RepositoryInspector", () => {
  it("describes staged and unstaged text, rename, binary and untracked changes", async () => {
    const { calls, port } = commandPort({
      "rev-parse --show-toplevel": { exitCode: 0, stdout: "C:/repo\n" },
      "--no-optional-locks status --short -z --untracked-files=all": {
        exitCode: 0,
        stdout: "M  staged.ts\0 M unstaged.ts\0A  added.ts\0D  deleted.ts\0R  renamed.ts\0old.ts\0 M binary.png\0?? untracked.ts\0",
      },
      "diff --no-ext-diff --no-textconv --numstat -z --cached": {
        exitCode: 0,
        stdout: ["5\t1\tstaged.ts", "10\t0\tadded.ts", "0\t4\tdeleted.ts", "0\t0\t", "old.ts", "renamed.ts", ""].join("\0"),
      },
      "diff --no-ext-diff --no-textconv --numstat -z": {
        exitCode: 0,
        stdout: ["2\t3\tunstaged.ts", "-\t-\tbinary.png", ""].join("\0"),
      },
    });

    const result = await new RepositoryInspector(port).inspect();

    expect(result).toEqual({
      kind: "repository",
      root: "C:/repo",
      files: [
        { path: "added.ts", staged: { kind: "added", additions: 10, deletions: 0, binary: false } },
        { path: "binary.png", unstaged: { kind: "modified", binary: true } },
        { path: "deleted.ts", staged: { kind: "deleted", additions: 0, deletions: 4, binary: false } },
        { path: "renamed.ts", previousPath: "old.ts", staged: { kind: "renamed", additions: 0, deletions: 0, binary: false } },
        { path: "staged.ts", staged: { kind: "modified", additions: 5, deletions: 1, binary: false } },
        { path: "unstaged.ts", unstaged: { kind: "modified", additions: 2, deletions: 3, binary: false } },
        { path: "untracked.ts", unstaged: { kind: "added" } },
      ],
      summary: { stagedFiles: 4, unstagedFiles: 3, additions: 17, deletions: 8, binaryFiles: 1 },
    });
    expect(calls).toEqual([
      ["rev-parse", "--show-toplevel"],
      ["--no-optional-locks", "status", "--short", "-z", "--untracked-files=all"],
      ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z", "--cached"],
      ["diff", "--no-ext-diff", "--no-textconv", "--numstat", "-z"],
    ]);
  });

  it("returns an explicit non-Git result and surfaces other Git failures", async () => {
    const outside = commandPort({
      "rev-parse --show-toplevel": { exitCode: 128, stderr: "fatal: not a git repository" },
    });
    await expect(new RepositoryInspector(outside.port).inspect()).resolves.toEqual({ kind: "not-git" });

    const failed = commandPort({
      "rev-parse --show-toplevel": { exitCode: 2, stderr: "fatal: unsafe repository" },
    });
    await expect(new RepositoryInspector(failed.port).inspect()).rejects.toThrow("unsafe repository");
  });

  it("binds DSH subprocess execution to the trusted Host Session cwd", async () => {
    const readFrom = vi.fn(() => ({ text: "ok", nextOffset: 2, lossy: false }));
    const spawn = vi.fn(() => ({
      collected: { stdout: { readFrom }, stderr: { readFrom: () => ({ text: "", nextOffset: 0, lossy: false }) } },
      done: Promise.resolve({ exitCode: 0, signal: null }),
    }));
    const resolveExecutable = vi.fn(async () => "C:/Git/bin/git.exe");
    const signal = new AbortController().signal;
    const port = createDshRepositoryCommandPort({
      subprocess: { resolveExecutable, spawn },
      cwd: "C:/trusted/session-workspace",
    });

    await expect(port.run(["status", "--short"], signal)).resolves.toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(resolveExecutable).toHaveBeenCalledWith("git", undefined, signal);
    expect(spawn).toHaveBeenCalledWith({
      argv: ["C:/Git/bin/git.exe", "status", "--short"],
      cwd: "C:/trusted/session-workspace",
      stdio: {
        stdin: "ignore",
        stdout: { maxBytes: 4 * 1024 * 1024 },
        stderr: { maxBytes: 64 * 1024 },
      },
      graceMs: 1_000,
      signal,
      env: { GIT_OPTIONAL_LOCKS: "0", LANG: "C", LC_ALL: "C" },
    });
    expect(readFrom).toHaveBeenCalledWith(0);
  });
});
