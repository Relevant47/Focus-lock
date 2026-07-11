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
        // Session app-blocks are lifted during a non-strict Pomodoro break, mirroring
        // how the hosts-file path drops session domains during the break. Family rules
        // still apply — a parent-side block isn't lifted by the user's own break.
        var liftBreak = _session.ShouldLiftBlocksDuringBreak;
        var sessionProcs = (state != null && state.IsActive && !liftBreak) ? state.BlockedProcesses : new List<string>();
        var (_, familyProcs) = _family.GetUnion();

        if (sessionProcs.Count == 0 && familyProcs.Count == 0) return;

        // Split lookups by source so blockAttempts only counts session-rule kills.
        // Killing an app that only a family (parent) rule wanted to block is not
        // the user "trying to break their own session" and shouldn't inflate the
        // focus-score penalty on Analytics.
        var sessionNames = sessionProcs
            .Select(p => Path.GetFileNameWithoutExtension(p).ToLowerInvariant())
            .ToHashSet();
        var sessionPaths = sessionProcs
            .Where(p => p.Contains('\\') || p.Contains('/'))
            .Select(p => p.ToLowerInvariant())
            .ToHashSet();
        var familyNames = familyProcs
            .Select(p => Path.GetFileNameWithoutExtension(p).ToLowerInvariant())
            .ToHashSet();
        var familyPaths = familyProcs
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

                var sessionNameMatch = sessionNames.Contains(procName);
                var familyNameMatch = !sessionNameMatch && familyNames.Contains(procName);

                bool sessionPathMatch = false;
                bool familyPathMatch = false;
                if (!sessionNameMatch && !familyNameMatch
                    && (sessionPaths.Count > 0 || familyPaths.Count > 0))
                {
                    try
                    {
                        var path = proc.MainModule?.FileName?.ToLowerInvariant();
                        if (path != null)
                        {
                            sessionPathMatch = sessionPaths.Contains(path);
                            familyPathMatch = !sessionPathMatch && familyPaths.Contains(path);
                        }
                    }
                    catch { /* access denied for some processes */ }
                }

                var sessionKill = sessionNameMatch || sessionPathMatch;
                var familyKill = familyNameMatch || familyPathMatch;

                if (sessionKill || familyKill)
                {
                    proc.Kill(entireProcessTree: true);
                    // Only the session rule feeds blockAttempts + focus score.
                    if (sessionKill) _session.IncrementBlockAttempt();
                    _log.LogInformation(
                        "Killed blocked process: {Name} (PID {Pid}) — source: {Source}",
                        proc.ProcessName, proc.Id, sessionKill ? "session" : "family");
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
