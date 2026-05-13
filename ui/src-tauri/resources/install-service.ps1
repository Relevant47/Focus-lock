param([string]$DaemonPath)
sc.exe create FocusLockDaemon binPath= "`"$DaemonPath`"" DisplayName= "FocusLock Daemon" start= auto
sc.exe failure FocusLockDaemon reset= 300 actions= restart/5000/restart/10000/restart/30000
sc.exe start FocusLockDaemon
