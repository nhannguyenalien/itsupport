#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Installs the 3 privilege-separated agent processes (daemon, telemetry,
  executor - docs/v0.1-spec.md process separation) as real Windows services.

.DESCRIPTION
  Run this from the directory containing daemon.exe, telemetry.exe,
  executor.exe, enroll.exe (build them first: GOOS=windows GOARCH=amd64 go
  build ./cmd/... from the agent/ directory). Copies them to
  C:\SupportAgent, runs enrollment if -EnrollmentToken /
  -BackendUrl are given (skip if already enrolled - enroll.exe writes
  config.json once and every process after that reads it), generates the
  daemon<->executor IPC shared secret, and registers all 3 as services.

  Known simplification, not hidden: the IPC secret is set as a SYSTEM
  (machine-wide) environment variable rather than scoped per-service via the
  registry's per-service Environment key. On a single-purpose agent machine
  this is a reasonable simplification (see docs/v0.1-spec.md's own scope for
  what's in v0.1) but it does mean any other SYSTEM-level process on the box
  could read AGENT_IPC_SECRET too - not just daemon/executor. Tightening this
  to a real per-service environment block is real follow-up work, not done
  here.

.PARAMETER BackendUrl
  e.g. https://api.yourcompany.com - passed to enroll.exe if -EnrollmentToken
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
    [string]$InstallDir = "$env:SystemDrive\SupportAgent",
    [switch]$ForceReEnroll
)

$ErrorActionPreference = "Stop"

function Assert-FileExists($path) {
    if (-not (Test-Path $path)) {
        throw "Required file not found: $path (build it first - see agent/README.md)"
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

# --- Enrollment ---
# Configs created before agent 0.2.0 have no agentToken. They cannot use the
# public Cloudflare endpoint, so treat them as needing one re-enrollment.
$configPath = Join-Path $env:ProgramData "support-agent\config.json"
$legacyUserConfigPath = Join-Path $env:APPDATA "support-agent\config.json"

# All services must read the same machine-level config, regardless of which
# administrator performs the enrollment. Older installers wrote to the
# interactive user's profile; migrate that config once when found.
if (-not (Test-Path $configPath) -and (Test-Path $legacyUserConfigPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $configPath) | Out-Null
    Copy-Item $legacyUserConfigPath $configPath -Force
    Write-Host "Migrated the existing user config to $configPath."
}
[Environment]::SetEnvironmentVariable("AGENT_CONFIG_PATH", $configPath, "Machine")
$env:AGENT_CONFIG_PATH = $configPath

$needsEnrollment = $ForceReEnroll -or -not (Test-Path $configPath)
if ((Test-Path $configPath) -and -not $ForceReEnroll) {
    try {
        $existingConfig = Get-Content $configPath -Raw | ConvertFrom-Json
        $needsEnrollment = [string]::IsNullOrWhiteSpace([string]$existingConfig.agentToken)
        if (-not $needsEnrollment -and $BackendUrl) {
            $configuredBackend = ([string]$existingConfig.backendUrl).TrimEnd('/')
            $requestedBackend = $BackendUrl.TrimEnd('/')
            if ($configuredBackend -ne $requestedBackend) {
                $needsEnrollment = $true
                Copy-Item $configPath "$configPath.previous-backend.bak" -Force
                Write-Host "Backend changed from $configuredBackend to $requestedBackend; re-enrolling automatically."
            }
        }
        if ($needsEnrollment) {
            Copy-Item $configPath "$configPath.pre-token.bak" -Force
            Write-Host "Legacy config has no agentToken; backed it up to $configPath.pre-token.bak."
        }
    } catch {
        throw "Cannot read existing config $configPath. Fix or remove it before installing: $($_.Exception.Message)"
    }
}
if ($needsEnrollment) {
    if (-not $BackendUrl -or -not $EnrollmentToken) {
        throw "This device needs enrollment (new install, legacy config without agentToken, or -ForceReEnroll). " +
              "Pass both -BackendUrl and -EnrollmentToken."
    }
    Write-Host "Enrolling with $BackendUrl ..."
    & (Join-Path $InstallDir "enroll.exe") -backend $BackendUrl -token $EnrollmentToken
    if ($LASTEXITCODE -ne 0) { throw "enroll.exe failed (exit $LASTEXITCODE)" }
} else {
    Write-Host "Current config already contains an agent token - keeping this device identity."
}

# Daemon and telemetry run as NetworkService and need read-only access to the
# shared config. SYSTEM and local administrators retain full control.
& icacls.exe $configPath /inheritance:r /grant:r "SYSTEM:(F)" "Administrators:(F)" "NETWORK SERVICE:(R)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to secure $configPath with icacls.exe (exit $LASTEXITCODE)" }

# NetworkService runs the network-facing processes. It only needs to execute
# the installed binaries and append to its two dedicated diagnostic logs; it
# must not be able to replace the enrollment config.
& icacls.exe $InstallDir /grant:r "NETWORK SERVICE:(OI)(CI)(RX)" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "Failed to grant service access to $InstallDir (exit $LASTEXITCODE)" }
$configDir = Split-Path -Parent $configPath
foreach ($logName in @("daemon.log", "telemetry.log")) {
    $logPath = Join-Path $configDir $logName
    if (-not (Test-Path $logPath)) { New-Item -ItemType File -Path $logPath | Out-Null }
    & icacls.exe $logPath /inheritance:r /grant:r "SYSTEM:(F)" "Administrators:(F)" "NETWORK SERVICE:(M)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to secure $logPath (exit $LASTEXITCODE)" }
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
    Write-Host "AGENT_IPC_SECRET already set - reusing it."
}
# Services launched below need to see the var we just set in THIS process's
# environment too, not just future ones - SetEnvironmentVariable(...,
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
        Write-Host "$Name already exists - stopping and removing before re-creating."
        Stop-Service -Name $Name -Force -ErrorAction SilentlyContinue
        & sc.exe delete $Name | Out-Null
        Start-Sleep -Seconds 1
    }

    # The explicit argument selects the SCM code path. Keeping the default
    # install path free of spaces also avoids an unquoted-service-path risk.
    $serviceCommand = "`"$BinPath`" service"
    $scArgs = @("create", $Name, "binPath=", $serviceCommand, "start=", "auto", "DisplayName=", "`"$DisplayName`"")
    if ($Account) { $scArgs += @("obj=", $Account) }
    & sc.exe @scArgs
    if ($LASTEXITCODE -ne 0) { throw "sc.exe create failed for $Name (exit $LASTEXITCODE)" }

    & sc.exe failure $Name reset= 86400 actions= "restart/5000/restart/30000/restart/60000"
    Write-Host "Created service $Name (account: $(if ($Account) { $Account } else { 'LocalSystem (default)' }))"
}

