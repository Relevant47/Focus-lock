using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FocusLock.Tracker;

/// <summary>
/// FocusLock Usage Tracker (Windows). A tiny per-user sample loop that polls
/// the foreground app every N seconds and pushes <c>usage.report_sample</c>
/// to the daemon over <c>\\.\pipe\focuslock</c>.
///
/// <para>
/// Registered as a Scheduled Task at LIMITED integrity (Standard User) via
/// <c>schtasks.exe</c> triggered by <c>usage.enable</c>. See
/// <c>Services/UsageService.RegisterScheduledTask</c> for the exact args.
/// Deregistered by <c>usage.disable</c>.
/// </para>
///
/// <para>
/// Oscar's locked constraints (repeated for the next reader):
/// <list type="bullet">
///   <item>Wire timestamp = UTC ISO-8601. Never compute local day.</item>
///   <item><c>in_focus</c> = FRESH <c>get_status</c> every sample. No caching.</item>
///   <item>NO idle pause. <c>IdleThresholdSeconds = int.MaxValue</c>.</item>
///   <item>Self-filter FocusLock's own processes before send.</item>
/// </list>
/// </para>
/// </summary>
internal static class Program
{
    // ── Tunables ────────────────────────────────────────────────────────────

    /// <summary>Spec: <c>const int IdleThresholdSeconds = int.MaxValue;</c>.
    /// Referenced nowhere — the field's existence documents the deliberate
    /// choice to never pause on idle.</summary>
    private const int IdleThresholdSeconds = int.MaxValue;

    /// <summary>Reconnect backoff. Starts at 1s, doubles up to 60s, resets on
    /// a successful connect. During disconnect we do NOT sample — a sample
    /// with the wrong <c>sessionActive</c> would rot the DB more than a gap
    /// in coverage.</summary>
    private const int BackoffStartSec = 1;
    private const int BackoffMaxSec   = 60;

    /// <summary>Re-fetch <c>usage.get_settings</c> every 5 min so that a UI
    /// change to <c>sample_rate_seconds</c> takes effect without a tracker
    /// restart. Also refreshed on every reconnect.</summary>
    private static readonly TimeSpan SettingsRefreshInterval = TimeSpan.FromMinutes(5);

    /// <summary>Milliseconds NamedPipeClientStream.Connect waits before
    /// throwing TimeoutException. Long enough to survive a slow daemon boot,
    /// short enough that the outer backoff loop stays responsive.</summary>
    private const int ConnectTimeoutMs = 3_000;

    /// <summary>Scheduled task name — must match the string used in
    /// <c>UsageService.RegisterScheduledTask</c>.</summary>
    private const string TrackerName = "FocusLockUsageTracker";

    // ── Self-filter (per Phase 3 spec) ──────────────────────────────────────

    private static readonly string[] SelfExeAllowExact = new[]
    {
        "FocusLockDaemon.exe",
        "FocusLockUsageTracker.exe",
        "FocusLock.exe",
    };

    private static bool ShouldFilter(string exePath, string appName)
    {
        if (exePath.Contains(@"\FocusLock\", StringComparison.OrdinalIgnoreCase))
            return true;
        if (appName.Contains("focuslock", StringComparison.OrdinalIgnoreCase))
            return true;
        var leaf = Path.GetFileName(exePath);
        foreach (var self in SelfExeAllowExact)
            if (string.Equals(leaf, self, StringComparison.OrdinalIgnoreCase))
                return true;
        return false;
    }

    // ── Wire helpers ────────────────────────────────────────────────────────

    /// <summary>UTC ISO-8601 with second precision + 'Z' — the shape the
    /// daemon's <c>DeriveDay</c> parser is tuned for.</summary>
    private static string NowUtcIso() =>
        DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

    private static bool ParseSessionActive(JsonElement? payload)
    {
        if (payload is null) return false;
        if (payload.Value.TryGetProperty("sessionActive", out var sa)
            && sa.ValueKind is JsonValueKind.True or JsonValueKind.False)
            return sa.GetBoolean();
        return false;
    }

    private static int ParseSampleRate(JsonElement? payload, int fallback)
    {
        if (payload is null) return fallback;
        if (!payload.Value.TryGetProperty("sample_rate_seconds", out var el))
            return fallback;
        if (el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out var n))
            return Math.Max(1, n);
        if (el.ValueKind == JsonValueKind.String
            && int.TryParse(el.GetString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var s))
            return Math.Max(1, s);
        return fallback;
    }

    /// <summary>Wire payload for <c>usage.report_sample</c>. snake_case matches
    /// docs/usage-analytics-schema.md §2.3 (scoped exception to the protocol's
    /// camelCase norm).</summary>
    private sealed class SamplePayload
    {
        [JsonPropertyName("bundle_id")] public string BundleId { get; set; } = "";
        [JsonPropertyName("app_name")]  public string AppName  { get; set; } = "";
        [JsonPropertyName("seconds")]   public int    Seconds  { get; set; }
        [JsonPropertyName("in_focus")]  public bool   InFocus  { get; set; }
        [JsonPropertyName("timestamp")] public string Timestamp { get; set; } = "";
        [JsonPropertyName("user_sid")]  public string UserSid  { get; set; } = "";  // Phase 3: always "" (multi-user is Phase 5+)
    }

    // ── Logging ─────────────────────────────────────────────────────────────

    private static readonly object LogLock = new();
    private static string LogPath { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "FocusLock", "usage-tracker.log");

    private static void Log(string msg)
    {
        var line = $"[{DateTime.UtcNow:yyyy-MM-ddTHH:mm:ssZ}] {msg}";
        try
        {
            lock (LogLock)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
                File.AppendAllText(LogPath, line + Environment.NewLine);
            }
        }
        catch
        {
            // Log write failures are non-fatal — the tracker's job is to
            // report samples, not to guarantee a log. Best-effort only.
        }
    }

