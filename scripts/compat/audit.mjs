#!/usr/bin/env node
/**
 * Audit helpers for the dsh-collab compatibility pipeline.
 *
 * Each pipeline node creates one run directory:
 *   run.json       structured metadata
 *   audit.md       human-readable audit card
 *   output.json    validated node output
 *   gates.json     optional gate results
 *
 * Usage:
 *   node scripts/compat/audit.mjs init --role planner --issue 123 --out .compat-run
 *   node scripts/compat/audit.mjs finish --role planner --dir .compat-run --output output.json
 *   node scripts/compat/audit.mjs card --dir .compat-run
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const command = argv[0];
const has = (name) => argv.includes(name);
const valueOf = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const valuesOf = (name) => {
  const result = [];
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === name && argv[index + 1]) result.push(argv[index + 1]);
  }
  return result;
};

const roles = {
  watcher: {
    prompt: null,
    required: ["role", "status", "summary"],
  },
  planner: {
    prompt: "compat/prompts/planner.md",
    required: ["role", "status", "summary", "plan_markdown"],
  },
  implementor: {
    prompt: "compat/prompts/implementor.md",
    required: [
      "role", "status", "summary", "workstreams_completed", "files_changed",
      "commands_run", "gates", "residual_risks", "blockers", "pr_body_markdown",
    ],
  },
  reviewer: {
    prompt: "compat/prompts/reviewer.md",
    required: [
      "role", "verdict", "summary", "findings", "scope_check", "tests_check",
      "docs_check", "audit_check", "security_check", "unverified", "review_markdown",
    ],
  },
};

function fail(message) {
  console.error(message);
  process.exit(1);
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function safeRelative(path, base = root) {
  const rel = relative(base, resolve(path)).replaceAll("\\", "/");
  return rel.startsWith("..") ? resolve(path).split(/[\\/]/).pop() : rel;
}

function now() {
  return new Date().toISOString();
}

function readJson(path) {
  const raw = readFileSync(path, "utf8").trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error(`invalid JSON in ${path}`);
  }
}

function modelInfo() {
  const path = join(root, "compat/codex/config.toml");
  if (!existsSync(path)) return { model: null, provider: null, reasoningEffort: null };
  const text = readFileSync(path, "utf8");
  return {
    model: text.match(/^model\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    provider: text.match(/^name\s*=\s*"([^"]+)"/m)?.[1] ?? null,
    reasoningEffort: text.match(/^model_reasoning_effort\s*=\s*"([^"]+)"/m)?.[1] ?? null,
  };
}

function runUrl() {
  const server = process.env.GITHUB_SERVER_URL ?? "https://github.com";
  const repo = process.env.GITHUB_REPOSITORY ?? "kanchengw/dsh-collab";
  const runId = process.env.GITHUB_RUN_ID;
  return runId ? `${server}/${repo}/actions/runs/${runId}` : null;
}

function init() {
  const role = valueOf("--role");
  const out = valueOf("--out");
  if (!role || !roles[role]) fail("--role must be one of: watcher, planner, implementor, reviewer");
  if (!out) fail("--out is required");
  const dir = resolve(out);
  mkdirSync(dir, { recursive: true });
  const promptPath = roles[role].prompt ? join(root, roles[role].prompt) : null;
  const inputs = valuesOf("--input").map((path) => ({
    path: safeRelative(path),
    sha256: existsSync(resolve(path)) ? sha256File(resolve(path)) : null,
  }));
  const model = modelInfo();
  const run = {
    schemaVersion: 1,
    role,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    repository: process.env.GITHUB_REPOSITORY ?? "kanchengw/dsh-collab",
    issue: valueOf("--issue") ? Number(valueOf("--issue")) : null,
    pr: valueOf("--pr") ? Number(valueOf("--pr")) : null,
    event: process.env.GITHUB_EVENT_NAME ?? null,
    ref: process.env.GITHUB_REF ?? null,
    commit: valueOf("--commit") ?? process.env.GITHUB_SHA ?? null,
    actor: process.env.GITHUB_ACTOR ?? null,
    model: model.model,
    provider: model.provider,
    reasoningEffort: model.reasoningEffort,
    codexVersion: process.env.COMPAT_CODEX_VERSION ?? "0.142.5",
    prompt: promptPath ? { path: safeRelative(promptPath), sha256: sha256File(promptPath) } : null,
    startedAt: now(),
    finishedAt: null,
    status: "running",
    inputs,
    outputs: [],
    gates: {},
    runUrl: runUrl(),
    warnings: [],
  };
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  console.log(`audit initialized: ${dir}`);
}

function validateOutput(role, output) {
  const spec = roles[role];
  const missing = spec.required.filter((key) => output[key] === undefined || output[key] === null);
  if (missing.length > 0) fail(`output is missing required fields: ${missing.join(", ")}`);
  if (output.role !== role) fail(`output.role must be "${role}", got ${JSON.stringify(output.role)}`);
  if (role === "planner" && !["planned", "blocked"].includes(output.status)) fail("planner.status must be planned or blocked");
  if (role === "implementor" && !["implemented", "blocked"].includes(output.status)) fail("implementor.status must be implemented or blocked");
  if (role === "reviewer" && !["approve", "request_changes", "blocked"].includes(output.verdict)) fail("reviewer.verdict is invalid");
}

function card(run) {
  const lines = [];
  lines.push(`<!-- compat:audit role=${run.role} run=${run.runId ?? "local"} -->`);
  lines.push(`### ${run.role[0].toUpperCase()}${run.role.slice(1)} audit`);
  lines.push("");
  lines.push("| Field | Value |");
  lines.push("|---|---|");
  lines.push(`| Status | \`${run.status}\` |`);
  lines.push(`| Issue | ${run.issue ?? "-"} |`);
  lines.push(`| PR | ${run.pr ?? "-"} |`);
  lines.push(`| Run | ${run.runUrl ? `[${run.runId}](${run.runUrl})` : "-"} |`);
  lines.push(`| Commit | \`${run.commit ?? "-"}\` |`);
  lines.push(`| Model | \`${run.model ?? "-"}\` |`);
  lines.push(`| Provider | \`${run.provider ?? "-"}\` |`);
  lines.push(`| Reasoning | \`${run.reasoningEffort ?? "-"}\` |`);
  lines.push(`| Prompt | ${run.prompt ? `\`${run.prompt.path}\` sha256:\`${run.prompt.sha256.slice(0, 16)}…\`` : "-"} |`);
  lines.push("");
  if (run.inputs.length > 0) {
    lines.push("**Inputs**");
    for (const input of run.inputs) lines.push(`- \`${input.path}\`${input.sha256 ? ` sha256:\`${input.sha256.slice(0, 16)}…\`` : ""}`);
    lines.push("");
  }
  if (run.outputs.length > 0) {
    lines.push("**Outputs**");
    for (const output of run.outputs) lines.push(`- \`${output.path}\`${output.sha256 ? ` sha256:\`${output.sha256.slice(0, 16)}…\`` : ""}`);
    lines.push("");
  }
  if (Object.keys(run.gates).length > 0) {
    lines.push("**Gates**");
    lines.push("");
    lines.push("| Gate | Result |");
    lines.push("|---|---|");
    for (const [gate, result] of Object.entries(run.gates)) lines.push(`| ${gate} | \`${result}\` |`);
    lines.push("");
  }
  if (run.warnings.length > 0) {
    lines.push("**Warnings**");
    for (const warning of run.warnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  return lines.join("\n");
}

function finish() {
  const role = valueOf("--role");
  const dirArg = valueOf("--dir");
  const outputArg = valueOf("--output");
  if (!role || !roles[role]) fail("--role must be one of: watcher, planner, implementor, reviewer");
  if (!dirArg) fail("--dir is required");
  if (!outputArg) fail("--output is required");
  const dir = resolve(dirArg);
  const outputPath = resolve(outputArg);
  if (!existsSync(join(dir, "run.json"))) fail(`run.json not found in ${dir}`);
  if (!existsSync(outputPath)) fail(`output not found: ${outputPath}`);
  const run = readJson(join(dir, "run.json"));
  const output = readJson(outputPath);
  validateOutput(role, output);
  run.status = role === "reviewer" ? output.verdict : output.status;
  run.finishedAt = now();
  run.outputs = [{ path: safeRelative(outputPath, dir), sha256: sha256File(outputPath) }];
  const gatesArg = valueOf("--gates");
  if (gatesArg && existsSync(resolve(gatesArg))) {
    run.gates = readJson(resolve(gatesArg));
    run.outputs.push({ path: safeRelative(resolve(gatesArg), dir), sha256: sha256File(resolve(gatesArg)) });
  }
  if (role === "implementor" && Object.values(run.gates).some((value) => value === "fail")) {
    run.status = "blocked";
  }
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(run, null, 2)}\n`, "utf8");
  writeFileSync(join(dir, "audit.md"), `${card(run)}\n`, "utf8");
  console.log(`audit finished: ${dir}`);
}

function printCard() {
  const dirArg = valueOf("--dir");
  if (!dirArg) fail("--dir is required");
  const path = join(resolve(dirArg), "audit.md");
  if (!existsSync(path)) fail(`audit.md not found: ${path}`);
  process.stdout.write(readFileSync(path, "utf8"));
}

if (command === "init") init();
else if (command === "finish") finish();
else if (command === "card") printCard();
else fail("usage: audit.mjs <init|finish|card> ...");
