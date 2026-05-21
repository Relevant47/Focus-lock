using System.Security.AccessControl;
using System.Security.Principal;
using System.Text.Json;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Append-only audit log for parental-control events. Mirrors the sessions.jsonl
/// pattern: one JSON record per line at %ProgramData%\FocusLock\parent.audit.jsonl.
/// Surfaced to a verified parent via get_parent_audit IPC.
/// </summary>
public sealed class ParentAuditService
{
    private static readonly string StateDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "FocusLock");

    private static readonly string LogPath = Path.Combine(StateDir, "parent.audit.jsonl");

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly ILogger<ParentAuditService> _log;
    private readonly object _writeLock = new();
    private bool _aclApplied;

    public ParentAuditService(ILogger<ParentAuditService> log)
    {
        _log = log;
        Directory.CreateDirectory(StateDir);
    }

    public void Record(string eventType, string? command = null, string? detail = null)
    {
        var entry = new ParentAuditEntry
        {
            Timestamp = DateTime.UtcNow,
            Event = eventType,
            Command = command,
            Detail = detail,
        };
        try
        {
            var json = JsonSerializer.Serialize(entry, JsonOpts);
            lock (_writeLock)
            {
                File.AppendAllText(LogPath, json + Environment.NewLine);
                EnsureAcl();
            }
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to record parent audit event {Event}", eventType);
        }
    }

    /// <summary>Returns the most recent <paramref name="limit"/> entries, newest first.</summary>
    public IReadOnlyList<ParentAuditEntry> Recent(int limit)
    {
        if (!File.Exists(LogPath)) return Array.Empty<ParentAuditEntry>();
        try
        {
            var lines = File.ReadAllLines(LogPath);
            return lines
                .Reverse()
                .Take(limit)
                .Select(l => JsonSerializer.Deserialize<ParentAuditEntry>(l, JsonOpts))
                .Where(e => e != null)
                .Cast<ParentAuditEntry>()
                .ToList();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to read parent audit log");
            return Array.Empty<ParentAuditEntry>();
        }
    }

    private void EnsureAcl()
    {
        // Apply ACL once per process lifetime — after the first append creates the file.
        // Mirrors parent.cred / parent.tokenkey: SYSTEM + Administrators only.
        if (_aclApplied) return;
        try
        {
            var info = new FileSecurity();
            info.SetAccessRuleProtection(true, false);
            info.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            info.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(LogPath).SetAccessControl(info);
            _aclApplied = true;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not restrict ACL on parent audit log");
        }
    }
}

public sealed class ParentAuditEntry
{
    public DateTime Timestamp { get; set; }
    public string Event { get; set; } = string.Empty;
    public string? Command { get; set; }
    public string? Detail { get; set; }
}

/// <summary>Wire-stable event names for the parent audit log.</summary>
public static class ParentAuditEvents
{
    public const string PinSet              = "pin_set";
    public const string PinChanged          = "pin_changed";
    public const string PinCleared          = "pin_cleared";
    public const string PinVerifySuccess    = "pin_verify_success";
    public const string PinVerifyFail       = "pin_verify_fail";
    public const string PinVerifyRateLimit  = "pin_verify_rate_limited";
    public const string GateBlocked         = "gate_blocked";
    public const string GateAllowed         = "gate_allowed";
    public const string FamilyPaired        = "family_paired";
    public const string FamilyUnpaired      = "family_unpaired";
    public const string FamilyOffline5Min   = "family_offline_5min";
    public const string FamilyReconnected   = "family_reconnected";
    public const string FamilyCacheTampered = "family_cache_tampered";
}
