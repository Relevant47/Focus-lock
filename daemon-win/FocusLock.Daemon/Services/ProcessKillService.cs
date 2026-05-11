using System.Diagnostics;
using FocusLock.Daemon.Models;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Polls running processes every 2 seconds and kills any that match the
/// active session's blocked process list.
/// </summary>
public sealed class ProcessKillService
{
    private readonly ILogger<ProcessKillService> _log;
    private readonly SessionService _session;

    public ProcessKillService(ILogger<ProcessKillService> log, SessionService session)
    {
        _log = log;
        _session = session;
    }

    public void Poll()
    {
        var state = _session.Active;
        if (state == null || !state.IsActive) return;
        if (state.BlockedProcesses.Count == 0) return;

        // Build a lookup of names and full paths to match against
        var blockedNames = state.BlockedProcesses
            .Select(p => Path.GetFileNameWithoutExtension(p).ToLowerInvariant())
            .ToHashSet();

        var blockedPaths = state.BlockedProcesses
            .Where(p => p.Contains('\\') || p.Contains('/'))
            .Select(p => p.ToLowerInvariant())
            .ToHashSet();

        // Also respect allowlist during Pomodoro break phases — not implemented
        // here as the PomodoroConfig.StrictMode controls whether breaks unlock apps.

        foreach (var proc in Process.GetProcesses())
        {
            try
            {
                var nameMatch = blockedNames.Contains(proc.ProcessName.ToLowerInvariant());

                bool pathMatch = false;
                if (!nameMatch && blockedPaths.Count > 0)
                {
                    try
                    {
                        var path = proc.MainModule?.FileName?.ToLowerInvariant();
                        pathMatch = path != null && blockedPaths.Contains(path);
                    }
                    catch { /* access denied for some processes */ }
                }

                if (nameMatch || pathMatch)
                {
                    proc.Kill(entireProcessTree: true);
                    _session.IncrementBlockAttempt();
                    _log.LogInformation("Killed blocked process: {Name} (PID {Pid})",
                        proc.ProcessName, proc.Id);
                }
            }
            catch (Exception ex) when (ex is InvalidOperationException or UnauthorizedAccessException)
            {
                // Process already exited or access denied — ignore
            }
            finally
            {
                proc.Dispose();
            }
        }
    }
}
