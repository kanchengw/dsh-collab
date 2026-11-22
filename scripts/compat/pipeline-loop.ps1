param(
  [int]$MaxAttempts = 3
)

$ErrorActionPreference = "Stop"

$repo = $env:GITHUB_WORKSPACE
if (-not $repo) { throw "GITHUB_WORKSPACE is required" }
$issueNumber = $env:ISSUE_NUMBER
if (-not $issueNumber) { throw "ISSUE_NUMBER is required" }
$tag = $env:TAG
if (-not $tag) { throw "TAG is required" }
$version = $env:VERSION
$dryRun = $env:DRY_RUN -eq "true"
$resume = $env:RESUME -eq "true"
$reviewOnly = $env:REVIEW_ONLY -eq "true"
$startPlanRound = if ($env:PLAN_ROUND) { [int]$env:PLAN_ROUND } else { 1 }
$script:runStartedAt = Get-Date
$script:attemptsUsed = 0
$script:revisionCount = 0
$script:replacementCount = 0
$script:stage = "planning"
$script:lastGates = $null
$script:lastReviewSummary = $null
$script:blockedReason = $null
$script:lastPlan = $null
$runRoot = Join-Path $env:RUNNER_TEMP "compat-loop"
New-Item -ItemType Directory -Force $runRoot | Out-Null
Set-Location $repo
$controlRoot = Join-Path $runRoot "control"
New-Item -ItemType Directory -Force $controlRoot | Out-Null
Copy-Item (Join-Path $repo "scripts/compat") (Join-Path $controlRoot "scripts/compat") -Recurse -Force
Copy-Item (Join-Path $repo "compat/prompts") (Join-Path $controlRoot "compat/prompts") -Recurse -Force
Copy-Item (Join-Path $repo "compat/schemas") (Join-Path $controlRoot "compat/schemas") -Recurse -Force
Copy-Item (Join-Path $repo "compat/codex") (Join-Path $controlRoot "compat/codex") -Recurse -Force
$script:auditScript = Join-Path $controlRoot "scripts/compat/audit.mjs"
$script:promptRoot = Join-Path $controlRoot "compat/prompts"

$script:branch = "compat/dsh-" + ($tag -replace '^dsh-v','')
$script:pr = $null
$script:previousPlan = $null
$script:previousReview = $null
$script:previousGates = $null
$script:planKind = "initial"
$script:supersedesAttempt = $null
$script:planMode = "initial"
$script:planRound = 1
$script:trigger = "initial"
$script:humanInput = if ($env:HUMAN_INPUT_FILE -and (Test-Path -LiteralPath $env:HUMAN_INPUT_FILE)) { Get-Content $env:HUMAN_INPUT_FILE -Raw } elseif ($env:HUMAN_INPUT) { $env:HUMAN_INPUT } else { "" }
$script:plannerBlocked = $false
$script:implementorBlocked = $false
$script:reviewVerdict = $null
$script:previousImplementation = $null
$script:previousImplementationDiff = $null
$script:issueFile = Join-Path $runRoot "issue.md"
$script:reportFile = Join-Path $runRoot "compat-report.md"

function Write-Step {
  param([string]$Message)
  Write-Host "`n=== $Message ==="
}

function Invoke-AuditInit {
  param(
    [string]$Role,
    [string]$Dir,
    [int]$Attempt,
    [string[]]$Inputs = @()
  )
  $nodeArgs = @(
    $script:auditScript, "init",
    "--role", $Role,
    "--issue", $issueNumber,
    "--attempt", "$Attempt",
    "--commit", (git rev-parse HEAD),
    "--out", $Dir
  )
  if ($Role -eq "reviewer" -and $script:pr) { $nodeArgs += @("--pr", $script:pr) }
  foreach ($input in $Inputs) {
    if ($input -and (Test-Path -LiteralPath $input)) { $nodeArgs += @("--input", $input) }
  }
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "audit init failed for $Role attempt $Attempt" }
}

function Invoke-AuditFinish {
  param(
    [string]$Role,
    [string]$Dir,
    [string]$Output,
    [string]$Gates
  )
  $nodeArgs = @(
    $script:auditScript, "finish",
    "--role", $Role,
    "--dir", $Dir,
    "--output", $Output
  )
  if ($Gates -and (Test-Path -LiteralPath $Gates)) { $nodeArgs += @("--gates", $Gates) }
  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { throw "audit finish failed for $Role" }
}

function Set-Label {
  param([string]$Label, [switch]$Remove)
  if ($Remove) {
    gh issue edit $issueNumber --repo $env:GITHUB_REPOSITORY --remove-label $Label 2>$null
    if ($script:pr) { gh pr edit $script:pr --repo $env:GITHUB_REPOSITORY --remove-label $Label 2>$null }
  } else {
    gh issue edit $issueNumber --repo $env:GITHUB_REPOSITORY --add-label $Label
    if ($script:pr) { gh pr edit $script:pr --repo $env:GITHUB_REPOSITORY --add-label $Label }
  }
}

