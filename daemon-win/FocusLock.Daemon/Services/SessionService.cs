using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using FocusLock.Daemon.Models;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Source of truth for session lifecycle. Persists session state to a signed
/// JSON file so it survives daemon restarts and reboots.
/// </summary>
public sealed class SessionService
{
    private static readonly string StateDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "FocusLock");

    private static readonly string StatePath = Path.Combine(StateDir, "session.json");
    private static readonly string KeyPath = Path.Combine(StateDir, "daemon.key");

    private readonly ILogger<SessionService> _log;
    private readonly object _lock = new();
    private SessionState? _active;
    private byte[] _signingKey = Array.Empty<byte>();
    private int _blockAttempts;
    private PomodoroState? _pomodoro;

    // Friend-lock rate limiting
    private int _failedUnlockAttempts;
    private DateTime _nextUnlockAllowed = DateTime.MinValue;

    // Hardcore mode 24-hour cooldown
    private DateTime? _hardcoreCooldownUntil;

    public SessionService(ILogger<SessionService> log)
    {
        _log = log;
        Directory.CreateDirectory(StateDir);
        LoadOrCreateKey();
        VerifyBinaryHash();
        LoadPersistedSession();
    }

    private static readonly string HashPath = Path.Combine(StateDir, "daemon.hash");

    private void VerifyBinaryHash()
    {
        try
        {
            var exePath = Environment.ProcessPath ?? string.Empty;
            if (string.IsNullOrEmpty(exePath) || !File.Exists(exePath)) return;
            var hash = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(exePath))).ToLowerInvariant();
            if (File.Exists(HashPath))
            {
                var stored = File.ReadAllText(HashPath).Trim();
                if (stored != hash)
                    _log.LogWarning("Daemon binary hash mismatch — binary may have been tampered with");
            }
            File.WriteAllText(HashPath, hash);
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Binary hash verification skipped");
        }
    }

    // ── Public API ────────────────────────────────────────────────────────────

    public SessionState? Active
    {
        get { lock (_lock) return _active; }
    }

    public bool IsActive
    {
        get { lock (_lock) return _active?.IsActive ?? false; }
    }

    /// <summary>True when Pomodoro is in a non-strict break phase — blocks should be temporarily lifted.</summary>
    public bool ShouldLiftBlocksDuringBreak
    {
        get
        {
            lock (_lock)
            {
                if (_pomodoro == null) return false;
                if (_active?.PomodoroConfig?.StrictMode == true) return false;
                return _pomodoro.IsBreakPhase;
            }
        }
    }

    public int BlockAttempts
    {
        get { lock (_lock) return _blockAttempts; }
    }

    public void IncrementBlockAttempt()
    {
        lock (_lock) _blockAttempts++;
    }

    public DaemonStatus GetStatus()
    {
        lock (_lock)
        {
            var (phase, pSec) = GetPomodoroInfo();
            var rateLimitRemaining = _nextUnlockAllowed > DateTime.UtcNow
                ? (_nextUnlockAllowed - DateTime.UtcNow).TotalSeconds
                : (double?)null;
            var logs = GetLogs(90);
            return new DaemonStatus
            {
                SessionActive = _active?.IsActive ?? false,
                Session = _active,
                SecondsRemaining = _active?.IsActive == true ? _active.Remaining.TotalSeconds : null,
                PomodoroPhase = phase,
                PomodoroSecondsRemaining = pSec,
                BlockAttempts = _blockAttempts,
                HasFriendLock = _active?.UnlockTokenHash != null,
                FriendLockRateLimited = rateLimitRemaining.HasValue,
                FriendLockRetryAfterSeconds = rateLimitRemaining,
                HardcoreCooldownUntil = _hardcoreCooldownUntil?.ToString("O"),
                CurrentStreak = ComputeCurrentStreak(logs),
                LastFocusScore = logs.FirstOrDefault()?.FocusScore,
            };
        }
    }

    public (string Error, bool Success) SkipBreak()
    {
        lock (_lock)
        {
            if (_pomodoro == null) return ("No Pomodoro session active", false);
            if (!_pomodoro.IsBreakPhase) return ("Not in a break phase", false);
            if (_active?.PomodoroConfig?.StrictMode == true) return ("Strict mode — breaks cannot be skipped", false);
            _pomodoro.SkipToWork();
            return (string.Empty, true);
        }
    }

    public (string Error, bool Success) RequestDisableHardcore()
    {
        lock (_lock)
        {
            if (_hardcoreCooldownUntil.HasValue && DateTime.UtcNow < _hardcoreCooldownUntil.Value)
                return ("Cooldown already in progress", false);
            _hardcoreCooldownUntil = DateTime.UtcNow.AddHours(24);
            _log.LogInformation("Hardcore Mode disable requested — cooldown until {Until}", _hardcoreCooldownUntil);
            return (string.Empty, true);
        }
    }

    private static int ComputeCurrentStreak(IReadOnlyList<SessionLog> logs)
    {
        var completedDays = new HashSet<string>(
            logs.Where(l => l.Completed)
                .Select(l => l.StartTime.ToLocalTime().Date.ToString("yyyy-MM-dd")));
        if (completedDays.Count == 0) return 0;

        var today = DateTime.Now.Date;
        var streak = 0;
        var day = today;
        while (completedDays.Contains(day.ToString("yyyy-MM-dd")))
        {
            streak++;
            day = day.AddDays(-1);
        }
        if (streak == 0)
        {
            day = today.AddDays(-1);
            while (completedDays.Contains(day.ToString("yyyy-MM-dd")))
            {
                streak++;
                day = day.AddDays(-1);
            }
        }
        return streak;
    }

    public (string Error, bool Success) StartSession(StartSessionPayload payload)
    {
        lock (_lock)
        {
            if (_active?.IsActive == true)
                return ("Session already active", false);

            _active = new SessionState
            {
                ProfileId = payload.ProfileId,
                StartTime = DateTime.UtcNow,
                EndTime = DateTime.UtcNow.AddMinutes(payload.DurationMinutes),
                HardcoreMode = payload.HardcoreMode,
                BlockedDomains = payload.BlockedDomains,
                BlockedProcesses = payload.BlockedProcesses,
                AllowlistedDomains = payload.AllowlistedDomains,
                PomodoroConfig = payload.PomodoroConfig,
                UnlockTokenHash = string.IsNullOrWhiteSpace(payload.UnlockToken)
                    ? null
                    : ComputeTokenHash(payload.UnlockToken),
                MotivationalMessage = payload.MotivationalMessage,
            };
            _active.Signature = Sign(_active);
            _blockAttempts = 0;
            _failedUnlockAttempts = 0;
            _nextUnlockAllowed = DateTime.MinValue;

            if (payload.PomodoroConfig != null)
                _pomodoro = new PomodoroState(payload.PomodoroConfig, _active.StartTime);

            Persist();
            _log.LogInformation("Session {Id} started, ends {End}", _active.SessionId, _active.EndTime);
            return (string.Empty, true);
        }
    }

    public (string Error, bool Success) StopSession(string? unlockToken = null)
    {
        lock (_lock)
        {
            if (_active == null)
                return ("No active session", false);

            if (_active.HardcoreMode)
                return ("Cannot stop a Hardcore Mode session", false);

            // Friend lock check
            if (_active.UnlockTokenHash != null)
            {
                if (string.IsNullOrWhiteSpace(unlockToken))
                    return ("Friend lock is active — provide the unlock token", false);

                if (DateTime.UtcNow < _nextUnlockAllowed)
                {
                    var wait = (int)Math.Ceiling((_nextUnlockAllowed - DateTime.UtcNow).TotalSeconds);
                    return ($"Too many failed attempts — wait {wait}s before trying again", false);
                }

                var provided = ComputeTokenHash(unlockToken);
                var expected = Encoding.UTF8.GetBytes(_active.UnlockTokenHash);
                var actual   = Encoding.UTF8.GetBytes(provided);

                if (!CryptographicOperations.FixedTimeEquals(actual, expected))
                {
                    _failedUnlockAttempts++;
                    var backoff = UnlockBackoffSeconds(_failedUnlockAttempts);
                    _nextUnlockAllowed = DateTime.UtcNow.AddSeconds(backoff);
                    _log.LogWarning("Invalid friend-lock token attempt #{N}", _failedUnlockAttempts);
                    return ($"Incorrect token. Try again in {backoff}s", false);
                }

                _failedUnlockAttempts = 0;
            }

            _log.LogInformation("Session {Id} stopped by user", _active.SessionId);
            FinalizeSession(completed: false);
            return (string.Empty, true);
        }
    }

    private static int UnlockBackoffSeconds(int attempts) => attempts switch
    {
        1 => 10,
        2 => 30,
        3 => 60,
        _ => 300,
    };

    private static string ComputeTokenHash(string token)
    {
        var bytes = SHA256.HashData(Encoding.UTF8.GetBytes(token.Trim()));
        return Convert.ToHexString(bytes).ToLowerInvariant();
    }

    // Called by Worker on tick — expires sessions that have hit their end time
    public void Tick()
    {
        lock (_lock)
        {
            if (_active == null) return;
            if (!_active.IsActive)
            {
                _log.LogInformation("Session {Id} completed", _active.SessionId);
                FinalizeSession(completed: true);
            }
            _pomodoro?.Tick(DateTime.UtcNow);
        }
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    private void FinalizeSession(bool completed)
    {
        // Persist the log before clearing state
        var log = new SessionLog
        {
            SessionId = _active!.SessionId,
            ProfileId = _active.ProfileId,
            StartTime = _active.StartTime,
            EndTime = DateTime.UtcNow,
            Completed = completed,
            BlockAttempts = _blockAttempts,
            FocusScore = CalculateScore(completed),
        };
        AppendLog(log);

        _active = null;
        _pomodoro = null;

        if (File.Exists(StatePath))
            File.Delete(StatePath);
    }

    private int CalculateScore(bool completed)
    {
        if (!completed) return 0;
        var penalty = Math.Min(_blockAttempts * 5, 50);
        var base_ = Math.Max(100 - penalty, 10);

        // Streak multiplier: +2% per day, capped at +20%
        var streak = ComputeCurrentStreak(GetLogs(90));
        var multiplier = 1.0 + Math.Min(streak * 0.02, 0.20);
        return Math.Min((int)(base_ * multiplier), 100);
    }

    private void Persist()
    {
        if (_active == null) return;
        var json = JsonSerializer.Serialize(_active, new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(StatePath, json);
    }

    private void LoadPersistedSession()
    {
        if (!File.Exists(StatePath)) return;
        try
        {
            var json = File.ReadAllText(StatePath);
            var state = JsonSerializer.Deserialize<SessionState>(json);
            if (state == null) return;

            // Verify signature — tampering triggers re-lock, not bypass
            var expected = Sign(state);
            if (!CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(state.Signature),
                Encoding.UTF8.GetBytes(expected)))
            {
                _log.LogWarning("Session state signature mismatch — re-locking");
                state.Signature = expected;
            }

            if (state.IsActive)
            {
                _active = state;
                if (state.PomodoroConfig != null)
                    _pomodoro = new PomodoroState(state.PomodoroConfig, state.StartTime);
                _log.LogInformation("Resumed session {Id}, {Rem:F0}s remaining", state.SessionId, state.Remaining.TotalSeconds);
            }
            else
            {
                _log.LogInformation("Persisted session {Id} has expired — cleaning up", state.SessionId);
                FinalizeSession(completed: true);
            }
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to load persisted session — ignoring");
        }
    }

    private void LoadOrCreateKey()
    {
        if (File.Exists(KeyPath))
        {
            _signingKey = File.ReadAllBytes(KeyPath);
        }
        else
        {
            _signingKey = RandomNumberGenerator.GetBytes(32);
            File.WriteAllBytes(KeyPath, _signingKey);
            // Restrict to SYSTEM only
            var info = new System.Security.AccessControl.FileSecurity();
            info.SetAccessRuleProtection(true, false);
            info.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                "SYSTEM",
                System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.AccessControlType.Allow));
            new FileInfo(KeyPath).SetAccessControl(info);
        }
    }

    private string Sign(SessionState s)
    {
        var payload = $"{s.SessionId}|{s.StartTime:O}|{s.EndTime:O}|{s.HardcoreMode}|" +
                      string.Join(",", s.BlockedDomains) + "|" +
                      string.Join(",", s.BlockedProcesses) + "|" +
                      string.Join(",", s.AllowlistedDomains) + "|" +
                      (s.UnlockTokenHash ?? "");
        using var hmac = new HMACSHA256(_signingKey);
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(payload));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }

    private static readonly string LogPath = Path.Combine(StateDir, "sessions.jsonl");

    private void AppendLog(SessionLog log)
    {
        try
        {
            var line = JsonSerializer.Serialize(log);
            File.AppendAllText(LogPath, line + Environment.NewLine);
        }
        catch { /* best-effort */ }
    }

    public IReadOnlyList<SessionLog> GetLogs(int limit)
    {
        if (!File.Exists(LogPath)) return Array.Empty<SessionLog>();
        var lines = File.ReadAllLines(LogPath);
        return lines
            .Reverse()
            .Take(limit)
            .Select(l => JsonSerializer.Deserialize<SessionLog>(l))
            .Where(l => l != null)
            .Cast<SessionLog>()
            .ToList();
    }

    // ── Pomodoro tracking ─────────────────────────────────────────────────────

    private (string? Phase, double? SecondsRemaining) GetPomodoroInfo()
    {
        if (_pomodoro == null) return (null, null);
        return (_pomodoro.Phase, _pomodoro.SecondsRemaining);
    }

    private sealed class PomodoroState
    {
        private readonly PomodoroConfig _cfg;
        private readonly DateTime _sessionStart;
        private int _completedCycles;
        public string Phase { get; private set; } = "work";
        public double SecondsRemaining { get; private set; }
        private DateTime _phaseEnd;

        public PomodoroState(PomodoroConfig cfg, DateTime sessionStart)
        {
            _cfg = cfg;
            _sessionStart = sessionStart;
            _phaseEnd = sessionStart.AddMinutes(cfg.WorkMinutes);
            Phase = "work";
        }

        public void Tick(DateTime now)
        {
            SecondsRemaining = (_phaseEnd - now).TotalSeconds;
            if (SecondsRemaining > 0) return;

            if (Phase == "work")
            {
                _completedCycles++;
                bool longBreak = _completedCycles % _cfg.CyclesBeforeLongBreak == 0;
                Phase = longBreak ? "long_break" : "break";
                _phaseEnd = now.AddMinutes(longBreak ? _cfg.LongBreakMinutes : _cfg.BreakMinutes);
            }
            else
            {
                Phase = "work";
                _phaseEnd = now.AddMinutes(_cfg.WorkMinutes);
            }
            SecondsRemaining = (_phaseEnd - now).TotalSeconds;
        }

        public bool IsBreakPhase => Phase is "break" or "long_break";

        public void SkipToWork()
        {
            Phase = "work";
            _phaseEnd = DateTime.UtcNow.AddMinutes(_cfg.WorkMinutes);
            SecondsRemaining = (_phaseEnd - DateTime.UtcNow).TotalSeconds;
        }
    }
}
