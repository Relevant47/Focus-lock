namespace FocusLock.Daemon.Models;

public sealed class FocusProfile
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string Name { get; set; } = string.Empty;
    public List<string> BlockedCategories { get; set; } = new();
    public List<string> CustomBlockedDomains { get; set; } = new();
    public List<string> CustomBlockedProcesses { get; set; } = new();
    public List<string> AllowlistedDomains { get; set; } = new();
    public int DefaultDurationMinutes { get; set; } = 25;
    public PomodoroConfig? PomodoroConfig { get; set; }
    public bool HardcoreMode { get; set; }
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

public sealed class ScheduledSession
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string ProfileId { get; set; } = string.Empty;
    public string CronExpression { get; set; } = string.Empty;
    public int DurationMinutes { get; set; }
    public bool Enabled { get; set; } = true;
    public string Label { get; set; } = string.Empty;
}

public sealed class SessionLog
{
    public string SessionId { get; set; } = string.Empty;
    public string? ProfileId { get; set; }
    public DateTime StartTime { get; set; }
    public DateTime? EndTime { get; set; }
    public bool Completed { get; set; }
    public int BlockAttempts { get; set; }
    public int FocusScore { get; set; }
    public string? Intention { get; set; }
}
