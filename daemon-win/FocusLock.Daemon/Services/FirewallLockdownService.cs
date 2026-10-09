using System.Diagnostics;
using System.Runtime.Versioning;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Opt-in safety net for the "kid yanked the network cable" scenario. When the
/// device has been paired but disconnected from the family server for more than
/// 5 minutes AND the cached rules still call for blocks AND the user has opted
/// into the experimental lockdown flag, this service applies per-app Windows
/// Firewall outbound-block rules for the targeted processes.
///
/// Why: <see cref="ProcessKillService"/> already kills the process when it
/// appears, but a determined kid can rename <c>discord.exe</c> →
/// <c>notdiscord.exe</c> and run it. The firewall rules are bound to the
/// resolved executable PATH, not the name, so a rename alone doesn't escape
/// them — the kid has to actually copy the binary somewhere new.
///
/// Fail-open semantics: <c>netsh</c> failures are logged but don't crash the
/// daemon, and on shutdown we ALWAYS try to clean up our rules so a bad code
/// path can't permanently brick outbound traffic for an app.
///
/// Deferred: macOS pfctl implementation. The flag round-trips through the
/// Swift daemon's FamilyConfig but is currently a no-op there.
/// </summary>
[SupportedOSPlatform("windows")]
public sealed class FirewallLockdownService : BackgroundService
{
    /// <summary>Display-name prefix used for every rule this service writes. Wildcard cleanup uses it.</summary>
    public const string RulePrefix = "FocusLockFamilyOffline-";

    private const int CheckIntervalSeconds = 10;
    private const int OfflineThresholdSeconds = 300;

    private readonly FamilyService _family;
    private readonly FamilyEnforcementService _enforce;
    private readonly CloudSyncService _cloud;
    private readonly ILogger<FirewallLockdownService> _log;

    /// <summary>Display names of rules this process has applied — used for targeted cleanup.</summary>
    private readonly HashSet<string> _appliedRuleNames = new(StringComparer.OrdinalIgnoreCase);
    private bool _currentlyLocked;

    public bool IsLocked => _currentlyLocked;

    public FirewallLockdownService(
        FamilyService family,
        FamilyEnforcementService enforce,
        CloudSyncService cloud,
        ILogger<FirewallLockdownService> log)
    {
        _family = family;
        _enforce = enforce;
        _cloud = cloud;
        _log = log;
    }

