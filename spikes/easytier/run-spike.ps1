param(
  [Parameter(Mandatory = $true)]
  [string]$EasyTierCore,
  [ValidateSet("no-tun", "tun")]
  [string]$Mode = "no-tun",
  [ValidateSet("direct", "relay")]
  [string]$Topology = "direct",
  [ValidateRange(1, 16777216)]
  [int]$PayloadBytes = 1048576,
  [switch]$PlanOnly,
  [string]$OutputPath
)

$ErrorActionPreference = "Stop"

function Get-FreeTcpPort([System.Collections.Generic.HashSet[int]]$Reserved) {
  do {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
  } while (-not $Reserved.Add($port))
  return $port
}

function New-ProcessPlan(
  [string]$Role,
  [string]$VirtualIp,
  [int]$ListenerPort,
  [int]$RpcPort,
  [string[]]$Peers,
  [string]$NetworkName,
  [string]$NetworkSecret,
  [bool]$NoTun,
  [bool]$ForceRelay,
  [string]$PortForward
) {
  $arguments = [Collections.Generic.List[string]]::new()
  foreach ($value in @(
    "--network-name", $NetworkName,
    "--network-secret", $NetworkSecret,
    "--hostname", "collab-$Role",
    "--instance-name", "collab-$Role",
    "--listeners", "tcp://127.0.0.1:$ListenerPort",
    "--rpc-portal", "127.0.0.1:$RpcPort",
    "--no-tun", $NoTun.ToString().ToLowerInvariant(),
    "--disable-ipv6", "true",
    "--disable-upnp", "true",
    "--bind-device", "false",
    "--accept-dns", "false",
    "--console-log-level", "info"
  )) { $arguments.Add($value) }
  if ($VirtualIp) { $arguments.Add("--ipv4"); $arguments.Add($VirtualIp) }
  if ($Peers.Count -gt 0) {
    $arguments.Add("--peers")
    foreach ($peer in $Peers) { $arguments.Add($peer) }
  }
  if ($ForceRelay) { $arguments.Add("--disable-p2p"); $arguments.Add("true") }
  if ($PortForward) { $arguments.Add("--port-forward"); $arguments.Add($PortForward) }
  return [ordered]@{ role = $Role; arguments = $arguments.ToArray() }
}

function New-SpikePlan([string]$RequestedMode, [string]$RequestedTopology) {
  $reserved = [Collections.Generic.HashSet[int]]::new()
  $ports = [ordered]@{
    ownerListener = Get-FreeTcpPort $reserved
    participantListener = Get-FreeTcpPort $reserved
    relayListener = Get-FreeTcpPort $reserved
    ownerRpc = Get-FreeTcpPort $reserved
    participantRpc = Get-FreeTcpPort $reserved
    relayRpc = Get-FreeTcpPort $reserved
    ownerGateway = Get-FreeTcpPort $reserved
    participantBridge = Get-FreeTcpPort $reserved
  }
  $networkName = "dsh-collab-spike-$([Guid]::NewGuid().ToString('N'))"
  $networkSecret = [Guid]::NewGuid().ToString("N")
  $noTun = $RequestedMode -eq "no-tun"
  $forceRelay = $RequestedTopology -eq "relay"
  $relayPeer = "tcp://127.0.0.1:$($ports.relayListener)"
  $ownerPeer = "tcp://127.0.0.1:$($ports.ownerListener)"
  $ownerPeers = if ($forceRelay) { @($relayPeer) } else { @() }
  $participantPeers = if ($forceRelay) { @($relayPeer) } else { @($ownerPeer) }
  $portForward = if ($noTun) {
    "tcp://127.0.0.1:$($ports.participantBridge)/10.231.0.1:$($ports.ownerGateway)"
  } else { "" }
  $processes = [Collections.Generic.List[object]]::new()
  if ($forceRelay) {
    $processes.Add((New-ProcessPlan "relay" "" $ports.relayListener $ports.relayRpc @() $networkName $networkSecret $true $true ""))
  }
  $processes.Add((New-ProcessPlan "owner" "10.231.0.1" $ports.ownerListener $ports.ownerRpc $ownerPeers $networkName $networkSecret $noTun $forceRelay ""))
  $processes.Add((New-ProcessPlan "participant" "10.231.0.2" $ports.participantListener $ports.participantRpc $participantPeers $networkName $networkSecret $noTun $forceRelay $portForward))
  return [ordered]@{
    mode = $RequestedMode
    topology = $RequestedTopology
    payloadBytes = $PayloadBytes
    ports = $ports
    clientUrl = if ($noTun) { "ws://127.0.0.1:$($ports.participantBridge)/collab" } else { "ws://10.231.0.1:$($ports.ownerGateway)/collab" }
    processes = $processes.ToArray()
  }
}

