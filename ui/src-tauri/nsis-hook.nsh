; FocusLock NSIS hooks — install and manage the Windows daemon service

!macro NSIS_HOOK_POSTINSTALL
  nsExec::ExecToLog '"$WINDIR\System32\sc.exe" create FocusLockDaemon binPath= "$\"$INSTDIR\FocusLockDaemon.exe$\"" DisplayName= "FocusLock Daemon" start= auto'
  nsExec::ExecToLog '"$WINDIR\System32\sc.exe" failure FocusLockDaemon reset= 300 actions= restart/5000/restart/10000/restart/30000'
  nsExec::ExecToLog '"$WINDIR\System32\sc.exe" start FocusLockDaemon'
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  nsExec::ExecToLog '"$WINDIR\System32\sc.exe" stop FocusLockDaemon'
  nsExec::ExecToLog '"$WINDIR\System32\sc.exe" delete FocusLockDaemon'
!macroend
