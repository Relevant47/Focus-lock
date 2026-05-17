using System.Text.Json.Serialization;

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

    public static IpcResponse Ok() => new() { Type = "ok" };
    public static IpcResponse Pong() => new() { Type = "pong" };
    public static IpcResponse Error(string msg) => new() { Type = "error", Message = msg };
    public static IpcResponse Status(DaemonStatus s) => new() { Type = "status", Payload = s };
    public static IpcResponse Profiles(IEnumerable<FocusProfile> p) => new() { Type = "profiles", Payload = p };
    public static IpcResponse Logs(IEnumerable<SessionLog> l) => new() { Type = "logs", Payload = l };
    public static IpcResponse Schedules(IEnumerable<ScheduledSession> s) => new() { Type = "schedules", Payload = s };
}

public sealed class DaemonStatus
{
    public string Version { get; set; } = "1.0.0";
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
}
