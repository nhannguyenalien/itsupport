#Requires -RunAsAdministrator
<#
.SYNOPSIS
  Stops and removes the 3 agent services. Does NOT delete config.json (device
  identity/enrollment) or the IPC secret by default — pass -Full to also wipe
  those, e.g. before re-enrolling this machine as a different device.
#>
param(
    [switch]$Full,
    [string]$InstallDir = "$env:SystemDrive\SupportAgent"
)

$ErrorActionPreference = "Continue" # keep going even if one service is already gone — this should be safe to re-run

foreach ($name in @("SupportAgentDaemon", "SupportAgentTelemetry", "SupportAgentExecutor")) {
    $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
    if ($svc) {
        Write-Host "Stopping and removing $name ..."
        Stop-Service -Name $name -Force -ErrorAction SilentlyContinue
        & sc.exe delete $name | Out-Null
    } else {
        Write-Host "$name not installed, skipping."
    }
}

if ($Full) {
    Write-Host "Removing config, IPC secret, and install directory (-Full) ..."
    [Environment]::SetEnvironmentVariable("AGENT_IPC_SECRET", $null, "Machine")
    Remove-Item -Recurse -Force (Join-Path $env:ProgramData "support-agent") -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force $InstallDir -ErrorAction SilentlyContinue
} else {
    Write-Host "Left $InstallDir and enrollment config in place (pass -Full to remove those too)."
}

Write-Host "Done."
