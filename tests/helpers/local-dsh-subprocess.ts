import { spawn as spawnChild } from "node:child_process";
import type { DshRepositorySubprocess } from "../../src/repository-inspector.js";

export function localDshSubprocess(): DshRepositorySubprocess {
  return {
    resolveExecutable: async (command) => command,
    spawn(spec) {
      const child = spawnChild(spec.argv[0]!, spec.argv.slice(1), {
        cwd: spec.cwd,
        env: { ...process.env, ...spec.env },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      let stdout = Buffer.alloc(0);
      let stderr = Buffer.alloc(0);
      child.stdout.on("data", (chunk: Buffer) => { stdout = Buffer.concat([stdout, chunk]); });
      child.stderr.on("data", (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]); });
      return {
        collected: {
          stdout: { readFrom: (offset) => ({ text: stdout.subarray(offset).toString("utf8"), lossy: false }) },
          stderr: { readFrom: (offset) => ({ text: stderr.subarray(offset).toString("utf8"), lossy: false }) },
        },
        done: new Promise((resolveDone, reject) => {
          child.once("error", reject);
          child.once("close", (exitCode, signal) => { resolveDone({ exitCode, signal }); });
        }),
      };
    },
  };
}

export function gitCommand(
  subprocess: DshRepositorySubprocess,
  cwd: string,
  argv: string[],
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const handle = subprocess.spawn({
    argv: ["git", ...argv],
    cwd,
    stdio: { stdin: "ignore", stdout: { maxBytes: 1024 * 1024 }, stderr: { maxBytes: 1024 * 1024 } },
    graceMs: 1_000,
  });
  return handle.done.then((outcome) => ({
    exitCode: outcome.exitCode,
    stdout: handle.collected.stdout!.readFrom(0).text,
    stderr: handle.collected.stderr!.readFrom(0).text,
  }));
}
