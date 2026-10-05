param(
  [string]$DshRepo = (Resolve-Path (Join-Path $PSScriptRoot "../../deepseek-harness")).Path,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$projectManifestPath = Join-Path $projectRoot "package.json"
$projectManifest = Get-Content -Raw $projectManifestPath | ConvertFrom-Json
$dependencySections = @(
  $projectManifest.dependencies,
  $projectManifest.devDependencies,
  $projectManifest.peerDependencies
) | Where-Object { $_ -ne $null }
$forbiddenAgentTeamPackageNames = @(
  "@deepseek-ai/dsh-experimental-agent-team",
  "@deepseek-ai/dsh-experimental-tool-agent-team",
  "@deepseek-ai/dsh-experimental-client-ui-agent-team"
)
$agentTeamDependencies = @($dependencySections | ForEach-Object {
  $_.PSObject.Properties.Name
} | Where-Object {
  $forbiddenAgentTeamPackageNames -contains $_
})
if ($agentTeamDependencies.Count -gt 0) {
  throw "Experimental Agent Team dependencies are not supported: $($agentTeamDependencies -join ", ")"
}
$ExpectedDshVersion = "0.2.0-rc.2"
$dshManifestPath = Join-Path $DshRepo "apps/cli/package.json"
if (-not (Test-Path $dshManifestPath)) {
  throw "DSH CLI manifest not found: $dshManifestPath"
}
$dshManifest = Get-Content -Raw $dshManifestPath | ConvertFrom-Json
if ($dshManifest.version -ne $ExpectedDshVersion) {
  throw "DSH runtime version mismatch: expected $ExpectedDshVersion, found $($dshManifest.version)"
}
$previousDshHome = [Environment]::GetEnvironmentVariable("DSH_HOME", "Process")
$clients = @(
  @{ Id = "client-a" },
  @{ Id = "client-b" }
)

try {
  Push-Location $projectRoot
  try {
    if (-not $SkipBuild) {
      pnpm build
      if ($LASTEXITCODE -ne 0) { throw "dsh-collab build failed" }
    }
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

      $profileManifestPath = Join-Path $clientHome "profiles/web/package.json"
      $profileManifest = Get-Content -Raw $profileManifestPath | ConvertFrom-Json
      $hasBetterSidebarDependency = $profileManifest.dependencies -and $profileManifest.dependencies.PSObject.Properties.Name -contains "dsh-better-sidebar"
      if ($hasBetterSidebarDependency) {
        pnpm dsh plugin --profile web remove dsh-better-sidebar
        if ($LASTEXITCODE -ne 0) { throw "Failed to remove legacy dsh-better-sidebar from $clientHome" }
        $profileManifest = Get-Content -Raw $profileManifestPath | ConvertFrom-Json
      }
      if ($profileManifest.dependencies -and $profileManifest.dependencies.PSObject.Properties.Name -contains "dsh-better-sidebar") {
        $profileManifest.dependencies.PSObject.Properties.Remove("dsh-better-sidebar")
      }
      if ($profileManifest.dsh -and $profileManifest.dsh.profile -and $profileManifest.dsh.profile.bundles) {
        $profileManifest.dsh.profile.bundles = @($profileManifest.dsh.profile.bundles | Where-Object { $_ -ne "dsh-better-sidebar" })
      }
      $profileManifest | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 $profileManifestPath
    } finally {
      Pop-Location
    }

    $cordisPath = Join-Path $clientHome "profiles/web/cordis.patch.yml"
    [System.IO.File]::WriteAllText($cordisPath, $cordisTemplate, [System.Text.UTF8Encoding]::new($false))

    $settingsPatch = $settingsTemplate.Trim()
    $settingsPath = Join-Path $clientHome "settings.yaml"
    $beginMarker = "# BEGIN dsh-collab same-machine E2E"
    $endMarker = "# END dsh-collab same-machine E2E"
    $currentSettings = if (Test-Path $settingsPath) { [System.IO.File]::ReadAllText($settingsPath) } else { "" }
    $hasBeginMarker = $currentSettings.Contains($beginMarker)
    $hasEndMarker = $currentSettings.Contains($endMarker)
    if ($hasBeginMarker -ne $hasEndMarker) { throw "Incomplete dsh-collab E2E settings block in $settingsPath" }

    $settingsBlock = "$beginMarker`r`n$settingsPatch`r`n$endMarker"
    if ($hasBeginMarker) {
      # DSH persists Joined Rooms inside this plugin block; replacing it would erase test state on every prepare.
      $nextSettings = $currentSettings
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
