param(
  [string]$DshRepo = (Resolve-Path (Join-Path $PSScriptRoot "../../deepseek-harness")).Path,
  [string]$HostAddress = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$hostHome = Join-Path $projectRoot "e2e/.state/host"
$participantHome = Join-Path $projectRoot "e2e/.state/participant"
$previousDshHome = [Environment]::GetEnvironmentVariable("DSH_HOME", "Process")

function Test-PrivateIpv4([string]$Address) {
  $parsed = $null
  if (-not [System.Net.IPAddress]::TryParse($Address, [ref]$parsed)) { return $false }
  if ($parsed.AddressFamily -ne [System.Net.Sockets.AddressFamily]::InterNetwork) { return $false }
  $bytes = $parsed.GetAddressBytes()
  return $bytes[0] -eq 10 `
    -or ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) `
    -or ($bytes[0] -eq 192 -and $bytes[1] -eq 168) `
    -or ($bytes[0] -eq 100 -and $bytes[1] -ge 64 -and $bytes[1] -le 127)
}

if ($HostAddress -ne "" -and -not (Test-PrivateIpv4 $HostAddress)) {
  throw "HostAddress must be a private IPv4 address"
}
if ($HostAddress -eq "") {
  $HostAddress = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) `
    | Where-Object { Test-PrivateIpv4 $_.IPAddressToString } `
    | Select-Object -First 1 -ExpandProperty IPAddressToString
}
if ($null -eq $HostAddress) {
  throw "No private IPv4 address found. Pass one explicitly with -HostAddress."
}

try {
  Push-Location $projectRoot
  try {
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw "dsh-collab build failed" }
    foreach ($artifact in @("lib/index.js", "lib/client.js")) {
      if (-not (Test-Path (Join-Path $projectRoot $artifact))) {
        throw "dsh-collab build did not produce $artifact"
      }
    }
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

  # Layer the test endpoint without replacing unrelated settings in the isolated Host home.
  $settingsPath = Join-Path $hostHome "settings.yaml"
  $settingsPatchPath = Join-Path $PSScriptRoot "dsh-host.settings.patch.yml"
  $settingsPatch = ([System.IO.File]::ReadAllText($settingsPatchPath)).Replace("__HOST_ADDRESS__", $HostAddress).Trim()
  $beginMarker = "# BEGIN dsh-collab same-machine E2E"
  $endMarker = "# END dsh-collab same-machine E2E"
  $currentSettings = if (Test-Path $settingsPath) { [System.IO.File]::ReadAllText($settingsPath) } else { "" }
  $hasBeginMarker = $currentSettings.Contains($beginMarker)
  $hasEndMarker = $currentSettings.Contains($endMarker)
  if ($hasBeginMarker -ne $hasEndMarker) { throw "Incomplete dsh-collab E2E settings block in $settingsPath" }

  $settingsBlock = "$beginMarker`r`n$settingsPatch`r`n$endMarker"
  if ($hasBeginMarker) {
    $pattern = "(?ms)^$([regex]::Escape($beginMarker)).*?^$([regex]::Escape($endMarker))"
    $nextSettings = [regex]::Replace($currentSettings, $pattern, $settingsBlock)
  } else {
    if ($currentSettings -match "(?m)^dsh-collab:\s*$") {
      throw "Host test settings already contain an unmanaged dsh-collab section: $settingsPath"
    }
    $separator = if ($currentSettings -eq "" -or $currentSettings.EndsWith("`n")) { "" } else { "`r`n" }
    $nextSettings = "$currentSettings$separator$settingsBlock`r`n"
  }
  [System.IO.File]::WriteAllText($settingsPath, $nextSettings, [System.Text.UTF8Encoding]::new($false))
} finally {
  [Environment]::SetEnvironmentVariable("DSH_HOME", $previousDshHome, "Process")
}

Write-Output "Prepared Host DSH at $hostHome and Participant DSH at $participantHome."
Write-Output "Same-machine invitation endpoint: ws://$($HostAddress):4312/collab"