function Get-RunUrl {
  return "$env:GITHUB_SERVER_URL/$env:GITHUB_REPOSITORY/actions/runs/$env:GITHUB_RUN_ID"
}

function Get-DurationText {
  $elapsed = (Get-Date) - $script:runStartedAt
  if ($elapsed.TotalHours -ge 1) { return ('{0:hh\:mm\:ss}' -f $elapsed) }
  return ('{0:mm\:ss}' -f $elapsed)
}

function Get-GateText {
  if (-not $script:lastGates) { return "pending" }
  return (($script:lastGates.Keys | ForEach-Object { "$_ $($script:lastGates[$_])" }) -join " · ")
}

function Get-HumanGateText {
  if ($script:lastGates -and $script:lastGates.Contains("e2e") -and $script:lastGates["e2e"] -eq "not_run") {
    return "dual-client runtime E2E (human merge gate)"
  }
  return "-"
}

function Get-DashboardMarkdown {
  $prLink = if ($script:pr) { "https://github.com/$env:GITHUB_REPOSITORY/pull/$($script:pr)" } else { "-" }
  $reason = if ($script:blockedReason) { ($script:blockedReason -replace "`r?`n", " " -replace "\|", "\|") } else { "-" }
  return @(
    "<!-- compat:dashboard -->",
    "## Compatibility status",
    "",
    "| Field | Value |",
    "|---|---|",
    "| Status | ``$($script:stage)`` |",
    "| PR | $prLink |",
    "| Attempt | $($script:attemptsUsed) / $MaxAttempts |",
    "| Plan | ``$($script:planKind)`` |",
    "| Mode | $(if ($reviewOnly) { 'review-only preflight' } else { 'normal' }) |",
    "| Revision / replacement | $($script:revisionCount) / $($script:replacementCount) |",
    "| Duration | $(Get-DurationText) |",
    "| Gates | $(Get-GateText) |",
    "| Human gate | $(Get-HumanGateText) |",
    "| Blocked reason | $reason |",
    "",
    "Run: $(Get-RunUrl)"
  ) -join "`n"
}

function Update-Dashboard {
  param([ValidateSet("issue", "pr")][string]$Kind)
  $number = if ($Kind -eq "pr") { $script:pr } else { $issueNumber }
  if (-not $number) { return }
  $payloadFile = Join-Path $runRoot "dashboard-$Kind.json"
  @{ body = (Get-DashboardMarkdown) } | ConvertTo-Json -Depth 5 | Set-Content $payloadFile -Encoding UTF8
  $existingId = gh api --paginate "repos/$env:GITHUB_REPOSITORY/issues/$number/comments?per_page=100" --jq '.[] | select(.body | contains("<!-- compat:dashboard -->")) | .id' | Select-Object -First 1
  if ($existingId) {
    gh api --method PATCH "repos/$env:GITHUB_REPOSITORY/issues/comments/$existingId" --input $payloadFile | Out-Null
  } else {
    gh api --method POST "repos/$env:GITHUB_REPOSITORY/issues/$number/comments" --input $payloadFile | Out-Null
  }
  if ($LASTEXITCODE -ne 0) { throw "failed to update $Kind dashboard" }
}

function Publish-CheckRun {
  param(
    [string]$Conclusion,
    [string]$Title,
    [string]$Summary
  )
  if (-not $script:pr) { return }
  $sha = (gh pr view $script:pr --repo $env:GITHUB_REPOSITORY --json headRefOid --jq ".headRefOid" | Select-Object -Last 1).Trim()
  if (-not $sha) { return }
  $payload = @{
    name = "compat/code-gates"
    head_sha = $sha
    status = "completed"
    conclusion = $Conclusion
    details_url = (Get-RunUrl)
    output = @{ title = $Title; summary = $Summary }
  } | ConvertTo-Json -Depth 6
  $payloadFile = Join-Path $runRoot "check-run.json"
  $payload | Set-Content $payloadFile -Encoding UTF8
  gh api --method POST "repos/$env:GITHUB_REPOSITORY/check-runs" --input $payloadFile | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "failed to publish compat/code-gates check run" }
}

function Switch-ToReplacementBranch {
  param([int]$Attempt)
  $oldPr = $script:pr
  if ($oldPr) {
    gh pr close $oldPr --repo $env:GITHUB_REPOSITORY --comment "Superseded by a replacement plan on attempt ${Attempt}. The previous plan is obsolete; a new PR will follow." 2>$null
  }
  $script:pr = $null
  $script:branch = "compat/dsh-" + ($tag -replace '^dsh-v','') + "-replacement-$Attempt-" + $env:GITHUB_RUN_ID
  git reset --hard HEAD
  if ($LASTEXITCODE -ne 0) { throw "failed to reset workspace for replacement branch" }
  git clean -fd
  if ($LASTEXITCODE -ne 0) { throw "failed to clean workspace for replacement branch" }
  git fetch origin main
  if ($LASTEXITCODE -ne 0) { throw "failed to fetch main for replacement branch" }
  git checkout -B $script:branch origin/main
  if ($LASTEXITCODE -ne 0) { throw "failed to create replacement branch $script:branch" }
  $script:stage = "implementing"
  Update-Dashboard -Kind issue
}