$plan = New-SpikePlan $Mode $Topology
if ($PlanOnly) {
  $plan | ConvertTo-Json -Depth 8
  exit 0
}

if (-not (Test-Path -LiteralPath $EasyTierCore -PathType Leaf)) {
  throw "EasyTier core binary does not exist: $EasyTierCore"
}

$node = (Get-Command node -ErrorAction Stop).Source
$probe = Join-Path $PSScriptRoot "ws-probe.mjs"
$runDirectory = Join-Path $env:TEMP "dsh-collab-easytier-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $runDirectory | Out-Null
$managed = [Collections.Generic.List[object]]::new()

function Start-ManagedProcess([string]$Name, [string]$FilePath, [string[]]$Arguments, [string]$WorkingDirectory) {
  $stdout = Join-Path $runDirectory "$Name.stdout.log"
  $stderr = Join-Path $runDirectory "$Name.stderr.log"
  $process = Start-Process -FilePath $FilePath -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
  $handle = [pscustomobject]@{ name = $Name; process = $process; stdout = $stdout; stderr = $stderr }
  $managed.Add($handle)
  return $handle
}

function Stop-ManagedProcess($Handle) {
  if (-not $Handle) { return }
  $process = $Handle.process
  if (-not $process.HasExited) {
    Stop-Process -Id $process.Id
    Wait-Process -Id $process.Id -ErrorAction SilentlyContinue
  }
  $managed.Remove($Handle) | Out-Null
}

function Wait-TcpPort([string]$HostName, [int]$Port, [int]$TimeoutMs = 15000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    $client = [Net.Sockets.TcpClient]::new()
    try {
      $pending = $client.ConnectAsync($HostName, $Port)
      if ($pending.Wait(250) -and $client.Connected) { return }
    } catch {
      # Retry until the bounded deadline.
    } finally {
      $client.Dispose()
    }
    Start-Sleep -Milliseconds 100
  } while ([DateTime]::UtcNow -lt $deadline)
  throw "Timed out waiting for ${HostName}:$Port"
}

function Start-EasyTier($ProcessPlan, [string]$Suffix = "") {
  $name = "easytier-$($ProcessPlan.role)$Suffix"
  return Start-ManagedProcess $name $EasyTierCore $ProcessPlan.arguments (Split-Path -Parent $EasyTierCore)
}

function Start-ProbeServer([string]$Suffix = "") {
  $server = Start-ManagedProcess "gateway$Suffix" $node @($probe, "server", "--port", [string]$plan.ports.ownerGateway) $PSScriptRoot
  Wait-TcpPort "127.0.0.1" $plan.ports.ownerGateway
  return $server
}

function Invoke-Probe([int]$TimeoutMs = 15000) {
  $output = & $node $probe client --port $plan.ports.ownerGateway --url $plan.clientUrl --payload-bytes $PayloadBytes --timeout-ms $TimeoutMs 2>&1
  if ($LASTEXITCODE -ne 0) { throw "WebSocket probe failed: $($output -join ' ')" }
  return ($output -join "`n") | ConvertFrom-Json
}

function Wait-Probe([int]$TimeoutMs = 30000) {
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  do {
    try { return Invoke-Probe 5000 } catch { $lastError = $_ }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)
  throw $lastError
}

function Test-ProbeFails([int]$TimeoutMs = 2500) {
  & $node $probe client --port $plan.ports.ownerGateway --url $plan.clientUrl --payload-bytes $PayloadBytes --timeout-ms $TimeoutMs *> $null
  return $LASTEXITCODE -ne 0
}

