param(
  [string]$DshRepo = (Resolve-Path (Join-Path $PSScriptRoot "../../deepseek-harness")).Path
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$env:DSH_HOME = Join-Path $projectRoot "e2e/.state/host"

Push-Location $DshRepo
try {
  pnpm dsh web --port 3082 --no-open
  if ($LASTEXITCODE -ne 0) { throw "Host DSH exited with code $LASTEXITCODE" }
} finally {
  Pop-Location
}
