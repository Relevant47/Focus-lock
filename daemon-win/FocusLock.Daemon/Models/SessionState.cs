using System.Text.Json.Serialization;

namespace FocusLock.Daemon.Models;

public sealed class PomodoroConfig
{
    public int WorkMinutes { get; set; } = 25;
    public int BreakMinutes { get; set; } = 5;
    public int LongBreakMinutes { get; set; } = 15;
    public int CyclesBeforeLongBreak { get; set; } = 4;
    public bool StrictMode { get; set; } = false;
}

public sealed class SessionState
{
    public string SessionId { get; set; } = Guid.NewGuid().ToString();
    public string? ProfileId { get; set; }
    public DateTime StartTime { get; set; }
    public DateTime EndTime { get; set; }
    public bool HardcoreMode { get; set; }
    public List<string> BlockedDomains { get; set; } = new();
    public List<string> BlockedProcesses { get; set; } = new();
    public List<string> AllowlistedDomains { get; set; } = new();
    public PomodoroConfig? PomodoroConfig { get; set; }
    public string? UnlockTokenHash { get; set; }
    public string? MotivationalMessage { get; set; }
    // Intention is NOT signed — it's user-supplied text, not a security boundary.
    public string? Intention { get; set; }

    // HMAC-SHA256 of all fields above (excluding Signature, MotivationalMessage, Intention)
    public string Signature { get; set; } = string.Empty;

    // Derived — not stored.
    // NOTE: these are *wall-clock* views, used only as the anchor when a session
    // is loaded from disk after a daemon restart. The authoritative live expiry
    // check is SessionService.ComputeIsActive()/ComputeRemainingSeconds(), which
    // counts down on a monotonic Stopwatch so moving the system clock can't end a
    // session early (or extend it). Don't use these for live enforcement.
    [JsonIgnore]
    public bool IsActive => DateTime.UtcNow < EndTime;

    [JsonIgnore]
    public TimeSpan Remaining => EndTime - DateTime.UtcNow;
}