function Invoke-Planner {
  param([int]$Attempt)
  Write-Step "Attempt $Attempt / Planner"
  $dir = Join-Path $runRoot "attempt-$Attempt/planner"
  New-Item -ItemType Directory -Force $dir | Out-Null
  $promptFile = Join-Path $dir "prompt.md"
  $inputs = @(
    $script:issueFile,
    $script:reportFile,
    (Join-Path $script:promptRoot "planner.md")
  )
  $planModeInstruction = if ($script:planMode -eq "initial") {
    "This is the initial plan. Output plan_kind: initial."
  } else {
    "Decide whether to revise, replace or block. Output plan_kind: revision or replacement, or status: blocked. You may revise every time if you believe the plan is converging; there is no forced replacement."
  }
  $parts = @(
    (Get-Content (Join-Path $script:promptRoot "planner.md") -Raw),
    "`n`n## Issue`n`n" + (Get-Content $script:issueFile -Raw),
    "`n`n## Compatibility report`n`n" + (Get-Content $script:reportFile -Raw),
    "`n`n## Plan mode`n`nplan_mode: $($script:planMode)`nplan_round: $($script:planRound)`ntrigger: $($script:trigger)`nhuman_input: $($script:humanInput)`nsupersedes_attempt: $($script:supersedesAttempt)`n`n" + $planModeInstruction
  )
  if ($script:previousPlan) {
    $previousPlanFile = Join-Path $dir "previous-plan.md"
    $script:previousPlan | Set-Content $previousPlanFile -Encoding UTF8
    $inputs += $previousPlanFile
    $parts += "`n`n## Previous plan`n`n" + $script:previousPlan
  }
  if ($script:previousReview) {
    $inputs += $script:previousReview
    $parts += "`n`n## Previous reviewer findings`n`n" + (Get-Content $script:previousReview -Raw)
  }
  if ($script:previousGates) {
    $inputs += $script:previousGates
    $parts += "`n`n## Previous gate results`n`n" + (Get-Content $script:previousGates -Raw)
  }
  if ($script:previousImplementation) {
    $inputs += $script:previousImplementation
    $parts += "`n`n## Previous implementor blocker`n`n" + (Get-Content $script:previousImplementation -Raw)
  }
  if ($script:previousImplementationDiff) {
    $inputs += $script:previousImplementationDiff
    $parts += "`n`n## Previous implementor diff`n`n" + (Get-Content $script:previousImplementationDiff -Raw)
  }
  if ($script:pr) {
    $diffFile = Join-Path $dir "pr.diff"
    gh pr diff $script:pr --repo $env:GITHUB_REPOSITORY > $diffFile
    $inputs += $diffFile
    $parts += "`n`n## Current PR diff`n`n" + (Get-Content $diffFile -Raw)
  }
  ($parts -join "") | Set-Content $promptFile -Encoding UTF8
  $inputs += $promptFile
  Invoke-AuditInit -Role "planner" -Dir $dir -Attempt $Attempt -Inputs $inputs
  $output = Join-Path $dir "output.json"
  (Get-Content $promptFile -Raw) | codex exec - --strict-config --sandbox read-only --cd $repo --output-last-message $output --json *> (Join-Path $dir "events.jsonl")
  if ($LASTEXITCODE -ne 0) { throw "planner failed on attempt $Attempt" }
  Invoke-AuditFinish -Role "planner" -Dir $dir -Output $output
  $plan = Get-Content $output -Raw | ConvertFrom-Json
  if ($plan.status -eq "blocked") {
    $script:blockedReason = $plan.summary
    $script:stage = "blocked"
    Update-Dashboard -Kind issue
    if ($script:pr) { Update-Dashboard -Kind pr }
    $script:plannerBlocked = $true
    return
  }
  $script:plannerBlocked = $false
  $script:blockedReason = $null
  if ($plan.plan_kind -notin @("initial", "revision", "replacement")) {
    throw "planner returned invalid plan_kind: $($plan.plan_kind)"
  }
  if ($script:planMode -eq "initial" -and $plan.plan_kind -ne "initial") {
    throw "planner must return plan_kind=initial in initial mode"
  }
  if ($script:planMode -eq "decide" -and $plan.plan_kind -eq "initial") {
    throw "planner must not return plan_kind=initial in decide mode"
  }
  $script:planKind = $plan.plan_kind
  if ($plan.supersedes_attempt) { $script:supersedesAttempt = [int]$plan.supersedes_attempt }
  $script:previousPlan = $plan.plan_markdown
  $script:lastPlan = $plan
  $script:lastGates = $null
  $planFile = Join-Path $dir "plan.md"
  $plan.plan_markdown | Set-Content $planFile -Encoding UTF8
  if ($plan.plan_kind -eq "revision") { $script:revisionCount++ }
  if ($plan.plan_kind -eq "replacement") { $script:replacementCount++ }
  $script:stage = "implementing"
  gh issue edit $issueNumber --repo $env:GITHUB_REPOSITORY --remove-label ready-for-agent --add-label plan-ready 2>$null
  if ($plan.plan_kind -eq "replacement") { Switch-ToReplacementBranch -Attempt $Attempt }
  Update-Dashboard -Kind issue
  if ($script:pr) { Update-Dashboard -Kind pr }
  return $true
}