    public override async Task StartAsync(CancellationToken cancellationToken)
    {
        // A previous run of the daemon may have left rules behind if it crashed
        // before reaching StopAsync. Clean those up on startup with a wildcard
        // PowerShell call so the firewall starts in a known state.
        TryCleanupOrphanedRules();
        await base.StartAsync(cancellationToken);
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        // Best-effort cleanup on shutdown — we MUST not leave outbound blocks
        // applied across a daemon restart, that would silently break apps.
        try { ClearAllRules(); } catch { /* swallow during shutdown */ }
        await base.StopAsync(cancellationToken);
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            try
            {
                Evaluate();
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Firewall lockdown evaluation failed");
            }
            await Task.Delay(TimeSpan.FromSeconds(CheckIntervalSeconds), ct).ConfigureAwait(false);
        }
    }

    private void Evaluate()
    {
        var cfg = _family.Current;
        var shouldLock = cfg != null
            && cfg.FirewallLockdownEnabled
            && _cloud.OfflineSeconds >= OfflineThresholdSeconds
            && _enforce.HasActiveBlocks;

        if (shouldLock)
        {
            ApplyRules();
            _currentlyLocked = true;
            return;
        }

        if (_currentlyLocked)
        {
            ClearAllRules();
            _currentlyLocked = false;
        }
    }

    private void ApplyRules()
    {
        var (_, processes) = _enforce.GetUnion();
        if (processes.Count == 0) return;

        // Resolve each block target's executable path by looking at currently
        // running processes that match the name. Rules are keyed by full path
        // so a rename of just the file doesn't escape — the kid has to copy
        // the binary to a new path the rules don't know about.
        var paths = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var raw in processes)
        {
            if (string.IsNullOrEmpty(raw)) continue;
            var name = raw.EndsWith(".exe", StringComparison.OrdinalIgnoreCase)
                ? raw[..^4]
                : raw;
            Process[] running;
            try { running = Process.GetProcessesByName(name); }
            catch { continue; }
            foreach (var p in running)
            {
                try
                {
                    var path = p.MainModule?.FileName;
                    if (!string.IsNullOrEmpty(path)) paths.Add(path);
                }
                catch (Exception ex)
                {
                    // Access denied is common when the daemon isn't elevated
                    // (dev runs). Path lookup just fails for that PID.
                    _log.LogDebug(ex, "Could not read MainModule for PID {Pid}", p.Id);
                }
                finally { p.Dispose(); }
            }
        }

        if (paths.Count == 0) return;

        // Add rules we don't already have applied. Skip duplicates so we don't
        // re-shell-out to netsh every 10 seconds for the same set.
        foreach (var path in paths)
        {
            var ruleName = $"{RulePrefix}{Path.GetFileName(path)}";
            if (_appliedRuleNames.Contains(ruleName)) continue;

            var args = $"advfirewall firewall add rule name=\"{ruleName}\" dir=out action=block enable=yes profile=any program=\"{path}\"";
            if (RunNetsh(args))
            {
                _appliedRuleNames.Add(ruleName);
                _log.LogInformation("Firewall lockdown applied: {Path}", path);
            }
        }
    }

    private void ClearAllRules()
    {
        // Delete by exact name for every rule we tracked, then sweep with a
        // wildcard PowerShell call to catch any we might have lost track of
        // (e.g. due to a partial state from a crash mid-apply).
        foreach (var ruleName in _appliedRuleNames.ToArray())
        {
            RunNetsh($"advfirewall firewall delete rule name=\"{ruleName}\"");
            _appliedRuleNames.Remove(ruleName);
        }
        TryCleanupOrphanedRules();
        _log.LogInformation("Firewall lockdown cleared");
    }

    /// <summary>
    /// Sweeps any FocusLockFamilyOffline-* rules left over from a previous
    /// daemon run. Enumerates every firewall rule via `netsh show rule
    /// name=all`, picks out the names that carry our prefix, and deletes
    /// them one by one via `netsh ... delete rule name="..."`.
    ///
    /// Pre-v1.5.0 this shelled out to PowerShell's
    /// `Get-NetFirewallRule | Remove-NetFirewallRule` for the wildcard match,
    /// but managed/enterprise Windows images routinely ship with a restricted
    /// ExecutionPolicy (`AllSigned`, `Restricted`) that silently refuses the
    /// one-liner even when running as SYSTEM — leaving orphan rules in place
    /// across reboots. netsh is a signed Microsoft binary with no scripting
    /// policy attached, so the cleanup now works in those environments too.
    /// </summary>
    private void TryCleanupOrphanedRules()
    {
        try
        {
            var orphans = EnumerateOrphanedRuleNames();
            foreach (var ruleName in orphans)
            {
                RunNetsh($"advfirewall firewall delete rule name=\"{ruleName}\"");
            }
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Orphaned firewall rule cleanup failed");
        }
    }

    private HashSet<string> EnumerateOrphanedRuleNames()
    {
        var orphans = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var psi = new ProcessStartInfo
        {
            FileName = "netsh.exe",
            Arguments = "advfirewall firewall show rule name=all",
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var p = Process.Start(psi);
        if (p == null) return orphans;
        var output = p.StandardOutput.ReadToEnd();
        if (!p.WaitForExit(15_000)) { try { p.Kill(); } catch { } return orphans; }
        if (p.ExitCode != 0) return orphans;

        // netsh prints a block per rule; names are tagged with a line that
        // starts "Rule Name:" (localised Windows builds may use a different
        // leader, but the English leader is the one every piece of our docs
        // and tooling targets). Grab the first colon-separated value on each
        // such line.
        foreach (var raw in output.Split('\n'))
        {
            var line = raw.TrimStart();
            const string leader = "Rule Name:";
            if (!line.StartsWith(leader, StringComparison.OrdinalIgnoreCase)) continue;
            var name = line[leader.Length..].Trim();
            if (name.StartsWith(RulePrefix, StringComparison.OrdinalIgnoreCase))
            {
                orphans.Add(name);
            }
        }
        return orphans;
    }

    private bool RunNetsh(string args)
    {
        try
        {
            var psi = new ProcessStartInfo
            {
                FileName = "netsh.exe",
                Arguments = args,
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            using var p = Process.Start(psi);
            if (p == null) return false;
            if (!p.WaitForExit(10_000)) { try { p.Kill(); } catch { } return false; }
            if (p.ExitCode != 0)
            {
                var err = p.StandardError.ReadToEnd();
                _log.LogDebug("netsh failed ({Code}): {Err}", p.ExitCode, err);
                return false;
            }
            return true;
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "netsh invocation threw");
            return false;
        }
    }
}
