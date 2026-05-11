#Requires -RunAsAdministrator

param(
    [string]$InstallDir = "$env:ProgramFiles\FocusLock"
)

$ErrorActionPreference = 'Stop'
$ServiceName   = 'FocusLockDaemon'
$DisplayName   = 'FocusLock Daemon'
$AppVersion    = '1.0.0'

function Write-Step([string]$msg) { Write-Host "  $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "  $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "  $msg" -ForegroundColor Yellow }

Write-Host ""
Write-Host "FocusLock $AppVersion — Windows Installer" -ForegroundColor White
Write-Host "==========================================" -ForegroundColor DarkGray
Write-Host ""

# ── Validate source layout ────────────────────────────────────────────────────
$scriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Definition
$daemonSrc  = Join-Path $scriptDir 'daemon'
$uiSrc      = Join-Path $scriptDir 'ui'

if (-not (Test-Path (Join-Path $daemonSrc 'FocusLock.Daemon.exe'))) {
    Write-Error "daemon\FocusLock.Daemon.exe not found. Run 'dotnet publish' first."
}
if (-not (Test-Path (Join-Path $uiSrc 'FocusLock.exe'))) {
    Write-Error "ui\FocusLock.exe not found. Run 'npm run tauri build' first."
}

# ── Check .NET 8 runtime ──────────────────────────────────────────────────────
Write-Step "Checking .NET 8 runtime..."
$dotnetCmd = Get-Command dotnet -ErrorAction SilentlyContinue
$hasRuntime = $dotnetCmd -and (& dotnet --list-runtimes 2>$null) -match 'Microsoft\.NETCore\.App 8\.'

if (-not $hasRuntime) {
    Write-Warn ".NET 8 runtime not found — downloading installer..."
    $installer = Join-Path $env:TEMP 'dotnet8-runtime.exe'
    Invoke-WebRequest -Uri 'https://aka.ms/dotnet/8.0/dotnet-runtime-win-x64.exe' -OutFile $installer -UseBasicParsing
    Start-Process $installer -ArgumentList '/install', '/quiet', '/norestart' -Wait -NoNewWindow
    Remove-Item $installer -Force
    Write-Ok ".NET 8 runtime installed."
} else {
    Write-Ok ".NET 8 runtime found."
}

# ── Stop existing service if running ─────────────────────────────────────────
$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Step "Removing existing service..."
    if ($existing.Status -eq 'Running') { Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 1
    & sc.exe delete $ServiceName | Out-Null
    Start-Sleep -Seconds 2
}

# ── Create directory layout ───────────────────────────────────────────────────
Write-Step "Creating install directory: $InstallDir"
$daemonDir = Join-Path $InstallDir 'daemon'
$uiDir     = Join-Path $InstallDir 'ui'

foreach ($dir in @($InstallDir, $daemonDir, $uiDir)) {
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
}

# ── Copy files ────────────────────────────────────────────────────────────────
Write-Step "Copying daemon files..."
Copy-Item -Path "$daemonSrc\*" -Destination $daemonDir -Recurse -Force

Write-Step "Copying UI files..."
Copy-Item -Path "$uiSrc\*" -Destination $uiDir -Recurse -Force

Copy-Item -Path (Join-Path $scriptDir 'uninstall.ps1') -Destination $InstallDir -Force

# ── Install and start Windows service ────────────────────────────────────────
Write-Step "Installing Windows service..."
$daemonExe = Join-Path $daemonDir 'FocusLock.Daemon.exe'

New-Service `
    -Name        $ServiceName `
    -BinaryPathName $daemonExe `
    -DisplayName $DisplayName `
    -Description 'FocusLock background service — manages website and app blocking during focus sessions.' `
    -StartupType Automatic | Out-Null

# Restart on failure: 5 s, 10 s, 30 s, then stay stopped
& sc.exe failure $ServiceName reset= 300 actions= restart/5000/restart/10000/restart/30000 | Out-Null

Start-Service -Name $ServiceName
Write-Ok "Daemon service started."

# ── Start Menu shortcuts ──────────────────────────────────────────────────────
Write-Step "Creating Start Menu shortcuts..."
$startMenuDir = Join-Path ([Environment]::GetFolderPath('CommonStartMenu')) 'Programs\FocusLock'
if (-not (Test-Path $startMenuDir)) { New-Item -ItemType Directory -Path $startMenuDir -Force | Out-Null }

$shell = New-Object -ComObject WScript.Shell

$lnk = $shell.CreateShortcut((Join-Path $startMenuDir 'FocusLock.lnk'))
$lnk.TargetPath       = Join-Path $uiDir 'FocusLock.exe'
$lnk.WorkingDirectory = $uiDir
$lnk.Description      = 'FocusLock — website and app blocker'
$lnk.Save()

$unLnk = $shell.CreateShortcut((Join-Path $startMenuDir 'Uninstall FocusLock.lnk'))
$unLnk.TargetPath  = 'powershell.exe'
$unLnk.Arguments   = "-ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'uninstall.ps1')`""
$unLnk.Description = 'Remove FocusLock'
$unLnk.Save()

# ── Add/Remove Programs registry entry ───────────────────────────────────────
$regPath = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\FocusLock'
New-Item -Path $regPath -Force | Out-Null
$props = @{
    DisplayName     = 'FocusLock'
    DisplayVersion  = $AppVersion
    Publisher       = 'FocusLock'
    InstallLocation = $InstallDir
    UninstallString = "powershell.exe -ExecutionPolicy Bypass -File `"$(Join-Path $InstallDir 'uninstall.ps1')`""
    NoModify        = 1
    NoRepair        = 1
}
foreach ($k in $props.Keys) { Set-ItemProperty -Path $regPath -Name $k -Value $props[$k] }

# ── Done ──────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Ok "FocusLock $AppVersion installed successfully!"
Write-Host "  Location : $InstallDir" -ForegroundColor DarkGray
Write-Host "  Service  : $ServiceName (running)" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  Launch FocusLock from the Start Menu." -ForegroundColor White
Write-Host ""
