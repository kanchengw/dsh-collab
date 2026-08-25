param(
  [string]$DshRepo = (Resolve-Path (Join-Path $PSScriptRoot "../../deepseek-harness")).Path
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$hostHome = Join-Path $projectRoot "e2e/.state/host"
$participantHome = Join-Path $projectRoot "e2e/.state/participant"
$previousDshHome = [Environment]::GetEnvironmentVariable("DSH_HOME", "Process")

try {
  Push-Location $projectRoot
  try {
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw "dsh-collab build failed" }
  } finally {
    Pop-Location
  }

  foreach ($installation in @(
    @{ Home = $hostHome; Patch = "dsh-host.patch.yml" },
    @{ Home = $participantHome; Patch = "dsh-participant.patch.yml" }
  )) {
    New-Item -ItemType Directory -Force -Path $installation.Home | Out-Null
    $env:DSH_HOME = $installation.Home
    Push-Location $DshRepo
    try {
      pnpm dsh plugin --profile web add $projectRoot
      if ($LASTEXITCODE -ne 0) { throw "DSH plugin installation failed for $($installation.Home)" }
    } finally {
      Pop-Location
    }
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $installation.Patch) -Destination (Join-Path $installation.Home "profiles/web/cordis.patch.yml") -Force
  }
} finally {
  [Environment]::SetEnvironmentVariable("DSH_HOME", $previousDshHome, "Process")
}

Write-Output "Prepared Host DSH at $hostHome and Participant DSH at $participantHome."
