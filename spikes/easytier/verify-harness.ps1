param(
  [string]$EasyTierCore = "C:\fake\easytier-core.exe"
)

$ErrorActionPreference = "Stop"
$runner = Join-Path $PSScriptRoot "run-spike.ps1"
if (-not (Test-Path -LiteralPath $runner)) {
  throw "EasyTier spike runner is missing: $runner"
}

function Read-Plan([string]$Mode, [string]$Topology) {
  $json = & $runner -EasyTierCore $EasyTierCore -Mode $Mode -Topology $Topology -PlanOnly
  if ($LASTEXITCODE -ne 0) { throw "Plan failed for $Mode/$Topology" }
  return $json | ConvertFrom-Json
}

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

$direct = Read-Plan "no-tun" "direct"
Assert-True ($direct.mode -eq "no-tun") "Direct plan must use no-tun mode"
Assert-True ($direct.topology -eq "direct") "Direct plan must identify its topology"
Assert-True ($direct.payloadBytes -eq 1048576) "Lifecycle baseline must use the verified 1 MiB frame size"
Assert-True ($direct.processes.Count -eq 2) "Direct plan must contain Owner and Participant"
Assert-True (($direct.processes[0].arguments -contains "--no-tun") -and ($direct.processes[0].arguments -contains "true")) "Owner must explicitly disable TUN"
foreach ($process in $direct.processes) {
  Assert-True (($process.arguments -join " ") -match "--bind-device false") "Same-host spike peers must disable physical-device binding"
}
Assert-True (($direct.processes[1].arguments -join " ") -match "--port-forward tcp://127\.0\.0\.1:\d+/10\.231\.0\.1:\d+") "Participant must bridge loopback to the Owner virtual IP"
Assert-True ($direct.ports.ownerListener -ne $direct.ports.participantListener) "Process listener ports must be unique"
Assert-True ($direct.ports.ownerGateway -ne $direct.ports.participantBridge) "Gateway and bridge ports must be unique"

$relay = Read-Plan "no-tun" "relay"
Assert-True ($relay.processes.Count -eq 3) "Relay plan must contain Relay, Owner, and Participant"
$relayArguments = ($relay.processes | ForEach-Object { $_.arguments -join " " }) -join "`n"
$ownerArguments = (($relay.processes | Where-Object role -eq "owner").arguments -join " ")
$participantArguments = (($relay.processes | Where-Object role -eq "participant").arguments -join " ")
Assert-True ([bool]($relayArguments -match "--disable-p2p true")) "Relay topology must force traffic through the relay"
Assert-True ([bool]($ownerArguments -match "--peers tcp://127\.0\.0\.1:\d+")) "Owner must connect to the relay"
Assert-True ([bool]($participantArguments -match "--peers tcp://127\.0\.0\.1:\d+")) "Participant must connect to the relay"

$tun = Read-Plan "tun" "direct"
Assert-True (($tun.processes[0].arguments -join " ") -match "--no-tun false") "TUN probe must explicitly request TUN"
Assert-True (-not (($tun.processes[1].arguments -join " ") -match "--port-forward")) "TUN path must not depend on the no-tun bridge"

Write-Output "EasyTier spike harness contract: PASS"