    // ── Main loop ───────────────────────────────────────────────────────────

    public static int Main(string[] _args)
    {
        // Reference IdleThresholdSeconds so the compiler doesn't warn about an
        // unused const — the field is documentation, not dead code.
        _ = IdleThresholdSeconds;

        Log($"[{TrackerName}] starting; log={LogPath}");

        DaemonClient? client = null;
        int sampleRateSeconds = 5;
        var lastSettingsFetch = DateTime.MinValue;
        int backoffSec = BackoffStartSec;

        while (true)
        {
            // (a) Ensure connected. On failure: log + backoff + retry. DO NOT
            // sample while disconnected (would inject wrong sessionActive).
            if (client is null)
            {
                var c = new DaemonClient();
                try
                {
                    c.Connect(ConnectTimeoutMs);
                    client     = c;
                    backoffSec = BackoffStartSec;
                    Log($"[{TrackerName}] connected; fetching settings");
                    try
                    {
                        var resp = client.Request("usage.get_settings");
                        sampleRateSeconds = ParseSampleRate(resp, sampleRateSeconds);
                        lastSettingsFetch = DateTime.UtcNow;
                        Log($"[{TrackerName}] settings loaded; sample_rate={sampleRateSeconds}s");
                    }
                    catch (Exception ex)
                    {
                        Log($"[{TrackerName}] settings fetch failed on reconnect: {ex.Message}");
                        // Keep the current rate; retry on the next tick.
                    }
                }
                catch (Exception ex)
                {
                    try { c.Dispose(); } catch { }
                    Log($"[{TrackerName}] connect failed: {ex.Message}; backoff={backoffSec}s");
                    Thread.Sleep(TimeSpan.FromSeconds(backoffSec));
                    backoffSec = Math.Min(backoffSec * 2, BackoffMaxSec);
                    continue;
                }
            }

            // (b) Periodic settings refresh — UI may have changed sample_rate.
            if (DateTime.UtcNow - lastSettingsFetch > SettingsRefreshInterval)
            {
                try
                {
                    var resp = client.Request("usage.get_settings");
                    var newRate = ParseSampleRate(resp, sampleRateSeconds);
                    if (newRate != sampleRateSeconds)
                    {
                        Log($"[{TrackerName}] sample_rate changed {sampleRateSeconds}s -> {newRate}s");
                        sampleRateSeconds = newRate;
                    }
                    lastSettingsFetch = DateTime.UtcNow;
                }
                catch (Exception ex)
                {
                    Log($"[{TrackerName}] periodic settings refresh failed: {ex.Message} - will reconnect");
                    client.Close(); client = null;
                    continue;
                }
            }

            // (c) Foreground app. Skip the tick if we can't identify anything.
            var front = ForegroundApp.TryGet();
            if (front is null)
            {
                Thread.Sleep(TimeSpan.FromSeconds(sampleRateSeconds));
                continue;
            }
            if (ShouldFilter(front.Value.ExePath, front.Value.AppName))
            {
                // Self-filter: honour the tick cadence — don't fast-loop on the
                // (very common) case where the FocusLock UI is frontmost.
                Thread.Sleep(TimeSpan.FromSeconds(sampleRateSeconds));
                continue;
            }

            // (d) FRESH get_status per Oscar's constraint. On failure, treat
            // the pipe as dead and reconnect — never guess in_focus.
            bool inFocus;
            try
            {
                var statusResp = client.Request("get_status");
                inFocus = ParseSessionActive(statusResp);
            }
            catch (Exception ex)
            {
                Log($"[{TrackerName}] get_status failed: {ex.Message} - reconnecting");
                client.Close(); client = null;
                continue;
            }

            // (e) Build + send. Fire-and-forget on the caller's semantics; on
            // the wire we consume the {"type":"ok"} reply for pipe hygiene.
            try
            {
                client.SendFireAndForget("usage.report_sample", new SamplePayload
                {
                    BundleId  = front.Value.ExePath,
                    AppName   = front.Value.AppName,
                    Seconds   = sampleRateSeconds,
                    InFocus   = inFocus,
                    Timestamp = NowUtcIso(),
                    UserSid   = string.Empty,
                });
            }
            catch (Exception ex)
            {
                Log($"[{TrackerName}] report_sample failed: {ex.Message} - reconnecting");
                client.Close(); client = null;
                continue;
            }

            Thread.Sleep(TimeSpan.FromSeconds(sampleRateSeconds));
        }
        // Unreachable — infinite loop. The scheduled task stops the process
        // at logoff via session-end signal; no graceful shutdown path yet.
    }
}
