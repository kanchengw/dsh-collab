param(
  [string]$DshRepo = (Resolve-Path (Join-Path $PSScriptRoot "../../deepseek-harness")).Path,
  [string]$PrivateAddress = ""
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$previousDshHome = [Environment]::GetEnvironmentVariable("DSH_HOME", "Process")
$clients = @(
  @{ Id = "client-a" },
  @{ Id = "client-b" }
)

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

if ($PrivateAddress -ne "" -and -not (Test-PrivateIpv4 $PrivateAddress)) {
  throw "PrivateAddress must be a private IPv4 address"
}
if ($PrivateAddress -eq "") {
  $PrivateAddress = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) `
    | Where-Object { Test-PrivateIpv4 $_.IPAddressToString } `
    | Select-Object -First 1 -ExpandProperty IPAddressToString
}
if ($null -eq $PrivateAddress) {
  throw "No private IPv4 address found. Pass one explicitly with -PrivateAddress."
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

  $cordisTemplate = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "dsh-client.patch.yml"))
  $settingsTemplate = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot "dsh-client.settings.patch.yml"))
  foreach ($client in $clients) {
    $clientHome = Join-Path $projectRoot "e2e/.state/$($client.Id)"
    New-Item -ItemType Directory -Force -Path $clientHome | Out-Null
    $env:DSH_HOME = $clientHome
    Push-Location $DshRepo
    try {
      pnpm dsh plugin --profile web add $projectRoot
      if ($LASTEXITCODE -ne 0) { throw "DSH plugin installation failed for $clientHome" }
    } finally {
      Pop-Location
    }

    $cordisPath = Join-Path $clientHome "profiles/web/cordis.patch.yml"
    [System.IO.File]::WriteAllText($cordisPath, $cordisTemplate, [System.Text.UTF8Encoding]::new($false))

    $settingsPatch = $settingsTemplate.Replace("__PRIVATE_ADDRESS__", $PrivateAddress).Trim()
    $settingsPath = Join-Path $clientHome "settings.yaml"
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
        throw "Client test settings already contain an unmanaged dsh-collab section: $settingsPath"
      }
      $separator = if ($currentSettings -eq "" -or $currentSettings.EndsWith("`n")) { "" } else { "`r`n" }
      $nextSettings = "$currentSettings$separator$settingsBlock`r`n"
    }
    [System.IO.File]::WriteAllText($settingsPath, $nextSettings, [System.Text.UTF8Encoding]::new($false))
  }
} finally {
  [Environment]::SetEnvironmentVariable("DSH_HOME", $previousDshHome, "Process")
}

Write-Output "Prepared symmetric Client A and Client B DSH profiles."
Write-Output "Both clients prefer port 4310; each runtime will select and persist the first available port in 4310-4399."
