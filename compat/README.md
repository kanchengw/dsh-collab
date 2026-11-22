# compat

Read-only upstream compatibility tooling and the auditable compatibility pipeline
for `dsh-collab`.

## What it does

- Pins the current DSH baseline in `compat/upstream.json`.
- Finds the latest upstream `dsh-v0.2.*` tag.
- Reports version-string drift across the repository.
- Lists DSH packages, imports and inject surfaces used by this repository.
- Reports changed upstream packages when a local `deepseek-harness` checkout is available.
- Runs an auditable bounded loop: watch → (Planner → Implementor → Reviewer) × 3.

## What it does not do

- It does not merge to `main`.
- It does not bypass human review.
- It does not run the full DSH host/participant e2e in GitHub Actions yet.
- It does not decide that an adaptation is safe; it produces evidence for the pipeline nodes.

## Commands

```powershell
node scripts/compat/status.mjs
node scripts/compat/status.mjs --json
node scripts/compat/status.mjs --out compat-report.md
node scripts/compat/status.mjs --local-upstream E:\projects\deepseek-harness
```

Useful flags:

- `--json`: machine-readable output.
- `--out <file>`: write the selected output format to a file.
- `--no-npm`: skip npm registry checks.
- `--local-upstream <path>`: use a local deepseek-harness checkout for tag/date/diff data.
- `--fail-on-drift`: exit 2 when the pinned tag differs or version strings drift.

## Pipeline

One workflow: `.github/workflows/compat-pipeline.yml`.

```text
watch
  └─ create/update upstream issue + compat report

loop (max 3 attempts)
  ├─ Planner
  │    ├─ attempt 1: issue + compat report
  │    ├─ attempt 2+: previous plan + PR diff + Reviewer findings + gates
  │    └─ outputs status: planned | blocked and plan_kind: initial | revision | replacement
  ├─ Implementor
  │    └─ issue + chosen plan + compat report only
  ├─ Reviewer
  │    ├─ fresh typecheck / build / full tests / release check on the PR branch
  │    ├─ PR review with findings, no code edits
  │    └─ approve | request_changes
  ├─ approve → awaiting-review, wait for human review/merge
  ├─ request_changes → Planner decides revision / replacement / blocked
  ├─ revision → same branch/PR
  ├─ replacement → new branch/PR; old PR superseded
  └─ blocked → agent:blocked + human arbitration

review-only resumption
  ├─ skips Planner and Implementor on the existing PR
  ├─ runs Reviewer first
  └─ if changes are requested, continues with Planner → Implementor → Reviewer
```

Role boundaries:

- **Planner** does not edit code, review code, or give line-level patches. It owns the decision between revision, replacement and blocked.
- **Implementor** does not plan, review, or receive raw Reviewer findings.
- **Reviewer** is read-only; it only returns `approve` or `request_changes` with findings/evidence, not fix instructions and not the revise/replan decision.

### Human merge gate

GitHub-hosted runners cannot launch the interactive host/participant E2E. The
pipeline therefore treats that check as a **human merge gate**, not as a fourth
agent or a code defect:

- The Planner records the exact unrun command(s), required checkout/environment
  and human verifier in the plan.
- The Reviewer must show the gate in `unverified` and in a `## Human merge gate`
  section, but it does not return `request_changes` solely because an explicitly
  deferred runtime check has `e2e: not_run`.
- The Reviewer still blocks on failed or missing automated gates
  (`typecheck`, full tests, `build`, `release:check`), observed runtime failures,
  scope violations or code findings.
- A human must run the runtime gate before merge. The PR is never auto-merged.

When a blocked work item only needs a fresh review under updated rules, a
maintainer can comment `/resume review-only` on the blocked issue or PR. That
preflight runs the Reviewer directly on the existing PR without Planner or
Implementor. If the Reviewer approves, the work item becomes awaiting-review.
If it requests changes, the normal Planner → Implementor → Reviewer loop starts.

`request_changes` starts a new cycle. If the Implementor returns `blocked`, its
blocker report and diff are passed to the Planner for the next attempt; Planner
then decides revision / replacement / blocked. Planner may choose `revision`
every time if it believes the plan is converging; the workflow caps total attempts
at three. When Planner returns `blocked`, the loop stops immediately and asks a
human to arbitrate.

The scheduled run uses `dry_run=true` (watch + plan only). A manual
`workflow_dispatch` defaults to `dry_run=true`; set it to `false` to run the full
loop. Branches and PRs are created by `GITHUB_TOKEN`; no PAT or bot account is
required.

After a blocked run, a maintainer can comment `/resume [optional note]` on the
PR or issue. `.github/workflows/compat-resume.yml` reloads the previous plan,
review, gates, PR and diff, then starts Planner with `trigger=human_resume`.
Use `/resume review-only` when the code should not change and only an independent
Reviewer pass is needed. A normal resume is accepted only when the issue or linked
PR is labeled `agent:blocked`; review-only is accepted whenever the linked PR is
open, including after a new commit invalidates a prior `awaiting-review` result.
A normal resume can start from Planner even when no PR exists yet; review-only
requires an open PR. Resume reads the target Tag/Version from the issue body, so
an older compat issue keeps its pinned upstream even when a newer report exists.