# Process separation (docs/v0.1-spec.md): the executor is the ONLY process
# that needs elevated rights (it's the one actually calling Win32 APIs that
# change system state). Daemon/telemetry only ever talk HTTP to the backend
# and to the executor's loopback IPC endpoint - NetworkService is enough and
# keeps them from being a privilege-escalation shortcut if compromised.
Install-AgentService -Name "SupportAgentExecutor" -DisplayName "Support Agent - Executor" `
    -BinPath (Join-Path $InstallDir "executor.exe") -Account "LocalSystem"
Install-AgentService -Name "SupportAgentDaemon" -DisplayName "Support Agent - Connection Daemon" `
    -BinPath (Join-Path $InstallDir "daemon.exe") -Account "NT AUTHORITY\NetworkService"
Install-AgentService -Name "SupportAgentTelemetry" -DisplayName "Support Agent - Telemetry" `
    -BinPath (Join-Path $InstallDir "telemetry.exe") -Account "NT AUTHORITY\NetworkService"

Write-Host "Starting services (executor first - daemon depends on it being up to hand off tool calls) ..."
Start-Service -Name "SupportAgentExecutor"
Start-Sleep -Seconds 1
Start-Service -Name "SupportAgentDaemon"
Start-Service -Name "SupportAgentTelemetry"

Write-Host "Done. Check status with: Get-Service SupportAgent*"

Write-Host "Installing Mesh Agent for remote technical support. Each session requires customer consent."
$agentConfig = Get-Content $configPath -Raw | ConvertFrom-Json
$remote = Invoke-RestMethod -Uri ($agentConfig.backendUrl.TrimEnd('/') + '/devices/' + $agentConfig.deviceId + '/remote-install') -Headers @{ Authorization = 'Bearer ' + $agentConfig.agentToken } -TimeoutSec 30
$remoteUri = [Uri]$remote.url
if ($remoteUri.Scheme -ne 'https' -or $remoteUri.Authority -ne ([Uri]$remote.server).Authority) { throw 'Invalid remote installer URL' }
$meshService = Get-Service -Name 'Mesh Agent' -ErrorAction SilentlyContinue
$receiptPath = Join-Path $InstallDir 'mesh-install.json'
if ($meshService) {
    if (-not (Test-Path $receiptPath)) { throw 'Existing Mesh Agent detected. Ask your administrator to verify its server and group before continuing.' }
    $receipt = Get-Content $receiptPath -Raw | ConvertFrom-Json
    if ($receipt.server -ne $remote.server -or $receipt.group -ne $remote.group) { throw 'Existing Mesh Agent belongs to another server or group.' }
} else {
    $meshTemp = Join-Path $InstallDir ('mesh-setup-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $meshTemp | Out-Null
    try {
        $meshExe = Join-Path $meshTemp 'meshagent.exe'
        Invoke-WebRequest -UseBasicParsing -Uri $remote.url -OutFile $meshExe -TimeoutSec 120
        $meshProcess = Start-Process -FilePath $meshExe -ArgumentList '-fullinstall' -Wait -PassThru
        if ($meshProcess.ExitCode -ne 0) { throw "Mesh Agent installation failed ($($meshProcess.ExitCode))" }
        $meshService = Get-Service -Name 'Mesh Agent' -ErrorAction Stop
        if ($meshService.Status -ne 'Running') { Start-Service -Name 'Mesh Agent' }
        @{ server = $remote.server; group = $remote.group } | ConvertTo-Json | Set-Content $receiptPath
    } finally { Remove-Item -Recurse -Force $meshTemp }
}
Write-Host 'Mesh Agent installed. An administrator can link this machine in Dashboard > Devices > Remote support.'
