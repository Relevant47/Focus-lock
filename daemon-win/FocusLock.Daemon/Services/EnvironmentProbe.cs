using System.DirectoryServices.AccountManagement;
using System.Runtime.Versioning;
using System.Security.Principal;
using FocusLock.Daemon.Models;
using Microsoft.Win32;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Reads a small snapshot of "is this host hardened?" facts for the parent
/// setup flow. Includes per-user admin enumeration so the parent UI can name
/// which accounts need to be demoted before pairing.
/// </summary>
[SupportedOSPlatform("windows")]
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
            LocalUsers     = EnumerateLocalUsers(),
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

    private List<LocalUserAccount> EnumerateLocalUsers()
    {
        var users = new List<LocalUserAccount>();
        try
        {
            using var ctx = new PrincipalContext(ContextType.Machine);

            // Build admin-SID set by enumerating the local Administrators group.
            // Walk only direct members; group-of-groups is rare on a home box.
            // Lookup by SID rather than name so we work on non-English Windows.
            var adminSids = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var builtinAdminSid = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null).Value;
            using (var adminGrp = GroupPrincipal.FindByIdentity(ctx, IdentityType.Sid, builtinAdminSid))
            {
                if (adminGrp != null)
                {
                    foreach (var m in adminGrp.GetMembers(false))
                    {
                        if (m.Sid != null) adminSids.Add(m.Sid.Value);
                        m.Dispose();
                    }
                }
            }

            // Daemon runs as SYSTEM so WindowsIdentity.GetCurrent() returns
            // SYSTEM — not a useful "is this the kid's account?" signal. We
            // can't reliably tell on a service who's interactively logged in
            // without a session-enumeration API; leave IsCurrent off for now
            // and let the UI surface based on the SAM name.
            using var search = new PrincipalSearcher(new UserPrincipal(ctx));
            foreach (var principal in search.FindAll())
            {
                if (principal is not UserPrincipal p || p.Sid == null) continue;
                var rid = ExtractRid(p.Sid);
                users.Add(new LocalUserAccount
                {
                    Name      = p.SamAccountName ?? "(unknown)",
                    IsAdmin   = adminSids.Contains(p.Sid.Value),
                    IsBuiltIn = rid.HasValue && rid.Value < 1000,
                    IsCurrent = false,
                });
                p.Dispose();
            }
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Local user enumeration failed");
        }
        return users;
    }

    /// <summary>Last numeric component of a SID (the RID). Built-in accounts have RID &lt; 1000.</summary>
    private static int? ExtractRid(SecurityIdentifier sid)
    {
        var s = sid.Value;
        var last = s.LastIndexOf('-');
        if (last < 0 || last == s.Length - 1) return null;
        return int.TryParse(s[(last + 1)..], out var rid) ? rid : null;
    }
}
