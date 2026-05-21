; FocusLock NSIS hooks — install and manage the Windows daemon service.
; Also gates uninstall behind the settings-lock PIN (when configured) by
; checking for a daemon-written authorization token.

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog '"$WINDIR\System32\sc.exe" create FocusLockDaemon binPath= "$\"$INSTDIR\FocusLockDaemon.exe$\"" DisplayName= "FocusLock Daemon" start= auto'
  nsExec::ExecToLog '"$WINDIR\System32\sc.exe" failure FocusLockDaemon reset= 300 actions= restart/5000/restart/10000/restart/30000'
  nsExec::ExecToLog '"$WINDIR\System32\sc.exe" start FocusLockDaemon'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  ; Step 1 — only gate uninstall when the user has actually configured the
  ; settings-lock PIN. Without it there's no anti-self-bypass to honour and
  ; gating becomes obstruction. parent.cred is the PIN state file.
  IfFileExists "$APPDATA\..\..\..\..\..\ProgramData\FocusLock\parent.cred" check_token skip_gate
  IfFileExists "$PROGRAMDATA\FocusLock\parent.cred" check_token skip_gate

  check_token:
    ; Step 2 — daemon writes uninstall-authorized.token with a Unix-epoch
    ; expiry on the first line after a PIN-verified "I want to uninstall".
    ; PowerShell handles the read + expiry check + cleanup so NSIS doesn't
    ; have to grow a date plugin.
    nsExec::ExecToStack 'powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$$t = Join-Path $$env:ProgramData ''FocusLock\uninstall-authorized.token''; if (-not (Test-Path $$t)) { exit 1 }; $$exp = 0; try { $$exp = [int64](Get-Content $$t -First 1) } catch { exit 2 }; $$now = [int64](Get-Date -UFormat %%s); if ($$exp -lt $$now) { Remove-Item $$t -Force -ErrorAction SilentlyContinue; exit 3 }; Remove-Item $$t -Force -ErrorAction SilentlyContinue; exit 0"'
    Pop $0  ; exit code
    Pop $1  ; output (discarded)

    IntCmp $0 0 stop_service
    ; Non-zero exit ⇒ token missing / unreadable / expired. Tell the user
    ; what to do and bail out of the uninstall cleanly.
    MessageBox MB_ICONSTOP|MB_OK \
      "FocusLock has a settings-lock PIN configured.$\r$\n$\r$\nOpen FocusLock → Settings → Settings lock, unlock with the PIN, then click 'Allow uninstall'. After that, run the uninstaller again within 15 minutes.$\r$\n$\r$\nIf you've lost the PIN, use the 16-character recovery key from when you set it up."
    Abort "Uninstall not authorized by settings-lock PIN"

  skip_gate:
  stop_service:
    nsExec::ExecToLog '"$WINDIR\System32\sc.exe" stop FocusLockDaemon'
    nsExec::ExecToLog '"$WINDIR\System32\sc.exe" delete FocusLockDaemon'
!macroend
