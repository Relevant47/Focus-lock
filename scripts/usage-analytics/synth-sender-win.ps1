# FocusLock — Windows usage-analytics smoke sender (Phase 2)
#
# Requires the FocusLock daemon running as SYSTEM on Windows; can't be run
# from a macOS host. Speaks newline-delimited JSON over \\.\pipe\focuslock.
#
# End-to-end flow:
#   1. usage.enable                                → ok
#   2. 10 × usage.report_sample (varied exe bundles, mixed in_focus)
#   3. usage.query today                           → non-empty rows (printed)
#   4. usage.disable                               → ok
#   5. Test-Path %ProgramData%\FocusLock\usage.db  → $false
#
# Usage:  pwsh -File .\synth-sender-win.ps1

#Requires -Version 7

param(
    [string]$PipeName = 'focuslock'
)

$ErrorActionPreference = 'Stop'

function Send-IpcRequest {
    param(
        [Parameter(Mandatory)] [System.IO.StreamReader] $Reader,
        [Parameter(Mandatory)] [System.IO.StreamWriter] $Writer,
        [Parameter(Mandatory)] [string] $Type,
        [object] $Payload = $null
    )

    $obj = [ordered]@{ type = $Type }
    if ($null -ne $Payload) { $obj.payload = $Payload }
    $line = $obj | ConvertTo-Json -Compress -Depth 8
    $Writer.WriteLine($line)
    $Writer.Flush()

    $response = $Reader.ReadLine()
    if ([string]::IsNullOrEmpty($response)) {
        throw "Empty response to '$Type'"
    }
    return ($response | ConvertFrom-Json)
}

function Assert-Ok {
    param([object] $Response, [string] $Context)
    if ($Response.type -ne 'ok') {
        throw "$Context did not return ok — got type='$($Response.type)' message='$($Response.message)'"
    }
    Write-Host "  [ok] $Context" -ForegroundColor Green
}

Write-Host "FocusLock usage-analytics smoke sender" -ForegroundColor Cyan
Write-Host "Connecting to \\.\pipe\$PipeName ..." -ForegroundColor Gray

$pipe = New-Object System.IO.Pipes.NamedPipeClientStream(
    '.', $PipeName,
    [System.IO.Pipes.PipeDirection]::InOut,
    [System.IO.Pipes.PipeOptions]::None)
$pipe.Connect(5000)

$reader = New-Object System.IO.StreamReader($pipe, [System.Text.Encoding]::UTF8)
$writer = New-Object System.IO.StreamWriter($pipe, (New-Object System.Text.UTF8Encoding($false)))
$writer.AutoFlush = $true

try {
    # 1. Enable ---------------------------------------------------------------
    Write-Host "`n1) usage.enable" -ForegroundColor Yellow
    $r = Send-IpcRequest -Reader $reader -Writer $writer -Type 'usage.enable'
    Assert-Ok $r 'usage.enable'

    # 2. Report 10 samples across a handful of fake apps ---------------------
    Write-Host "`n2) usage.report_sample × 10" -ForegroundColor Yellow
    $bundles = @(
        @{ bundle_id = 'C:\Program Files\Google\Chrome\Application\chrome.exe';       app_name = 'Google Chrome' },
        @{ bundle_id = 'C:\Program Files\Microsoft VS Code\Code.exe';                 app_name = 'Visual Studio Code' },
        @{ bundle_id = 'C:\Users\Public\AppData\Local\slack\slack.exe';               app_name = 'Slack' },
        @{ bundle_id = 'C:\Program Files\WindowsApps\microsoft.windowsterminal.exe';  app_name = 'Windows Terminal' },
        @{ bundle_id = 'C:\Program Files\Spotify\Spotify.exe';                        app_name = 'Spotify' }
    )
    $nowUtc = (Get-Date).ToUniversalTime()
    for ($i = 0; $i -lt 10; $i++) {
        $b = $bundles[$i % $bundles.Count]
        $payload = @{
            bundle_id = $b.bundle_id
            app_name  = $b.app_name
            seconds   = 5
            in_focus  = ($i % 3 -eq 0)                     # mixed
            timestamp = $nowUtc.AddSeconds(-5 * $i).ToString('o')
        }
        $r = Send-IpcRequest -Reader $reader -Writer $writer -Type 'usage.report_sample' -Payload $payload
        Assert-Ok $r ("usage.report_sample #{0} ({1})" -f ($i + 1), $b.app_name)
    }

    # 3. Query today ---------------------------------------------------------
    Write-Host "`n3) usage.query today" -ForegroundColor Yellow
    $today = (Get-Date).ToString('yyyy-MM-dd')
    $q = @{
        start_date      = $today
        end_date        = $today
        split_by_focus  = $true
    }
    $r = Send-IpcRequest -Reader $reader -Writer $writer -Type 'usage.query' -Payload $q
    if ($r.type -ne 'usage_query_result') {
        throw "usage.query did not return usage_query_result — got '$($r.type)'"
    }
    if (-not $r.payload.rows -or $r.payload.rows.Count -eq 0) {
        throw "usage.query returned zero rows — expected the 10 samples we just sent"
    }
    Write-Host "  [ok] usage.query returned $($r.payload.rows.Count) row(s)" -ForegroundColor Green
    $r.payload.rows | ForEach-Object {
        '    {0,-40} {1,6}s  in={2,-4}  out={3,-4}' -f
            $_.app_name, $_.seconds, $_.in_focus_seconds, $_.out_focus_seconds
    }

    # 4. Disable -------------------------------------------------------------
    Write-Host "`n4) usage.disable" -ForegroundColor Yellow
    $r = Send-IpcRequest -Reader $reader -Writer $writer -Type 'usage.disable'
    Assert-Ok $r 'usage.disable'

    # 5. Verify DB file is gone ----------------------------------------------
    Write-Host "`n5) verify DB file removed" -ForegroundColor Yellow
    $dbPath = Join-Path $env:ProgramData 'FocusLock\usage.db'
    if (Test-Path -LiteralPath $dbPath) {
        throw "usage.db still exists at $dbPath after usage.disable — should have been deleted"
    }
    Write-Host "  [ok] $dbPath is gone" -ForegroundColor Green

    Write-Host "`nAll checks passed." -ForegroundColor Cyan
}
finally {
    $writer.Dispose()
    $reader.Dispose()
    $pipe.Dispose()
}