function Invoke-Implementor {
  param([int]$Attempt)
  Write-Step "Attempt $Attempt / Implementor"
  $script:previousImplementation = $null
  $script:previousImplementationDiff = $null
  $dir = Join-Path $runRoot "attempt-$Attempt/implementor"
  New-Item -ItemType Directory -Force $dir | Out-Null
  $planFile = Join-Path $runRoot "attempt-$Attempt/planner/plan.md"
  if (-not (Test-Path -LiteralPath $planFile)) { throw "approved plan not found: $planFile" }
  $promptFile = Join-Path $dir "prompt.md"
  $inputs = @(
    $script:issueFile,
    $planFile,
    $script:reportFile,
    (Join-Path $script:promptRoot "implementor.md")
  )
  $planModeInstruction = if ($script:planKind -eq "revision") {
    "This is a revision. Preserve unaffected work; apply only the delta described in the plan."
  } elseif ($script:planKind -eq "replacement") {
    "This is a replacement. The previous plan and its implementation are obsolete. The workflow gives you a fresh branch from main; do not reuse the old approach."
  } else {
    "This is the initial plan."
  }
  $prompt = (Get-Content (Join-Path $script:promptRoot "implementor.md") -Raw) +
    "`n`n## Issue`n`n" + (Get-Content $script:issueFile -Raw) +
    "`n`n## Approved plan`n`n" + (Get-Content $planFile -Raw) +
    "`n`n## Compatibility report`n`n" + (Get-Content $script:reportFile -Raw) +
    "`n`n## Plan mode`n`nplan_kind: $($script:planKind)`n`n" + $planModeInstruction
  $prompt | Set-Content $promptFile -Encoding UTF8
  $inputs += $promptFile
  Invoke-AuditInit -Role "implementor" -Dir $dir -Attempt $Attempt -Inputs $inputs
  $output = Join-Path $dir "output.json"
  $savedGhToken = $env:GH_TOKEN
  Remove-Item Env:GH_TOKEN -ErrorAction SilentlyContinue
  try {
    (Get-Content $promptFile -Raw) | codex exec - --strict-config --sandbox danger-full-access --cd $repo --output-last-message $output --json *> (Join-Path $dir "events.jsonl")
    $codexExit = $LASTEXITCODE
  } finally {
    if ($savedGhToken) { $env:GH_TOKEN = $savedGhToken }
  }
  if ($codexExit -ne 0) { throw "implementor failed on attempt $Attempt" }
  Invoke-AuditFinish -Role "implementor" -Dir $dir -Output $output
  $impl = Get-Content $output -Raw | ConvertFrom-Json
  if ($impl.status -eq "blocked") {
    $blockedFile = Join-Path $dir "blocked.md"
    $impl.summary | Set-Content $blockedFile -Encoding UTF8
    git add -N -- . 2>$null
    $blockedDiff = Join-Path $dir "blocked-diff.patch"
    git diff > $blockedDiff
    git status --porcelain > (Join-Path $dir "blocked-status.txt")
    $script:previousImplementation = $blockedFile
    $script:previousImplementationDiff = $blockedDiff
    $script:blockedReason = $impl.summary
    $script:stage = "blocked"
    $script:trigger = "implementation_blocked"
    Update-Dashboard -Kind issue
    if ($script:pr) { Update-Dashboard -Kind pr }
    $script:implementorBlocked = $true
    return
  }
  $script:implementorBlocked = $false

  git add -N -- . 2>$null
  git diff > (Join-Path $dir "diff.patch")
  git status --porcelain > (Join-Path $dir "status.txt")

  pnpm install --no-frozen-lockfile --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw "pnpm install failed on attempt $Attempt" }
  pnpm rebuild esbuild
  if ($LASTEXITCODE -ne 0) { throw "pnpm rebuild esbuild failed on attempt $Attempt" }

  $gates = [ordered]@{ typecheck = "not_run"; tests = "not_run"; build = "not_run"; release = "not_run"; e2e = "not_run" }
  node node_modules/typescript/bin/tsc --noEmit *> (Join-Path $dir "typecheck.log")
  $gates.typecheck = if ($LASTEXITCODE -eq 0) { "pass" } else { "fail" }
  node node_modules/vitest/vitest.mjs run tests/unit/manifest.test.ts tests/unit/dsh-local-agent.test.ts tests/unit/dsh-current-primitives.test.ts tests/unit/e2e-environment.test.ts *> (Join-Path $dir "tests.log")
  $gates.tests = if ($LASTEXITCODE -eq 0) { "pass" } else { "fail" }
  pnpm build *> (Join-Path $dir "build.log")
  $gates.build = if ($LASTEXITCODE -eq 0) { "pass" } else { "fail" }
  pnpm release:check *> (Join-Path $dir "release-check.log")
  $gates.release = if ($LASTEXITCODE -eq 0) { "pass" } else { "fail" }
  $gatesFile = Join-Path $dir "gates.json"
  $gates | ConvertTo-Json | Set-Content $gatesFile -Encoding UTF8
  $script:lastGates = $gates
  Invoke-AuditFinish -Role "implementor" -Dir $dir -Output $output -Gates $gatesFile

  git add -N -- . 2>$null
  git diff > (Join-Path $dir "diff.patch")
  git status --porcelain > (Join-Path $dir "status.txt")

  $changed = git status --porcelain
  if (-not $changed) {
    $message = "Implementor produced no commit on attempt ${Attempt}."
    $blockedFile = Join-Path $dir "blocked.md"
    $message | Set-Content $blockedFile -Encoding UTF8
    $script:previousImplementation = $blockedFile
    $script:previousImplementationDiff = Join-Path $dir "diff.patch"
    $script:blockedReason = $message
    $script:stage = "blocked"
    $script:trigger = "implementation_blocked"
    Update-Dashboard -Kind issue
    if ($script:pr) { Update-Dashboard -Kind pr }
    $script:implementorBlocked = $true
    return
  }

  git config user.name "github-actions[bot]"
  git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
  git add -A
  git commit -m "compat: adapt to $tag (attempt $Attempt)"
  if ($LASTEXITCODE -ne 0) { throw "git commit failed on attempt $Attempt" }
  git push origin $script:branch
  if ($LASTEXITCODE -ne 0) { throw "git push failed on attempt $Attempt" }

  $planText = Get-Content $planFile -Raw
  $planSummary = if ($script:lastPlan -and $script:lastPlan.summary) { $script:lastPlan.summary } else { "See the plan artifact for details." }
  $workstreamLines = @()
  if ($script:lastPlan -and $script:lastPlan.workstreams) {
    $workstreamLines += "| Workstream | Goal | Files |"
    $workstreamLines += "|---|---|---|"
    foreach ($ws in @($script:lastPlan.workstreams)) {
      $workstreamLines += "| $($ws.id) | $($ws.goal) | $(@($ws.files) -join ', ') |"
    }
  }
  $filesText = if ($impl.files_changed) { (@($impl.files_changed) -join ', ') } else { "-" }
  $gateLines = @(
    "| Gate | Result |",
    "|---|---|",
    "| typecheck | ``$($gates.typecheck)`` |",
    "| tests | ``$($gates.tests)`` |",
    "| build | ``$($gates.build)`` |",
    "| release | ``$($gates.release)`` |",
    "| e2e | ``$($gates.e2e)`` |"
  )
  $humanGate = if ($gates.e2e -eq "not_run") { "`n## Human merge gate`n`nDual-client runtime E2E is not run by GitHub-hosted Actions. A human must run the documented E2E before merge." } else { "" }
  $prBodyText = "Closes #$issueNumber`n`n## Plan`n`n$planSummary`n`n" +
    (($workstreamLines -join "`n")) + "`n`n## Implementation`n`n$($impl.summary)`n`nFiles: $filesText`n`n## Gates`n`n" +
    ($gateLines -join "`n") + $humanGate + "`n`n<!-- compat:plan`n$planText`n-->`n"
  $prBody = Join-Path $dir "pr-body.md"
  $prBodyText | Set-Content $prBody -Encoding UTF8
  $existing = gh pr list --repo $env:GITHUB_REPOSITORY --head $script:branch --state open --json number,url | ConvertFrom-Json | Select-Object -First 1
  if ($existing) {
    $script:pr = [string]$existing.number
    gh pr edit $script:pr --repo $env:GITHUB_REPOSITORY --title "compat: adapt to $tag" --body-file $prBody
  } else {
    $prUrl = (gh pr create --repo $env:GITHUB_REPOSITORY --draft --base main --head $script:branch --title "compat: adapt to $tag" --body-file $prBody | Select-Object -Last 1).Trim()
    $script:pr = ($prUrl -split '/')[-1]
  }
  if (-not $script:pr) { throw "could not create or find PR for $script:branch" }

  $script:stage = "reviewing"
  Set-Label "agent:blocked" -Remove
  Set-Label "agent:review"
  Update-Dashboard -Kind issue
  Update-Dashboard -Kind pr
  return $true
}

