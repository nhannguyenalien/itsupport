#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs the 3 privilege-separated agent processes (daemon, telemetry,
  executor — docs/v0.1-spec.md process separation) as real Windows services.

.DESCRIPTION
  Run this from the directory containing daemon.exe, telemetry.exe,
  executor.exe, enroll.exe (build them first: GOOS=windows GOARCH=amd64 go
  build ./cmd/... from the agent/ directory). Copies them to
  %ProgramFiles%\SupportAgent, runs enrollment if -EnrollmentToken /
  -BackendUrl are given (skip if already enrolled — enroll.exe writes
  config.json once and every process after that reads it), generates the
  daemon<->executor IPC shared secret, and registers all 3 as services.

  Known simplification, not hidden: the IPC secret is set as a SYSTEM
  (machine-wide) environment variable rather than scoped per-service via the
  registry's per-service Environment key. On a single-purpose agent machine
  this is a reasonable simplification (see docs/v0.1-spec.md's own scope for
  what's in v0.1) but it does mean any other SYSTEM-level process on the box
  could read AGENT_IPC_SECRET too — not just daemon/executor. Tightening this
  to a real per-service environment block is real follow-up work, not done
  here.

.PARAMETER BackendUrl
  e.g. https://api.yourcompany.com — passed to enroll.exe if -EnrollmentToken
  is also given. Skip both params if this machine is already enrolled
  (config.json already exists at %ProgramData%\support-agent\config.json).

.PARAMETER EnrollmentToken
  One-time enrollment token from the backend (POST /enrollment/tokens on the
  dashboard side). Only needed for first-time setup on this machine.

.EXAMPLE
  .\install.ps1 -BackendUrl "https://api.example.com" -EnrollmentToken "abc123"
#>
param(
    [string]$BackendUrl,
    [string]$EnrollmentToken,
    [string]$InstallDir = "$env:ProgramFiles\SupportAgent"
)

$ErrorActionPreference = "Stop"

function Assert-FileExists($path) {
    if (-not (Test-Path $path)) {
        throw "Required file not found: $path (build it first — see agent/README.md)"
    }
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
foreach ($bin in @("daemon.exe", "telemetry.exe", "executor.exe", "enroll.exe")) {
    Assert-FileExists (Join-Path $here $bin)
}

Write-Host "Installing to $InstallDir ..."
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
foreach ($bin in @("daemon.exe", "telemetry.exe", "executor.exe", "enroll.exe")) {
    Copy-Item (Join-Path $here $bin) (Join-Path $InstallDir $bin) -Force
}

# --- Enrollment (only if not already done) ---
$configPath = Join-Path $env:ProgramData "support-agent\config.json"
if (-not (Test-Path $configPath)) {
    if (-not $BackendUrl -or -not $EnrollmentToken) {
        throw "Not enrolled yet (no $configPath) and -BackendUrl/-EnrollmentToken were not given. " +
              "Either pass both now, or run enroll.exe manually first, then re-run this script."
    }
    Write-Host "Enrolling with $BackendUrl ..."
    & (Join-Path $InstallDir "enroll.exe") -backend $BackendUrl -token $EnrollmentToken
    if ($LASTEXITCODE -ne 0) { throw "enroll.exe failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "Already enrolled ($configPath exists) — skipping enrollment."
}

# --- IPC shared secret (generate once, reuse on re-install) ---
$existingSecret = [Environment]::GetEnvironmentVariable("AGENT_IPC_SECRET", "Machine")
if (-not $existingSecret) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $secret = [Convert]::ToBase64String($bytes)
    [Environment]::SetEnvironmentVariable("AGENT_IPC_SECRET", $secret, "Machine")
    Write-Host "Generated a new AGENT_IPC_SECRET (machine-wide env var)."
} else {
    Write-Host "AGENT_IPC_SECRET already set — reusing it."
}
# Services launched below need to see the var we just set in THIS process's
# environment too, not just future ones — SetEnvironmentVariable(...,
# "Machine") doesn't retroactively update the current process.
$env:AGENT_IPC_SECRET = [Environment]::GetEnvironmentVariable("AGENT_IPC_SECRET", "Machine")

function Install-AgentService {
    param(
        [string]$Name,
        [string]$DisplayName,
        [string]$BinPath,
        [string]$Account  # "LocalSystem" or a built-in account name sc.exe accepts, e.g. "NT AUTHORITY\NetworkService"
    )
    $existing = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "$Name already exists — stopping and removing before re-creating."
        Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
        & sc.exe delete $Name | Out-Null
        Start-Sleep -Seconds 1
    }

    $scArgs = @("create", $Name, "binPath=", "`"$BinPath`"", "start=", "auto", "DisplayName=", "`"$DisplayName`"")
    if ($Account) { $scArgs += @("obj=", $Account) }
    & sc.exe @scArgs
    if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed for $Name (exit $LASTEXITCODE)" }

    & sc.exe failure $Name reset= 86400 actions= "restart/5000/restart/30000/restart/60000"
    Write-Host "Created service $Name (account: $(if ($Account) { $Account } else { 'LocalSystem (default)' }))"
}

# Process separation (docs/v0.1-spec.md): the executor is the ONLY process
# that needs elevated rights (it's the one actually calling Win32 APIs that
# change system state). Daemon/telemetry only ever talk HTTP to the backend
# and to the executor's loopback IPC endpoint — NetworkService is enough and
# keeps them from being a privilege-escalation shortcut if compromised.
Install-AgentService -Name "SupportAgentExecutor" -DisplayName "Support Agent - Executor" `
    -BinPath (Join-Path $InstallDir "executor.exe") -Account "LocalSystem"
Install-AgentService -Name "SupportAgentDaemon" -DisplayName "Support Agent - Connection Daemon" `
    -BinPath (Join-Path $InstallDir "daemon.exe") -Account "NT AUTHORITY\NetworkService"
Install-AgentService -Name "SupportAgentTelemetry" -DisplayName "Support Agent - Telemetry" `
    -BinPath (Join-Path $InstallDir "telemetry.exe") -Account "NT AUTHORITY\NetworkService"

Write-Host "Starting services (executor first — daemon depends on it being up to hand off tool calls) ..."
Start-Service -Name "SupportAgentExecutor"
Start-Sleep -Seconds 1
Start-Service -Name "SupportAgentDaemon"
Start-Service -Name "SupportAgentTelemetry"

Write-Host "Done. Check status with: Get-Service SupportAgent*"
