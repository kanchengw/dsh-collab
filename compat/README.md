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
  │    ├─ fresh typecheck / build / full tests on the PR branch
  │    ├─ PR review with findings, no code edits
  │    └─ approve | request_changes
  ├─ approve → awaiting-review, wait for human merge
  ├─ request_changes → Planner decides revision / replacement / blocked
  ├─ revision → same branch/PR
  ├─ replacement → new branch/PR; old PR superseded
  └─ blocked → agent:blocked + human arbitration
```

Role boundaries:

- **Planner** does not edit code, review code, or give line-level patches. It owns the decision between revision, replacement and blocked.
- **Implementor** does not plan, review, or receive raw Reviewer findings.
- **Reviewer** is read-only; it only returns `approve` or `request_changes` with findings/evidence, not fix instructions and not the revise/replan decision.

`request_changes` starts a new cycle. Planner may choose `revision` every time if it
believes the plan is converging; the workflow caps total attempts at three.
When Planner returns `blocked`, the loop stops immediately and asks a human to
arbitrate.

The scheduled run uses `dry_run=true` (watch + plan only). A manual
`workflow_dispatch` defaults to `dry_run=true`; set it to `false` to run the full
loop. Branches and PRs are created by `GITHUB_TOKEN`; no PAT or bot account is
required.

After a blocked run, a maintainer can comment `/resume [optional note]` on the
PR or issue. `.github/workflows/compat-resume.yml` reloads the previous plan,
review, gates, PR and diff, then starts Planner with `trigger=human_resume`.

## Audit model

Every node, on every attempt, creates one run directory under
`attempt-<n>/<role>/` and records:

- `run.json`: role, attempt, run id, issue/PR, commit, model, provider,
  reasoning effort, prompt path + SHA-256, input paths + SHA-256, output paths +
  SHA-256, gates, timestamps, status and run URL.
- `audit.md`: a human-readable audit card posted to the issue or PR.
- `output.json`: the node's structured JSON output, validated by
  `scripts/compat/audit.mjs`.
- `events.jsonl`: the Codex event stream.
- Gate logs and, for the Implementor, `diff.patch` and `git-log.txt`.

Artifacts are uploaded with `actions/upload-artifact`. The issue/PR comments are
the durable human-visible audit trail; Actions artifacts are the machine-readable
run bundle.

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

- GitHub-hosted runners cannot run the full DSH host/participant e2e yet; the
  Reviewer records `e2e: not_run` and the human must run `e2e/prepare.ps1` before merge.
- Pushes and label changes made with `GITHUB_TOKEN` do not trigger other workflows,
  so the pipeline is one workflow with a loop job rather than separate workflows.
- The Implementor installs target dependencies after editing; if `pnpm install`
  fails, the loop stops as an environment/dependency failure and requires a human.
- The scheduled run stays in `dry_run` mode until the loop is validated; enable
  full scheduled runs only after a manual full run is green.