function Invoke-Reviewer {
  param([int]$Attempt)
  Write-Step "Attempt $Attempt / Reviewer"
  if (-not $script:pr) { throw "no PR to review on attempt $Attempt" }
  $dir = Join-Path $runRoot "attempt-$Attempt/reviewer"
  New-Item -ItemType Directory -Force $dir | Out-Null
  $planFile = Join-Path $runRoot "attempt-$Attempt/planner/plan.md"
  if (-not (Test-Path -LiteralPath $planFile)) {
    if (-not $script:previousPlan) { throw "reviewer requires an approved plan" }
    New-Item -ItemType Directory -Force (Split-Path $planFile) | Out-Null
    $script:previousPlan | Set-Content $planFile -Encoding UTF8
  }
  $implOutput = Join-Path $runRoot "attempt-$Attempt/implementor/output.json"
  $implGates = Join-Path $runRoot "attempt-$Attempt/implementor/gates.json"
  $implOutputText = if (Test-Path -LiteralPath $implOutput) { Get-Content $implOutput -Raw } else { "Not run: review-only round." }
  $implGatesText = if (Test-Path -LiteralPath $implGates) { Get-Content $implGates -Raw } else { "Not run: review-only round." }
  $prDiff = Join-Path $dir "pr.diff"
  $gatesFile = Join-Path $dir "gates.json"

  gh pr diff $script:pr --repo $env:GITHUB_REPOSITORY > $prDiff
  if ($LASTEXITCODE -ne 0) { throw "gh pr diff failed on attempt $Attempt" }

  pnpm install --frozen-lockfile --ignore-scripts
  if ($LASTEXITCODE -ne 0) { throw "reviewer pnpm install failed on attempt $Attempt" }
  pnpm rebuild esbuild
  if ($LASTEXITCODE -ne 0) { throw "reviewer pnpm rebuild failed on attempt $Attempt" }

  $gates = [ordered]@{ typecheck = "not_run"; tests = "not_run"; build = "not_run"; release = "not_run"; e2e = "not_run" }
  node node_modules/typescript/bin/tsc --noEmit *> (Join-Path $dir "typecheck.log")
  $gates.typecheck = if ($LASTEXITCODE -eq 0) { "pass" } else { "fail" }
  pnpm build *> (Join-Path $dir "build.log")
  $gates.build = if ($LASTEXITCODE -eq 0) { "pass" } else { "fail" }
  node node_modules/vitest/vitest.mjs run --maxWorkers=2 *> (Join-Path $dir "tests.log")
  $gates.tests = if ($LASTEXITCODE -eq 0) { "pass" } else { "fail" }
  pnpm release:check *> (Join-Path $dir "release-check.log")
  $gates.release = if ($LASTEXITCODE -eq 0) { "pass" } else { "fail" }
  $gates | ConvertTo-Json | Set-Content $gatesFile -Encoding UTF8

  $promptFile = Join-Path $dir "prompt.md"
  $inputs = @($script:issueFile, $planFile, $script:reportFile, $prDiff, $gatesFile, (Join-Path $script:promptRoot "reviewer.md"))
  foreach ($optionalInput in @($implOutput, $implGates)) {
    if (Test-Path -LiteralPath $optionalInput) { $inputs += $optionalInput }
  }
  $prompt = (Get-Content (Join-Path $script:promptRoot "reviewer.md") -Raw) +
    "`n`n## Issue`n`n" + (Get-Content $script:issueFile -Raw) +
    "`n`n## Approved plan`n`n" + (Get-Content $planFile -Raw) +
    "`n`n## Compatibility report`n`n" + (Get-Content $script:reportFile -Raw) +
    "`n`n## PR diff`n`n" + (Get-Content $prDiff -Raw) +
    "`n`n## Plan mode`n`nplan_kind: $($script:planKind)`n" +
    "`n`n## Gate results`n`n" + (Get-Content $gatesFile -Raw) +
    "`n`n## Implementor structured output`n`n" + $implOutputText +
    "`n`n## Implementor gate results`n`n" + $implGatesText
  $prompt | Set-Content $promptFile -Encoding UTF8
  $inputs += $promptFile
  Invoke-AuditInit -Role "reviewer" -Dir $dir -Attempt $Attempt -Inputs $inputs
  $output = Join-Path $dir "output.json"
  (Get-Content $promptFile -Raw) | codex exec - --strict-config --sandbox read-only --cd $repo --output-last-message $output --json *> (Join-Path $dir "events.jsonl")
  if ($LASTEXITCODE -ne 0) { throw "reviewer failed on attempt $Attempt" }
  Invoke-AuditFinish -Role "reviewer" -Dir $dir -Output $output -Gates $gatesFile
  $review = Get-Content $output -Raw | ConvertFrom-Json
  $reviewFile = Join-Path $dir "review.md"
  ("<!-- compat:review attempt=$Attempt -->`n`n" + $review.review_markdown) | Set-Content $reviewFile -Encoding UTF8
  gh pr review $script:pr --repo $env:GITHUB_REPOSITORY --comment --body-file $reviewFile

  $script:lastGates = $gates
  $script:lastReviewSummary = $review.summary
  $gatesAllPass = $gates.typecheck -eq "pass" -and $gates.build -eq "pass" -and $gates.tests -eq "pass" -and $gates.release -eq "pass"
  $checkConclusion = if (-not $gatesAllPass) { "failure" } elseif ($review.verdict -eq "approve") { "success" } else { "action_required" }
  $checkTitle = if ($review.verdict -eq "approve" -and $gatesAllPass) { "Compatibility code gates passed" } else { "Compatibility code gates need attention" }
  $checkSummary = (@(
    "Verdict: $($review.verdict)",
    "typecheck: $($gates.typecheck)",
    "tests: $($gates.tests)",
    "build: $($gates.build)",
    "release: $($gates.release)",
    "e2e: $($gates.e2e) (human merge gate when not_run)"
  ) -join "`n")
  Publish-CheckRun -Conclusion $checkConclusion -Title $checkTitle -Summary $checkSummary

  if ($review.verdict -eq "approve" -and $gatesAllPass) {
    $script:stage = "approved"
    $script:blockedReason = $null
    Set-Label "awaiting-review"
    Set-Label "agent:review" -Remove
    Set-Label "agent:blocked" -Remove
    gh pr ready $script:pr --repo $env:GITHUB_REPOSITORY 2>$null
    Update-Dashboard -Kind issue
    Update-Dashboard -Kind pr
    $script:reviewVerdict = "approve"
    return
  }
  if ($review.verdict -eq "approve" -and -not $gatesAllPass) {
    Write-Warning "Reviewer returned approve but one or more gates failed; treating this round as request_changes."
  }
  $script:previousReview = $output
  $script:previousGates = $gatesFile
  $script:trigger = "review_return"
  $script:reviewVerdict = "request_changes"
  $script:stage = "changes-requested"
  $script:blockedReason = $review.summary
  Update-Dashboard -Kind issue
  Update-Dashboard -Kind pr
  return
}