function Test-Elevated {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$startedAt = [DateTimeOffset]::UtcNow
$result = [ordered]@{
  release = (& $EasyTierCore --version 2>&1) -join " "
  mode = $Mode
  topology = $Topology
  elevated = Test-Elevated
  runDirectory = $runDirectory
  status = "running"
  checks = [ordered]@{}
}

try {
  $server = Start-ProbeServer
  $relayPlan = $plan.processes | Where-Object role -eq "relay"
  $ownerPlan = $plan.processes | Where-Object role -eq "owner"
  $participantPlan = $plan.processes | Where-Object role -eq "participant"
  if ($relayPlan) {
    $relay = Start-EasyTier $relayPlan
    Wait-TcpPort "127.0.0.1" $plan.ports.relayListener
  }
  $owner = Start-EasyTier $ownerPlan

  if ($Mode -eq "tun") {
    $participant = Start-EasyTier $participantPlan
    try {
      $result.checks.baseline = Wait-Probe 15000
      $result.status = "go"
    } catch {
      $result.checks.baselineError = $_.Exception.Message
      $tunLog = (($owner, $participant) | ForEach-Object {
        (Get-Content -LiteralPath $_.stderr -Raw -ErrorAction SilentlyContinue)
      }) -join "`n"
      $result.checks.tunRequiresElevation = [bool](
        $tunLog -match "(?i)access.*denied|拒绝访问" -and
        $tunLog -match "(?i)failed to create adapter|tun device error"
      )
      $result.status = if (-not $result.elevated -and $result.checks.tunRequiresElevation) {
        "no-go-requires-elevation"
      } else {
        "failed"
      }
    }
  } else {
    Wait-TcpPort "127.0.0.1" $plan.ports.ownerListener
    $blocker = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $plan.ports.participantBridge)
    $blocker.Start()
    try {
      $conflicted = Start-EasyTier $participantPlan "-conflict"
      Start-Sleep -Seconds 2
      Stop-ManagedProcess $conflicted
    } finally {
      $blocker.Stop()
    }
    $conflictLog = ((Get-Content -LiteralPath $conflicted.stdout -Raw -ErrorAction SilentlyContinue) + "`n" + (Get-Content -LiteralPath $conflicted.stderr -Raw -ErrorAction SilentlyContinue))
    $result.checks.portConflictDiagnosed = [bool]($conflictLog -match "(?i)address.*use|10048|port.*forward.*fail|bind.*fail")

    $participant = Start-EasyTier $participantPlan
    Wait-TcpPort "127.0.0.1" $plan.ports.participantBridge
    $result.checks.baseline = Wait-Probe

    Stop-ManagedProcess $server
    $result.checks.gatewayOfflineDetected = Test-ProbeFails
    $server = Start-ProbeServer "-restart"
    $result.checks.gatewayRestart = Wait-Probe

    Stop-ManagedProcess $participant
    $result.checks.participantOfflineDetected = Test-ProbeFails
    $participant = Start-EasyTier $participantPlan "-restart"
    Wait-TcpPort "127.0.0.1" $plan.ports.participantBridge
    $result.checks.participantRestart = Wait-Probe

    Stop-ManagedProcess $owner
    $result.checks.ownerOfflineDetected = Test-ProbeFails
    $owner = Start-EasyTier $ownerPlan "-restart"
    Wait-TcpPort "127.0.0.1" $plan.ports.ownerListener
    $result.checks.ownerRestart = Wait-Probe
    $result.status = if ($result.checks.portConflictDiagnosed) { "go" } else { "failed" }
  }
} finally {
  foreach ($handle in @($managed.ToArray())) { Stop-ManagedProcess $handle }
}

$result.finishedAt = [DateTimeOffset]::UtcNow.ToString("O")
$result.durationMs = [int]([DateTimeOffset]::UtcNow - $startedAt).TotalMilliseconds
$json = $result | ConvertTo-Json -Depth 8
if ($OutputPath) {
  $parent = Split-Path -Parent $OutputPath
  if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
  Set-Content -LiteralPath $OutputPath -Value $json -Encoding utf8
}
$json
if ($result.status -eq "failed") { exit 1 }
