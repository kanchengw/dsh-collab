param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("A", "B")]
  [string]$Client,
  [string]$DshRepo = (Resolve-Path (Join-Path $PSScriptRoot "../../deepseek-harness")).Path
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$clients = @{
  A = @{ Home = "client-a"; UiPort = 3082 }
  B = @{ Home = "client-b"; UiPort = 3083 }
}
$selected = $clients[$Client]
$env:DSH_HOME = Join-Path $projectRoot "e2e/.state/$($selected.Home)"

Push-Location $DshRepo
try {
  pnpm dsh web --host 127.0.0.1 --port $selected.UiPort --no-open
  if ($LASTEXITCODE -ne 0) { throw "Client $Client DSH exited with code $LASTEXITCODE" }
} finally {
  Pop-Location
}