function Write-FinalSummary {
  param([string]$Result)
  if ($Result -eq "approved") { $script:stage = "approved" }
  elseif ($Result -eq "dry-run") { $script:stage = "dry-run" }
  elseif ($Result -eq "error") { $script:stage = "error" }
  else { $script:stage = "blocked" }

  $prUrl = if ($script:pr) { "https://github.com/$env:GITHUB_REPOSITORY/pull/$($script:pr)" } else { $null }
  $summary = [ordered]@{
    issue = $issueNumber
    tag = $tag
    version = $version
    branch = $script:branch
    pr = $script:pr
    prUrl = $prUrl
    result = $Result
    reviewOnly = $reviewOnly
    duration = (Get-DurationText)
    attempts = $script:attemptsUsed
    revisions = $script:revisionCount
    replacements = $script:replacementCount
    gates = $script:lastGates
    humanGate = (Get-HumanGateText)
    blockedReason = $script:blockedReason
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    runUrl = (Get-RunUrl)
  }
  $summary | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $runRoot "final.json") -Encoding UTF8
  $summary | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $runRoot "run-summary.json") -Encoding UTF8

  Update-Dashboard -Kind issue
  if ($script:pr) { Update-Dashboard -Kind pr }

  $prValue = if ($prUrl) { $prUrl } else { "-" }
  $lines = @(
    "<!-- compat:final result=$Result -->",
    "",
    "## Compatibility result: ``$Result``",
    "",
    "| Field | Value |",
    "|---|---|",
    "| Duration | $($summary.duration) |",
    "| Mode | $(if ($reviewOnly) { 'review-only preflight' } else { 'normal' }) |",
    "| Attempts | $($summary.attempts) |",
    "| Revisions | $($summary.revisions) |",
    "| Replacements | $($summary.replacements) |",
    "| Gates | $(Get-GateText) |",
    "| Human gate | $($summary.humanGate) |",
    "| PR | $prValue |",
    "| Run | $($summary.runUrl) |"
  )
  if ($Result -ne "approved" -and $script:blockedReason) {
    $lines += ""
    $lines += "**Blocked reason:** $($script:blockedReason)"
    $lines += ""
    $lines += "Next action: inspect the run artifact and use ``/resume [note]`` when the blocking input is available."
  }
  $lines | Set-Content (Join-Path $runRoot "final.md") -Encoding UTF8
}