When the Implementor reports `implemented` with no file changes, the workflow
treats the round as verification-only. It persists the approved plan into the
PR body's `compat:plan` block and continues to the Reviewer without
manufacturing a commit.

## Audit model

At loop start, the workflow copies the main-branch control plane
(`scripts/compat`, `compat/prompts`, `compat/schemas`, `compat/codex`) into
`control/`. Node prompts, schemas, audit validation and model configuration use
that snapshot, so resuming an old PR cannot silently fall back to stale
instructions or an older audit contract. Repository content under review
(including `compat/upstream.json`) still comes from the PR branch.

Every node, on every attempt, creates one run directory under
`attempt-<n>/<role>/` and records:

- `run.json`: role, attempt, run id, issue/PR, commit, model, provider,
  reasoning effort, prompt path + SHA-256, input paths + SHA-256, output paths +
  SHA-256, gates, timestamps, status and run URL.
- `audit.md`: a human-readable audit card retained in the artifact bundle.
- `output.json`: the node's structured JSON output, validated by
  `scripts/compat/audit.mjs`.
- `events.jsonl`: the Codex event stream.
- Gate logs and, for the Implementor, `diff.patch` and `blocked-diff.patch` when needed.
- `run-summary.json`: compact final metrics (duration, attempts, revisions,
  replacements, gates, blocked reason and links).

Artifacts are uploaded with `actions/upload-artifact`. The issue and PR each have
one editable dashboard comment (`<!-- compat:dashboard -->`); node logs and audit
cards are not posted as comments. The Reviewer's formal PR review is the only
per-verdict review. The PR body contains the visible plan summary and a hidden
plan marker used by resume.

## Ownership and review request

The repository owner is the human accountable owner:

- watcher-created issues are assigned to the repository owner;
- agent-created draft PRs are assigned to the repository owner;
- when the Reviewer approves, the PR is assigned to and a human review is requested
  from the repository owner before it becomes ready for review.

`Assignee` tracks responsibility for the work item. `Reviewer` is the GitHub review
request that can approve or request changes and can participate in branch
protection. The workflow Reviewer is an agent comment/reviewer artifact, not a
GitHub user approval.

## Ordinary PR CI

The repository CI job (`CI / verify`) is independent from the compatibility loop.
For a normal pull request it runs:

- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm release:check`

The compatibility loop separately publishes `compat/code-gates` on the PR head
after the Reviewer runs. That check covers the same code gates plus the
compatibility report and is used when a bot-created branch does not receive a
normal PR workflow run.

## Node contracts

Prompts live in `compat/prompts/`:

- `planner.md`: read-only; creates or revises the plan; consumes Reviewer findings as input; decides revision/replacement/blocked; does not edit code or give patches.
- `implementor.md`: writes only within the approved plan; does not plan or review; does not receive raw Reviewer findings.
- `reviewer.md`: fresh context and read-only; checks spec, scope, tests, docs, audit and security; returns only approve/request_changes with findings/evidence.

JSON schemas live in `compat/schemas/`. The pipeline validates required fields with
`scripts/compat/audit.mjs`; it does not rely on provider-specific structured-output
support.

## Labels

- `kind/upstream`
- `ready-for-agent`
- `plan-ready`
- `agent:review`
- `agent:blocked`
- `awaiting-review`
- `origin/internal`

The `watch` job creates/updates these labels idempotently.

## Model

`compat/codex/config.toml` configures the OpenAI-compatible provider:

- model: `deepseek-v4.1-flash-1017`
- provider: `qianwenai` (DashScope compatible mode)
- reasoning effort: `high`
- `DASHSCOPE_API_KEY` is supplied by the repository secret of the same name.

The model catalog is `compat/codex/model-catalog.json`.

## Limitations

- GitHub-hosted runners cannot run the full DSH host/participant e2e yet. It is
  recorded as a human merge gate; the Reviewer reports it as unverified and the
  human must run `e2e/prepare.ps1` and the two-client flow before merge.
- Pushes and label changes made with `GITHUB_TOKEN` do not trigger other workflows,
  so the pipeline is one workflow with a loop job rather than separate workflows.
  The loop publishes a `compat/code-gates` check run on the PR head after the
  Reviewer completes; ordinary CI remains a separate repository workflow and now
  includes `pnpm build`.
- The Implementor runs Codex with `danger-full-access` on the ephemeral GitHub
  runner because `workspace-write` was read-only in that environment. `GH_TOKEN`
  is removed from the Codex child environment; the workflow restores it for git,
  `gh` and label operations.
- The Implementor installs target dependencies after editing; if `pnpm install`
  fails, the loop stops as an environment/dependency failure and requires a human.
- The scheduled run stays in `dry_run` mode until the loop is validated; enable
  full scheduled runs only after a manual full run is green.
