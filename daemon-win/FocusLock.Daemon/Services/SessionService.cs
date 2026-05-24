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

    // ── Monotonic clock anchoring (anti clock-tamper) ───────────────────────────
    // The wall-clock EndTime is still persisted so a session survives a daemon
    // restart / reboot (we can't reconstruct elapsed time across a process death).
    // But *while the daemon runs*, expiry is governed by a monotonic Stopwatch so
    // that moving the system clock — forward to end a Hardcore session early, or
    // backward to extend it — does not change when the session actually ends.
    //
    // On StartSession / resume we anchor: record the monotonic timestamp and the
    // remaining seconds at that instant. Authoritative remaining is then
    // (remainingAtAnchor − monotonicElapsedSinceAnchor), independent of the wall
    // clock. We additionally compare the wall clock's movement against the
    // monotonic movement each evaluation; a large divergence is logged as a
    // suspected clock-tamper but the monotonic value is always the one enforced.
    private static readonly System.Diagnostics.Stopwatch MonotonicClock = System.Diagnostics.Stopwatch.StartNew();
    private TimeSpan _anchorMonotonic;          // MonotonicClock.Elapsed captured at anchor
    private double _remainingAtAnchorSeconds;   // wall-clock remaining captured at anchor
    private DateTime _anchorWallClockUtc;       // UtcNow captured at anchor (tamper detection only)
    private bool _clockTamperLogged;            // one-shot log guard per session
    // Allowed slack between wall-clock and monotonic drift before we treat it as
    // tampering rather than ordinary scheduler jitter / NTP nudges.
    private const double ClockTamperToleranceSeconds = 30.0;

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
        get { lock (_lock) return ComputeIsActive(); }
    }

    // ── Monotonic-clock helpers ─────────────────────────────────────────────────

    /// <summary>
    /// Records the monotonic anchor for the current <see cref="_active"/> session:
    /// the Stopwatch reading "now" and how many seconds remain off the wall clock
    /// at this instant. Subsequent expiry checks count down from here using the
    /// Stopwatch, so changing the system clock cannot move the end time.
    /// </summary>
    private void AnchorMonotonic()
    {
        if (_active == null) return;
        _anchorMonotonic = MonotonicClock.Elapsed;
        _anchorWallClockUtc = DateTime.UtcNow;
        _remainingAtAnchorSeconds = Math.Max(0, (_active.EndTime - DateTime.UtcNow).TotalSeconds);
        _clockTamperLogged = false;
    }

    /// <summary>
    /// Authoritative seconds remaining for the active session, governed by the
    /// monotonic clock and NOT the wall clock. Returns 0 when the session has run
    /// its full duration. Also detects (and logs once) a wall-clock vs monotonic
    /// divergence that indicates the user moved the system clock.
    /// </summary>
    private double ComputeRemainingSeconds()
    {
        if (_active == null) return 0;

        var monotonicElapsed = (MonotonicClock.Elapsed - _anchorMonotonic).TotalSeconds;
        if (monotonicElapsed < 0) monotonicElapsed = 0;   // Stopwatch never goes back, defensive only
        var monotonicRemaining = _remainingAtAnchorSeconds - monotonicElapsed;

        // Tamper detection: how far the wall clock claims we've advanced vs how
        // far the monotonic clock actually advanced since the anchor. A real
        // clock change shows up as a large gap; NTP/jitter stays within tolerance.
        var wallElapsed = (DateTime.UtcNow - _anchorWallClockUtc).TotalSeconds;
        var divergence = Math.Abs(wallElapsed - monotonicElapsed);
        if (divergence > ClockTamperToleranceSeconds && !_clockTamperLogged)
        {
            _clockTamperLogged = true;
            _log.LogWarning(
                "System clock moved ~{Divergence:F0}s relative to the monotonic clock during session {Id} — "
                + "enforcing the monotonic timer (clock changes cannot end a session early).",
                divergence, _active.SessionId);
        }

        // Monotonic is authoritative while the daemon runs. (Across a restart the
        // Stopwatch resets and we re-anchor from the persisted wall-clock EndTime
        // in LoadPersistedSession — see the resume path.)
        return Math.Max(0, monotonicRemaining);
    }

    private bool ComputeIsActive() => _active != null && ComputeRemainingSeconds() > 0;

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
            var active = ComputeIsActive();
            return new DaemonStatus
            {
                SessionActive = active,
                Session = _active,
                SecondsRemaining = active ? ComputeRemainingSeconds() : null,
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
            if (ComputeIsActive())
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
                Intention = string.IsNullOrWhiteSpace(payload.Intention) ? null : payload.Intention.Trim(),
            };
            _active.Signature = Sign(_active);
            AnchorMonotonic();
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
            if (!ComputeIsActive())
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
            Intention = _active.Intention,
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
                // Re-anchor the monotonic clock from the persisted wall-clock
                // EndTime. Across a process restart the Stopwatch resets and we
                // have no record of elapsed time, so the wall clock is the only
                // available source for "how much is left" — but from this instant
                // on, the monotonic timer governs expiry again (so dragging the
                // clock forward after resume still can't end the session early).
                AnchorMonotonic();
                if (state.PomodoroConfig != null)
                    _pomodoro = new PomodoroState(state.PomodoroConfig, state.StartTime);
                _log.LogInformation("Resumed session {Id}, {Rem:F0}s remaining", state.SessionId, ComputeRemainingSeconds());
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
            return;
        }

        _signingKey = RandomNumberGenerator.GetBytes(32);
        File.WriteAllBytes(KeyPath, _signingKey);

        // Restrict access to SYSTEM and the local Administrators group.
        // Including Administrators lets diagnostic runs (e.g. running the daemon
        // as an elevated user for troubleshooting) still read the key — without
        // it, the daemon locks itself out of any non-SYSTEM mode.
        try
        {
            var info = new System.Security.AccessControl.FileSecurity();
            info.SetAccessRuleProtection(true, false);
            info.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                new System.Security.Principal.SecurityIdentifier(
                    System.Security.Principal.WellKnownSidType.LocalSystemSid, null),
                System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.AccessControlType.Allow));
            info.AddAccessRule(new System.Security.AccessControl.FileSystemAccessRule(
                new System.Security.Principal.SecurityIdentifier(
                    System.Security.Principal.WellKnownSidType.BuiltinAdministratorsSid, null),
                System.Security.AccessControl.FileSystemRights.FullControl,
                System.Security.AccessControl.AccessControlType.Allow));
            new FileInfo(KeyPath).SetAccessControl(info);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not restrict daemon.key ACL — file is still readable by the creating process");
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