function Find-OpenPRForIssue {
  $prs = gh pr list --repo $env:GITHUB_REPOSITORY --state open --json number,headRefName,body | ConvertFrom-Json
  $match = $prs | Where-Object { $_.body -match "(?i)(closes|fixes|resolves)\s+#$issueNumber\b" } | Select-Object -Last 1
  if (-not $match) { return $null }
  return $match
}

function Load-ResumeContext {
  $issue = gh issue view $issueNumber --repo $env:GITHUB_REPOSITORY --json comments | ConvertFrom-Json
  $planComment = $issue.comments | Where-Object { $_.body -like "*<!-- compat:plan*" } | Select-Object -Last 1
  if ($planComment) { $script:previousPlan = $planComment.body }
  if ($script:pr) {
    $pr = gh pr view $script:pr --repo $env:GITHUB_REPOSITORY --json body,comments,reviews | ConvertFrom-Json
    if ($pr.body -match '(?s)<!--\s*compat:plan\s*(.*?)\s*-->') {
      $script:previousPlan = $matches[1].Trim()
    }
    $review = $pr.reviews | Where-Object { $_.body -like "*<!-- compat:review*" } | Select-Object -Last 1
    if ($review) {
      $path = Join-Path $runRoot "resume-review.md"
      $review.body | Set-Content $path -Encoding UTF8
      $script:previousReview = $path
    }
    $audits = $pr.comments | Where-Object { $_.body -like "*<!-- compat:audit role=reviewer*" -or $_.body -like "*<!-- compat:audit role=implementor*" } | Select-Object -Last 2
    if ($audits) {
      $path = Join-Path $runRoot "resume-audit.md"
      ($audits | ForEach-Object { $_.body }) -join "`n`n" | Set-Content $path -Encoding UTF8
      if (-not $script:previousReview) { $script:previousReview = $path }
      $script:previousGates = $path
    }
  }
}

