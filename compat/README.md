# compat

Read-only upstream compatibility tooling and the auditable compatibility pipeline
for `dsh-collab`.

## What it does

- Pins the current DSH baseline in `compat/upstream.json`.
- Finds the latest upstream `dsh-v0.2.*` tag.
- Reports version-string drift across the repository.
- Lists DSH packages, imports and inject surfaces used by this repository.
- Reports changed upstream packages when a local `deepseek-harness` checkout is available.
- Runs an auditable four-node pipeline: watch → plan → implement → review.

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

The pipeline is one workflow, `.github/workflows/compat-pipeline.yml`, with four
jobs. One workflow avoids the GitHub Actions rule that events created by
`GITHUB_TOKEN` do not trigger another workflow.

| Job | Trigger | Writes | Output |
|---|---|---|---|
| `watch` | schedule / manual | issue | compat report + upstream issue |
| `plan` | after watch | issue comment | `plan.md` + audit card |
| `implement` | after plan | branch + draft PR | diff + gates + audit card |
| `review` | after implement | PR review | review + audit card |

The branches and PRs are created by `GITHUB_TOKEN`; no PAT or bot account is
required. The repository setting **Allow GitHub Actions to create and approve
pull requests** must remain enabled.

## Audit model

Every node creates one run directory and records:

- `run.json`: role, run id, issue/PR, commit, model, provider, reasoning effort,
  prompt path + SHA-256, input paths + SHA-256, output paths + SHA-256, gates,
  timestamps, status and run URL.
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

- `planner.md`: read-only; creates workstreams, dependencies, gates, decisions and risks.
- `implementor.md`: writes only within the approved plan; records commands and gates.
- `reviewer.md`: fresh context; checks spec, scope, tests, docs, audit and security.

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
  so the pipeline is one workflow with dependent jobs rather than separate workflows.
- The Implementor may need a second run after W1 installs the target dependencies;
  the workflow records the first run's gate results and keeps the PR in draft.
