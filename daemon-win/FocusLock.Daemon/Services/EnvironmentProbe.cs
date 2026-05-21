using System.Security.Principal;
using FocusLock.Daemon.Models;
using Microsoft.Win32;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Reads a small snapshot of "is this host hardened?" facts for the parent
/// setup flow. Intentionally narrow — listing every local user + their group
/// memberships lives in the Phase 2.5 onboarding walkthrough where it can
/// drive UI step-by-step, not in this read-once probe.
/// </summary>
public sealed class EnvironmentProbe
{
    private readonly ILogger<EnvironmentProbe> _log;

    public EnvironmentProbe(ILogger<EnvironmentProbe> log) => _log = log;

    public FamilyEnvironment Probe()
    {
        return new FamilyEnvironment
        {
            Platform       = "windows",
            OsVersion      = Environment.OSVersion.Version.ToString(),
            DaemonElevated = IsRunningAsSystem(),
            UacEnabled     = ReadUacEnabled(),
            CurrentUser    = SafeUserName(),
        };
    }

    private static string? SafeUserName()
    {
        try { return WindowsIdentity.GetCurrent().Name; }
        catch { return null; }
    }

    private static bool IsRunningAsSystem()
    {
        try
        {
            using var id = WindowsIdentity.GetCurrent();
            var systemSid = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            return id.Owner != null && id.Owner.Equals(systemSid);
        }
        catch { return false; }
    }

    private bool? ReadUacEnabled()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(
                @"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System");
            if (key == null) return null;
            var v = key.GetValue("EnableLUA");
            if (v is int i) return i != 0;
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "UAC probe failed");
        }
        return null;
    }
}
