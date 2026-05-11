#Requires -RunAsAdministrator

param(
    [string]$InstallDir = "$env:ProgramFiles\FocusLock"
)

$ErrorActionPreference = 'Stop'
$ServiceName = 'FocusLockDaemon'

function Write-Step([string]$msg) { Write-Host "  $msg" -ForegroundColor Yellow }
function Write-Ok([string]$msg)   { Write-Host "  $msg" -ForegroundColor Green }

Write-Host ""
Write-Host "FocusLock — Uninstaller" -ForegroundColor White
Write-Host "=======================" -ForegroundColor DarkGray
Write-Host ""

# ── Block uninstall if session is active ──────────────────────────────────────
$stateFile = "$env:ProgramData\FocusLock\session.json"
if (Test-Path $stateFile) {
    try {
        $session = Get-Content $stateFile -Raw | ConvertFrom-Json
        $endTime = [DateTime]::Parse($session.endTime, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
        if ($endTime -gt [DateTime]::UtcNow) {
            $remaining = [int]($endTime - [DateTime]::UtcNow).TotalMinutes
            Write-Host "  BLOCKED: A focus session is active ($remaining min remaining)." -ForegroundColor Red
            Write-Host "  FocusLock cannot be uninstalled during an active session." -ForegroundColor Red
            Write-Host ""
            exit 1
        }
    } catch { }
}

# ── Stop and remove service ───────────────────────────────────────────────────
$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
    Write-Step "Stopping daemon service..."
    if ($svc.Status -eq 'Running') { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
    Write-Ok "Service removed."
}

# ── Clean up any hosts file entries left by the daemon ───────────────────────
$hostsPath = "$env:windir\System32\drivers\etc\hosts"
$lines = Get-Content $hostsPath -ErrorAction SilentlyContinue
if ($lines) {
    $filtered = $lines | Where-Object { $_ -notmatch '# FocusLock' }
    if ($filtered.Count -ne $lines.Count) {
        $filtered | Set-Content $hostsPath -Encoding UTF8
        Write-Ok "Cleaned up hosts file."
    }
}

# ── Remove install directory ──────────────────────────────────────────────────
if (Test-Path $InstallDir) {
    Write-Step "Removing $InstallDir ..."
    Remove-Item $InstallDir -Recurse -Force
    Write-Ok "Removed install directory."
}

# ── Remove Start Menu folder ──────────────────────────────────────────────────
$startMenuDir = Join-Path ([Environment]::GetFolderPath('CommonStartMenu')) 'Programs\FocusLock'
if (Test-Path $startMenuDir) {
    Remove-Item $startMenuDir -Recurse -Force
    Write-Ok "Removed Start Menu shortcuts."
}

# ── Remove Add/Remove Programs entry ─────────────────────────────────────────
$regPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\FocusLock'
if (Test-Path $regPath) {
    Remove-Item $regPath -Force
    Write-Ok "Removed registry entry."
}

Write-Host ""
Write-Ok "FocusLock has been completely removed."
Write-Host ""
