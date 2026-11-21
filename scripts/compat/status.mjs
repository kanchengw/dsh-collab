#!/usr/bin/env node
/**
 * Read-only upstream compatibility status for dsh-collab.
 *
 * P0 scope:
 * - read compat/upstream.json
 * - find the latest upstream DSH tag
 * - compare it with the pinned tag
 * - report version-string drift, used DSH packages/imports, inject surfaces
 * - report changed upstream packages when a local deepseek-harness checkout is available
 *
 * This script never writes to the repository unless --out is passed.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const valueOf = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};

const jsonMode = has("--json");
const failOnDrift = has("--fail-on-drift");
const skipNpm = has("--no-npm");
const outFile = valueOf("--out") ? resolve(valueOf("--out")) : null;
const defaultLocalUpstream = existsSync("E:/projects/deepseek-harness") ? "E:/projects/deepseek-harness" : null;
const localUpstream = valueOf("--local-upstream") ? resolve(valueOf("--local-upstream")) : defaultLocalUpstream;
const upstreamRepo = "https://github.com/deepseek-ai/deepseek-harness.git";
const upstreamMirror = "https://ghfast.top/https://github.com/deepseek-ai/deepseek-harness.git";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: options.timeout ?? 30000,
    shell: options.shell ?? false,
  }).trim();
}

function tryRun(command, args, options = {}) {
  try {
    return { ok: true, value: run(command, args, options) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function git(args, cwd = root) {
  return run("git", args, { cwd });
}

function tryGit(args, cwd = root) {
  return tryRun("git", args, { cwd });
}

function parseTag(tag) {
  const match = tag.match(/^dsh-v(\d+)\.(\d+)\.(\d+)(?:-([a-z]+)\.?(\d+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? "",
    preNumber: Number(match[5] ?? 0),
  };
}

function preRank(pre) {
  if (!pre) return 4;
  if (pre === "alpha") return 1;
  if (pre === "beta") return 2;
  if (pre === "rc") return 3;
  return 0;
}

function compareTags(a, b) {
  const left = parseTag(a);
  const right = parseTag(b);
  if (!left || !right) return a.localeCompare(b);
  for (const key of ["major", "minor", "patch"]) {
    if (left[key] !== right[key]) return left[key] - right[key];
  }
  const rank = preRank(left.pre) - preRank(right.pre);
  if (rank !== 0) return rank;
  return left.preNumber - right.preNumber;
}

function tagVersion(tag) {
  return tag.replace(/^dsh-v/, "");
}

function listLocalTags(pattern) {
  const result = tryGit(["tag", "--list", pattern]);
  if (!result.ok) return { tags: [], error: result.error };
  return { tags: result.value.split(/\r?\n/).filter(Boolean), error: null };
}

function listRemoteTags(pattern) {
  const normalized = pattern.replace(/^refs\/tags\//, "");
  for (const remote of [upstreamRepo, upstreamMirror]) {
    const result = tryRun("git", ["ls-remote", "--tags", "--refs", remote]);
    if (!result.ok) continue;
    const tags = result.value
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => line.split("\t")[1] ?? "")
      .filter((ref) => ref.startsWith("refs/tags/"))
      .map((ref) => ref.slice("refs/tags/".length))
      .filter((tag) => tag.startsWith(normalized.replace(/\*$/, "")));
    if (tags.length > 0) return { tags, error: null, remote };
  }
  return { tags: [], error: "could not list remote tags" };
}

function resolveLocalCommit(tag) {
  const result = tryGit(["rev-list", "-n", "1", tag], localUpstream ?? root);
  return result.ok ? result.value : null;
}

function resolveRemoteCommit(tag) {
  for (const remote of [upstreamRepo, upstreamMirror]) {
    const result = tryRun("git", ["ls-remote", remote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
    if (!result.ok) continue;
    const lines = result.value.split(/\r?\n/).filter(Boolean);
    const peeled = lines.find((line) => line.endsWith(`refs/tags/${tag}^{}`));
    const direct = lines.find((line) => line.endsWith(`refs/tags/${tag}`));
    const line = peeled ?? direct;
    if (line) return line.split("\t")[0] ?? null;
  }
  return null;
}

function localTagDate(tag) {
  const result = tryGit(["for-each-ref", "--format=%(creatordate:iso8601)", `refs/tags/${tag}`], localUpstream ?? root);
  return result.ok && result.value ? result.value : null;
}

async function npmDistTags() {
  if (skipNpm) return { skipped: true };
  try {
    const response = await fetch("https://registry.npmjs.org/@deepseek-ai%2Fdsh-agent", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { error: `registry HTTP ${response.status}` };
    const data = await response.json();
    return data["dist-tags"] ?? {};
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function npmPublished(version) {
  if (skipNpm) return { skipped: true };
  try {
    const response = await fetch("https://registry.npmjs.org/@deepseek-ai%2Fdsh-agent", {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return { published: false, error: `registry HTTP ${response.status}` };
    const data = await response.json();
    return data.versions?.[version]
      ? { published: true, version }
      : { published: false, error: `version ${version} is not published` };
  } catch (error) {
    return { published: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function shouldSkipDir(rel, name) {
  if (["node_modules", "lib", "graphify-out", ".git", ".release", "dist", "coverage"].includes(name)) return true;
  if (rel === "e2e/.state" || rel.startsWith("e2e/.state/")) return true;
  if (name.startsWith(".") && name !== ".github") return true;
  if (/^\.(desktop|ui|visible|diag|tmp|codex)-/.test(name)) return true;
  return false;
}

function isTextFile(name) {
  return /\.(json|ya?ml|md|ts|tsx|mjs|js|ps1|sh|toml|txt)$/i.test(name);
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      if (!shouldSkipDir(rel, entry.name)) walk(full, files);
    } else if (entry.isFile() && isTextFile(entry.name)) {
      const size = statSync(full).size;
      if (size > 0 && size <= 1_000_000) files.push(rel);
    }
  }
  return files;
}

function fileKind(file) {
  if (file === "pnpm-lock.yaml") return "generated";
  if (file.startsWith("tests/")) return "test";
  if (file === "README.md" || file.startsWith("docs/")) return "doc";
  if (file.startsWith("e2e/")) return "e2e";
  if (file === "package.json" || file === "pnpm-workspace.yaml") return "manifest";
  return "source";
}

function parseInjectServices(text) {
  const services = new Set();
  for (const match of text.matchAll(/inject:\s*\[([^\]]*)\]/g)) {
    for (const part of match[1].split(",")) {
      const name = part.trim().replace(/^["']|["']$/g, "");
      if (name) services.add(name);
    }
  }
  return services;
}

function diffStat(path) {
  if (!localUpstream) return { skipped: true };
  const range = `${current.tag}..${latestTag}`;
  const stat = tryGit(["diff", "--stat", range, "--", path], localUpstream);
  if (!stat.ok) return { error: stat.error };
  const summary = stat.value.split(/\r?\n/).filter(Boolean).at(-1) ?? "";
  const match = summary.match(/(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/);
  const commits = tryGit(["rev-list", "--count", range, "--", path], localUpstream);
  return {
    files: match ? Number(match[1]) : summary.includes("file changed") ? 1 : 0,
    insertions: match ? Number(match[2] ?? 0) : 0,
    deletions: match ? Number(match[3] ?? 0) : 0,
    commits: commits.ok ? Number(commits.value) : null,
    summary,
  };
}

const configPath = join(root, "compat/upstream.json");
if (!existsSync(configPath)) {
  console.error("compat/upstream.json not found");
  process.exit(1);
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
const current = config.upstream;
const pattern = config.tracking?.tagPattern ?? "dsh-v0.2.*";

const localTags = localUpstream ? listLocalTags(pattern) : { tags: [], error: "no local checkout" };
const remoteTags = localTags.tags.length > 0 ? { tags: [], error: null } : listRemoteTags(pattern);
const allTags = [...new Set([...localTags.tags, ...remoteTags.tags])];
if (allTags.length === 0) {
  console.error("could not find upstream tags");
  process.exit(1);
}
const latestTag = allTags.sort(compareTags).at(-1);
const latestVersion = tagVersion(latestTag);
const latestCommit = localUpstream ? resolveLocalCommit(latestTag) : resolveRemoteCommit(latestTag);
const currentCommit = current.commit ?? (localUpstream ? resolveLocalCommit(current.tag) : resolveRemoteCommit(current.tag));
const latestDate = localUpstream ? localTagDate(latestTag) : null;
const distTags = await npmDistTags();
const published = await npmPublished(latestVersion);

const files = walk(root);
const versionOccurrences = [];
const packageUsage = new Map();
const importSpecifiers = new Map();
const injectServices = new Set();

for (const file of files) {
  let text;
  try {
    text = readFileSync(join(root, file), "utf8");
  } catch {
    continue;
  }
  const ignoredForDrift = file === "compat/upstream.json" || file === "dev_log.md";
  const count = ignoredForDrift ? 0 : text.split(current.npmVersion).length - 1;
  if (count > 0) versionOccurrences.push({ file, count, kind: fileKind(file) });
  for (const match of text.matchAll(/@deepseek-ai\/dsh-[a-z0-9-]+/g)) {
    const name = match[0];
    const entry = packageUsage.get(name) ?? { count: 0, files: new Set() };
    entry.count += 1;
    entry.files.add(file);
    packageUsage.set(name, entry);
  }
  for (const match of text.matchAll(/(?:from\s+|require\()\s*["'](@deepseek-ai\/dsh-[^"']+)["']/g)) {
    const name = match[1];
    const entry = importSpecifiers.get(name) ?? { count: 0, files: new Set() };
    entry.count += 1;
    entry.files.add(file);
    importSpecifiers.set(name, entry);
  }
  for (const service of parseInjectServices(text)) injectServices.add(service);
}

const packageJson = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const directPackages = (config.directPackages ?? []).map((name) => {
  const section = ["dependencies", "devDependencies", "peerDependencies"].find((key) => packageJson[key]?.[name]);
  return {
    name,
    section: section ?? null,
    current: section ? packageJson[section][name] : null,
    target: latestVersion,
  };
});
const clientInject = packageJson.dsh?.client?.inject ?? [];
for (const name of clientInject) injectServices.add(name);

const changedPackages = [];
for (const [name, path] of Object.entries(config.packagePaths ?? {})) {
  const stat = diffStat(path);
  if (!stat.skipped) changedPackages.push({ name, path, ...stat });
}

const totalDrift = versionOccurrences.reduce((sum, item) => sum + item.count, 0);
const drift = latestTag !== current.tag || totalDrift > 0;
const classification = !drift
  ? "clean"
  : changedPackages.some((item) => item.files > 0)
    ? "needs-scout"
    : "version-only";

const report = {
  generatedAt: new Date().toISOString(),
  repo: "kanchengw/dsh-collab",
  current: {
    tag: current.tag,
    version: current.npmVersion,
    commit: currentCommit,
    releasedAt: current.releasedAt ?? null,
  },
  latest: {
    tag: latestTag,
    version: latestVersion,
    commit: latestCommit,
    releasedAt: latestDate,
  },
  npm: {
    distTags,
    published,
  },
  drift,
  classification,
  recommendedTier: classification === "clean" ? "none" : classification === "version-only" ? "Tier 1 (verify)" : "Tier 2 (verify with Scout)",
  versionOccurrences: versionOccurrences.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file)),
  totalDrift,
  directPackages,
  usedPackages: [...packageUsage.entries()]
    .map(([name, value]) => ({ name, count: value.count, files: [...value.files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  importSpecifiers: [...importSpecifiers.entries()]
    .map(([name, value]) => ({ name, count: value.count, files: [...value.files].sort() }))
    .sort((a, b) => a.name.localeCompare(b.name)),
  injectServices: [...injectServices].sort(),
  changedPackages,
  warnings: [
    localTags.error ? `local tags: ${localTags.error}` : null,
    remoteTags.error ? `remote tags: ${remoteTags.error}` : null,
    distTags.error ? `npm dist-tags: ${distTags.error}` : null,
    published.error ? `npm publish check: ${published.error}` : null,
  ].filter(Boolean),
};

function table(headers, rows) {
  const line = `| ${headers.join(" | ")} |`;
  const separator = `| ${headers.map(() => "---").join(" | ")} |`;
  return [line, separator, ...rows.map((row) => `| ${row.join(" | ")} |`)].join("\n");
}

function markdown() {
  const lines = [];
  lines.push("# dsh-collab upstream compatibility report", "");
  lines.push(`Generated: ${report.generatedAt}`, "");
  lines.push("## Verdict", "");
  lines.push(`- Drift: **${report.drift ? "yes" : "no"}**`);
  lines.push(`- Classification: **${report.classification}**`);
  lines.push(`- Recommended tier: **${report.recommendedTier}**`);
  lines.push(`- Version-string drift: **${report.totalDrift} occurrences**`, "");
  lines.push("## Upstream", "");
  lines.push(table(["Item", "Current pin", "Latest upstream"], [
    ["Tag", current.tag, latestTag],
    ["Version", current.npmVersion, latestVersion],
    ["Commit", currentCommit ?? "unknown", latestCommit ?? "unknown"],
    ["Released", current.releasedAt ?? "unknown", latestDate ?? "unknown"],
  ]), "");
  lines.push("## npm", "");
  lines.push("```json");
  lines.push(JSON.stringify({ distTags, published }, null, 2));
  lines.push("```", "");
  lines.push("## Version-string drift", "");
  if (versionOccurrences.length === 0) {
    lines.push("No occurrences of the pinned version were found.", "");
  } else {
    lines.push(table(["File", "Kind", "Occurrences"], versionOccurrences.map((item) => [item.file, item.kind, String(item.count)])), "");
  }
  lines.push("## Direct DSH dependencies", "");
  lines.push(table(["Package", "Section", "Current", "Target"], directPackages.map((item) => [
    item.name, item.section ?? "-", item.current ?? "-", item.target,
  ])), "");
  lines.push("## DSH packages referenced", "");
  lines.push(table(["Package", "Occurrences", "Files"], report.usedPackages.map((item) => [
    item.name, String(item.count), String(item.files.length),
  ])), "");
  lines.push("## Import specifiers", "");
  if (report.importSpecifiers.length === 0) {
    lines.push("No direct DSH package imports were found.", "");
  } else {
    lines.push(table(["Specifier", "Occurrences", "Files"], report.importSpecifiers.map((item) => [
      item.name, String(item.count), String(item.files.length),
    ])), "");
  }
  lines.push("## Inject surfaces", "");
  if (report.injectServices.length === 0) {
    lines.push("No inject services were found.", "");
  } else {
    lines.push(report.injectServices.map((item) => `- \`${item}\``).join("\n"), "");
  }
  lines.push("## Changed upstream packages", "");
  if (changedPackages.length === 0) {
    lines.push("No local deepseek-harness checkout was available, or no mapped package changed.", "");
  } else {
    lines.push(table(["Package", "Path", "Files", "Insertions", "Deletions", "Commits"], changedPackages.map((item) => [
      item.name, `\`${item.path}\``, String(item.files), String(item.insertions), String(item.deletions), item.commits === null ? "-" : String(item.commits),
    ])), "");
  }
  if (report.warnings.length > 0) {
    lines.push("## Warnings", "");
    lines.push(report.warnings.map((item) => `- ${item}`).join("\n"), "");
  }
  lines.push("## Next steps", "");
  lines.push("- Scout: confirm the mapped package changes against the actual imports.");
  lines.push("- Planner: split the adaptation into workstreams and write `docs/plans/dsh-<version>-adaptation.md`.");
  lines.push("- Implementor: only after the plan is accepted.");
  lines.push("- Human: approve the draft PR; no auto-merge.");
  lines.push("");
  return lines.join("\n");
}

const output = jsonMode ? `${JSON.stringify(report, null, 2)}\n` : markdown();
if (outFile) {
  writeFileSync(outFile, output, "utf8");
  console.log(`wrote ${outFile}`);
} else {
  process.stdout.write(output);
}

if (failOnDrift && drift) process.exitCode = 2;