$issue = gh issue view $issueNumber --repo $env:GITHUB_REPOSITORY --json title,body,comments | ConvertFrom-Json
"# Issue #${issueNumber}: $($issue.title)`n`n$($issue.body)" | Set-Content $script:issueFile -Encoding UTF8
Copy-Item (Join-Path $env:RUNNER_TEMP "watch-artifact/compat-report.md") $script:reportFile

if ($resume) {
  if ($env:PR_NUMBER) {
    $prInfo = gh pr view $env:PR_NUMBER --repo $env:GITHUB_REPOSITORY --json number,headRefName | ConvertFrom-Json
    $script:pr = [string]$prInfo.number
    $script:branch = [string]$prInfo.headRefName
  } else {
    $match = Find-OpenPRForIssue
    if ($match) {
      $script:pr = [string]$match.number
      $script:branch = [string]$match.headRefName
    }
  }
  if ($script:pr) {
    git fetch origin "$($script:branch):refs/remotes/origin/$($script:branch)"
    if ($LASTEXITCODE -ne 0) { throw "failed to fetch resume branch" }
    git checkout -B $script:branch "origin/$($script:branch)"
    if ($LASTEXITCODE -ne 0) { throw "failed to checkout resume branch" }
  } else {
    $remote = git ls-remote --heads origin $script:branch
    if ($remote) {
      git fetch origin "$($script:branch):refs/remotes/origin/$($script:branch)"
      git checkout -B $script:branch "origin/$($script:branch)"
    } else {
      git checkout -B $script:branch
    }
    if ($LASTEXITCODE -ne 0) { throw "failed to prepare branch for PR-less resume" }
  }
  Load-ResumeContext
  $script:planMode = if ($script:previousPlan) { "decide" } else { "initial" }
  $script:trigger = "human_resume"
  $script:planRound = $startPlanRound
} else {
  $remote = git ls-remote --heads origin $script:branch
  if ($remote) {
    git fetch origin "$($script:branch):refs/remotes/origin/$($script:branch)"
    git checkout -B $script:branch "origin/$($script:branch)"
  } else {
    git checkout -B $script:branch
  }
  $existing = gh pr list --repo $env:GITHUB_REPOSITORY --head $script:branch --state open --json number,url | ConvertFrom-Json | Select-Object -First 1
  if ($existing) { $script:pr = [string]$existing.number }
  $script:planMode = "initial"
  $script:trigger = "initial"
  $script:planRound = $startPlanRound
}

try {
  $result = "running"
  if ($reviewOnly) {
    if (-not $script:pr) { throw "review-only requires an existing PR" }
    if (-not $script:previousPlan) { throw "review-only requires a previous approved plan" }
    $script:attemptsUsed = 0
    $script:planKind = "revision"
    $script:stage = "reviewing"
    Update-Dashboard -Kind issue
    Update-Dashboard -Kind pr
    $script:reviewVerdict = $null
    Invoke-Reviewer -Attempt 0
    if ($script:reviewVerdict -eq "approve") {
      $result = "approved"
    } else {
      $script:planMode = "decide"
      $script:trigger = "review_return"
    }
  }

  if ($result -ne "approved") {
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
      $script:attemptsUsed = $attempt
      $script:planRound = $startPlanRound + $attempt - 1
      if ($attempt -gt 1) {
        $script:planMode = "decide"
        if ($script:trigger -ne "human_resume") { $script:trigger = "review_return" }
      }
      $script:plannerBlocked = $false
      Invoke-Planner -Attempt $attempt
      if ($script:plannerBlocked) { $result = "blocked"; break }
      if ($dryRun) { $result = "dry-run"; break }
      $script:implementorBlocked = $false
      Invoke-Implementor -Attempt $attempt
      if ($script:implementorBlocked) {
        if ($attempt -lt $MaxAttempts) {
          $script:planMode = "decide"
          continue
        }
        $result = "blocked"
        break
      }
      $script:reviewVerdict = $null
      Invoke-Reviewer -Attempt $attempt
      if ($script:reviewVerdict -eq "approve") { $result = "approved"; break }
      $script:planMode = "decide"
      $script:trigger = "review_return"
    }
  }

  if ($result -eq "running") { $result = "blocked" }
  if ($result -eq "blocked") {
    Set-Label "agent:blocked"
    Set-Label "agent:review" -Remove
  }
  Write-FinalSummary -Result $result
} catch {
  $message = "Compatibility loop failed: $($_.Exception.Message)"
  $message | Set-Content (Join-Path $runRoot "error.txt") -Encoding UTF8
  $script:blockedReason = $_.Exception.Message
  $script:stage = "error"
  Set-Label "agent:blocked"
  Set-Label "agent:review" -Remove
  Write-FinalSummary -Result "error"
  exit 2
}
