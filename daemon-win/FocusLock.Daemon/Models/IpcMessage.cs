using System.Text.Json.Serialization;
using FocusLock.Daemon.Services;

namespace FocusLock.Daemon.Models;

// ── Requests ────────────────────────────────────────────────────────────────

public sealed class IpcRequest
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("payload")]
    public System.Text.Json.JsonElement? Payload { get; set; }
}

public sealed class StartSessionPayload
{
    public string? ProfileId { get; set; }
    public int DurationMinutes { get; set; }
    public List<string> BlockedDomains { get; set; } = new();
    public List<string> BlockedProcesses { get; set; } = new();
    public List<string> AllowlistedDomains { get; set; } = new();
    public bool HardcoreMode { get; set; }
    public PomodoroConfig? PomodoroConfig { get; set; }
    public string? UnlockToken { get; set; }
    public string? MotivationalMessage { get; set; }
    public string? Intention { get; set; }
}

public sealed class RecordBlockAttemptPayload
{
    public string? Domain { get; set; }
    public string? Process { get; set; }
    public string? Label { get; set; }
}

public sealed class StopSessionPayload
{
    public string? UnlockToken { get; set; }
    public string? ParentToken { get; set; }
}

// ── Parental Controls ───────────────────────────────────────────────────────

public sealed class SetParentPinPayload
{
    public string Pin { get; set; } = string.Empty;
    public string? OldPin { get; set; }
}

public sealed class VerifyRecoveryKeyPayload
{
    public string Key { get; set; } = string.Empty;
}

public sealed class RegenerateRecoveryKeyPayload
{
    public string Pin { get; set; } = string.Empty;
}

public sealed class RecoveryKeyResponsePayload
{
    public string Key { get; set; } = string.Empty;
}

public sealed class VerifyParentPinPayload
{
    public string Pin { get; set; } = string.Empty;
}

public sealed class ChangeParentPinPayload
{
    public string OldPin { get; set; } = string.Empty;
    public string NewPin { get; set; } = string.Empty;
}

public sealed class ClearParentPinPayload
{
    public string Pin { get; set; } = string.Empty;
}

public sealed class ParentTokenResponsePayload
{
    public string Token { get; set; } = string.Empty;
    public string ExpiresAt { get; set; } = string.Empty;
}

public sealed class ParentControlsState
{
    public bool Enabled { get; set; }
    public bool RateLimited { get; set; }
    public double? RetryAfterSeconds { get; set; }
    public int GraceMinutes { get; set; }
}

// ── Responses ────────────────────────────────────────────────────────────────

public sealed class IpcResponse
{
    [JsonPropertyName("type")]
    public string Type { get; set; } = string.Empty;

    [JsonPropertyName("payload")]
    public object? Payload { get; set; }

    [JsonPropertyName("message")]
    public string? Message { get; set; }

    [JsonPropertyName("code")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Code { get; set; }

    public static IpcResponse Ok() => new() { Type = "ok" };
    public static IpcResponse Pong() => new() { Type = "pong" };
    public static IpcResponse Error(string msg) => new() { Type = "error", Message = msg };
    public static IpcResponse Error(string msg, string code) => new() { Type = "error", Message = msg, Code = code };
    public static IpcResponse Status(DaemonStatus s) => new() { Type = "status", Payload = s };
    public static IpcResponse Profiles(IEnumerable<FocusProfile> p) => new() { Type = "profiles", Payload = p };
    public static IpcResponse Logs(IEnumerable<SessionLog> l) => new() { Type = "logs", Payload = l };
    public static IpcResponse Schedules(IEnumerable<ScheduledSession> s) => new() { Type = "schedules", Payload = s };
    public static IpcResponse ParentToken(ParentTokenResponsePayload p) => new() { Type = "parent_token", Payload = p };
    public static IpcResponse ParentAudit(IEnumerable<ParentAuditEntry> entries) => new() { Type = "parent_audit", Payload = entries };
    public static IpcResponse RecoveryKey(string key) => new() { Type = "recovery_key", Payload = new RecoveryKeyResponsePayload { Key = key } };
    public static IpcResponse OkWithRecoveryKey(string key) => new() { Type = "ok_with_recovery_key", Payload = new RecoveryKeyResponsePayload { Key = key } };
    public static IpcResponse FamilyStatus(FamilyStatus s) => new() { Type = "family_status", Payload = s };
    public static IpcResponse FamilyPaired(FamilyRedeemResult r) => new() { Type = "family_paired", Payload = r };
    public static IpcResponse FamilyEnvironment(FamilyEnvironment e) => new() { Type = "family_environment", Payload = e };
}

public sealed class DaemonStatus
{
    public string Version { get; set; } = "1.1.3";
    public bool SessionActive { get; set; }
    public SessionState? Session { get; set; }
    public double? SecondsRemaining { get; set; }
    public string? PomodoroPhase { get; set; }
    public double? PomodoroSecondsRemaining { get; set; }
    public int BlockAttempts { get; set; }
    public bool HasFriendLock { get; set; }
    public bool FriendLockRateLimited { get; set; }
    public double? FriendLockRetryAfterSeconds { get; set; }
    public string? HardcoreCooldownUntil { get; set; }
    public int CurrentStreak { get; set; }
    public int? LastFocusScore { get; set; }
    public ParentControlsState ParentControls { get; set; } = new();
    public FamilyStatus Family { get; set; } = new();
}
