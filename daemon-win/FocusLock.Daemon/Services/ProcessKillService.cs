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
    private readonly FamilyEnforcementService _family;

    // Processes we will NEVER kill, even if a user adds them to a blocklist.
    // Killing winlogon/explorer/svchost would nuke the shell or take down Windows.
    private static readonly HashSet<string> ProtectedNames = new(StringComparer.OrdinalIgnoreCase)
    {
        "system", "idle", "smss", "csrss", "wininit", "winlogon",
        "services", "lsass", "lsaiso", "fontdrvhost", "dwm",
        "explorer", "svchost", "taskhostw", "runtimebroker",
        "sihost", "ctfmon", "audiodg", "conhost",
        "focuslockdaemon", "focuslock",
    };

    public ProcessKillService(
        ILogger<ProcessKillService> log,
        SessionService session,
        FamilyEnforcementService family)
    {
        _log = log;
        _session = session;
        _family = family;
    }

    public void Poll()
    {
        var state = _session.Active;
        var sessionProcs = (state != null && state.IsActive) ? state.BlockedProcesses : new List<string>();
        var (_, familyProcs) = _family.GetUnion();

        if (sessionProcs.Count == 0 && familyProcs.Count == 0) return;

        // Build a lookup of names and full paths to match against (session ∪ family)
        var unionProcs = sessionProcs.Concat(familyProcs);

        var blockedNames = unionProcs
            .Select(p => Path.GetFileNameWithoutExtension(p).ToLowerInvariant())
            .ToHashSet();

        var blockedPaths = unionProcs
            .Where(p => p.Contains('\\') || p.Contains('/'))
            .Select(p => p.ToLowerInvariant())
            .ToHashSet();

        // Also respect allowlist during Pomodoro break phases — not implemented
        // here as the PomodoroConfig.StrictMode controls whether breaks unlock apps.

        foreach (var proc in Process.GetProcesses())
        {
            try
            {
                var procName = proc.ProcessName.ToLowerInvariant();
                if (ProtectedNames.Contains(procName)) continue;

                // Skip session 0 (SYSTEM/services). Only act on interactive user sessions.
                int sessionId;
                try { sessionId = proc.SessionId; }
                catch { continue; }
                if (sessionId == 0) continue;

                var nameMatch = blockedNames.Contains(procName);

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
