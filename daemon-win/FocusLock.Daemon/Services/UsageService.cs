using System.Diagnostics;
using System.Globalization;
using FocusLock.Daemon.Models;
using FocusLock.Daemon.Storage;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Phase 2 owner of the usage-analytics DB. Holds the one long-lived
/// <see cref="UsageStore"/>, serialises all DB access under a single lock,
/// and implements the seven <c>usage.*</c> IPC handlers.
///
/// <para>
/// The "enabled" state is represented physically by the presence of
/// <c>%ProgramData%\FocusLock\usage.db</c>. <c>usage.disable</c> deletes the
/// file (per Oscar's constraint) rather than issuing <c>DELETE FROM</c> — so
/// on a fresh daemon start we simply check <c>File.Exists</c> to know whether
/// tracking is on. This makes enable/disable atomic against the filesystem
/// and keeps the "off" state indistinguishable from "never enabled".
/// </para>
/// </summary>
public sealed class UsageService : IDisposable
{
    private const string DefaultRetentionDays = "90";
    private const int    DefaultSampleRateSeconds = 5;

    /// <summary>Scheduled Task name. Must match the constant used in
    /// <c>FocusLock.Tracker.Program.TrackerName</c>.</summary>
    private const string ScheduledTaskName = "FocusLockUsageTracker";

    /// <summary>Filename the NSIS installer drops alongside
    /// <c>FocusLockDaemon.exe</c> in <c>%ProgramFiles%\FocusLock\</c>.</summary>
    private const string ScheduledTaskExeName = "FocusLockUsageTracker.exe";

    private readonly string _dbPath;
    private readonly ILogger<UsageService> _log;
    private readonly ILoggerFactory _factory;
    private readonly object _lock = new();
    private UsageStore? _store;
    private bool _disposed;

    /// <summary>
    /// Test seam. Tests inject a failing register to exercise the Enable
    /// rollback path (docs/usage-analytics-schema.md §Phase 2 — the DB file
    /// is deleted when the helper registration fails). Defaults to the
    /// no-op stub that Phase 3 will replace with the real helper install.
    /// </summary>
    public Func<(string? Err, bool Ok)> RegisterHelper { get; set; }

    /// <summary>Symmetric test seam for <see cref="HandleDisable"/>.</summary>
    public Func<(string? Err, bool Ok)> UnregisterHelper { get; set; }

    public UsageService(string stateDir, ILogger<UsageService> log, ILoggerFactory factory)
    {
        _log = log;
        _factory = factory;
        Directory.CreateDirectory(stateDir);
        _dbPath = Path.Combine(stateDir, "usage.db");

        RegisterHelper   = RegisterHelperStub;
        UnregisterHelper = UnregisterHelperStub;

        // Rehydrate: if a previous daemon lifetime enabled tracking, the DB
        // file survives across restarts. Re-open the connection so ongoing
        // sample reports don't silently no-op after a service restart.
        if (File.Exists(_dbPath))
        {
            try
            {
                _store = new UsageStore(_dbPath, _factory.CreateLogger<UsageStore>());
                _store.RunMigrations(); // idempotent
                _log.LogInformation("Usage tracking rehydrated from existing DB at {Path}", _dbPath);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Failed to reopen existing usage.db — treating as disabled");
                _store = null;
            }
        }
    }

    public bool IsEnabled
    {
        get { lock (_lock) return _store != null && File.Exists(_dbPath); }
    }

    // ── Enable / Disable (atomic per Oscar's constraints) ──────────────────

    public (string? Err, bool Ok) HandleEnable()
    {
        lock (_lock)
        {
            // Idempotent: already enabled → return ok without touching disk.
            if (_store != null && File.Exists(_dbPath))
                return (null, true);

            // Order (Oscar): (1) create DB → (2) migrations → (3) seed meta
            //                → (4) register helper (STUB) → (5) return ok.
            // On step-4 failure: File.Delete DB to roll back.
            try
            {
                _store = new UsageStore(_dbPath, _factory.CreateLogger<UsageStore>());
                _store.RunMigrations();
                _store.SeedMeta(
                    retentionDays: DefaultRetentionDays,
                    sampleRateSeconds: DefaultSampleRateSeconds,
                    enabledAtUtc: DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
                // SeedMeta uses INSERT OR IGNORE so it does not clobber a
                // previously-cleared enabled_at_utc from a partial re-enable.
                // Force-write the current-enable-streak marker + flag:
                _store.SetMeta("enabled", "1");
                _store.SetMeta("enabled_at_utc",
                    DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture));
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "usage.enable: DB initialisation failed");
                CloseStoreQuiet();
                DeleteDbQuiet();
                return ("Failed to initialise usage database", false);
            }

            var (regErr, regOk) = RegisterHelper();
            if (!regOk)
            {
                _log.LogWarning("usage.enable: register-helper failed ({Err}); rolling back DB", regErr);
                CloseStoreQuiet();
                DeleteDbQuiet();
                return (regErr ?? "Failed to register usage helper", false);
            }

            _log.LogInformation("usage.enable: tracking enabled, DB at {Path}", _dbPath);
            return (null, true);
        }
    }

    public (string? Err, bool Ok) HandleDisable()
    {
        lock (_lock)
        {
            // Order (Oscar): (1) unregister helper (STUB) → (2) delete DB
            //                → (3) return ok. Step-1 failure: DB stays.
            var (unregErr, unregOk) = UnregisterHelper();
            if (!unregOk)
            {
                _log.LogWarning("usage.disable: unregister-helper failed ({Err}); keeping DB", unregErr);
                return (unregErr ?? "Failed to unregister usage helper", false);
            }

            CloseStoreQuiet();
            try
            {
                DeleteDbAndSidecarsQuiet();
                // Primary DB is the source of truth for "did the wipe happen".
                // Sidecar failures are logged inside the helper; if the main
                // file is still there we surface an error.
                if (File.Exists(_dbPath))
                    return ("Failed to delete usage database", false);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "usage.disable: failed to delete DB file at {Path}", _dbPath);
                return ("Failed to delete usage database", false);
            }

            _log.LogInformation("usage.disable: tracking disabled, DB + sidecars removed");
            return (null, true);
        }
    }

    // ── Sample reporting ──────────────────────────────────────────────────

    public void HandleReportSample(UsageReportSamplePayload payload)
    {
        if (payload == null || string.IsNullOrEmpty(payload.BundleId) || payload.Seconds <= 0)
            return;

        lock (_lock)
        {
            if (_store == null) return; // silent no-op when disabled

            var day = DeriveDay(payload.Timestamp);
            var inFocus  = payload.InFocus ? payload.Seconds : 0;
            var outFocus = payload.InFocus ? 0                : payload.Seconds;
            var appName  = string.IsNullOrEmpty(payload.AppName) ? payload.BundleId : payload.AppName;

            try
            {
                _store.UpsertSample(
                    day: day,
                    userSid: string.Empty, // Phase 3 concern
                    bundleId: payload.BundleId,
                    appName: appName,
                    seconds: payload.Seconds,
                    inFocusSeconds: inFocus,
                    outFocusSeconds: outFocus);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "usage.report_sample: upsert failed for {Bundle}", payload.BundleId);
            }
        }
    }

    private static string DeriveDay(string timestamp)
    {
        // Task spec: "ISO-8601 → local date 'yyyy-MM-dd'". If the timestamp
        // is malformed, fall back to today (local) rather than dropping the
        // sample — the tracker's clock is closer to truth than our reject.
        if (DateTimeOffset.TryParse(
                timestamp, CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal, out var dto))
        {
            return dto.LocalDateTime.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        }
        return DateTime.Now.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
    }

    // ── Query / settings ──────────────────────────────────────────────────

    public UsageQueryResult HandleQuery(UsageQueryPayload payload)
    {
        lock (_lock)
        {
            if (_store == null || payload == null
                || string.IsNullOrEmpty(payload.StartDate)
                || string.IsNullOrEmpty(payload.EndDate))
            {
                return new UsageQueryResult();
            }

            var includeApps = payload.IncludeApps?.ToArray();
            var hasFilter   = includeApps != null && includeApps.Length > 0;

            var rows = _store.QueryRange(payload.StartDate, payload.EndDate, payload.TopN, includeApps);

            int? otherTotal = null;
            // Roll-up only when top_n truncated AND include_apps did not filter
            // (per docs/usage-analytics-schema.md §2.5). Exclude by bundle_id —
            // a top app's day-rows outside the top-N are still that app, not
            // "other apps."
            if (!hasFilter && payload.TopN.HasValue && payload.TopN.Value > 0)
            {
                var all = _store.QueryRange(payload.StartDate, payload.EndDate, topN: null, includeApps: null);
                if (all.Count > rows.Count)
                {
                    var topBundleIds = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var r in rows) topBundleIds.Add(r.BundleId);
                    int sum = 0;
                    foreach (var r in all)
                        if (!topBundleIds.Contains(r.BundleId))
                            sum += r.Seconds;
                    otherTotal = sum;
                }
            }

            return new UsageQueryResult { Rows = rows, OtherAppsTotalSeconds = otherTotal };
        }
    }

    public UsageGetSettingsResult HandleGetSettings()
    {
        lock (_lock)
        {
            if (_store == null)
            {
                return new UsageGetSettingsResult
                {
                    Enabled = false,
                    RetentionDays = DefaultRetentionDays,
                    SampleRateSeconds = DefaultSampleRateSeconds,
                    EnabledAtUtc = null,
                };
            }

            var retention = _store.GetMeta("retention_days") ?? DefaultRetentionDays;
            var rateStr   = _store.GetMeta("sample_rate_seconds")
                            ?? DefaultSampleRateSeconds.ToString(CultureInfo.InvariantCulture);
            var enabled   = _store.GetMeta("enabled") ?? "0";
            var enabledAt = _store.GetMeta("enabled_at_utc");

            int rate = DefaultSampleRateSeconds;
            int.TryParse(rateStr, NumberStyles.Integer, CultureInfo.InvariantCulture, out rate);

            return new UsageGetSettingsResult
            {
                Enabled           = enabled == "1",
                RetentionDays     = retention,
                SampleRateSeconds = rate,
                EnabledAtUtc      = string.IsNullOrEmpty(enabledAt) ? null : enabledAt,
            };
        }
    }

    public (string? Err, bool Ok) HandleSetSettings(UsageSetSettingsPayload payload)
    {
        lock (_lock)
        {
            if (_store == null) return ("Usage tracking is not enabled", false);
            if (payload == null) return ("Invalid payload", false);

            if (!string.IsNullOrEmpty(payload.RetentionDays))
            {
                if (!IsValidRetention(payload.RetentionDays))
                    return ("Invalid retention_days (allowed: 30, 90, 180, 365, forever)", false);
                _store.SetMeta("retention_days", payload.RetentionDays);
            }
            if (payload.SampleRateSeconds.HasValue)
            {
                if (payload.SampleRateSeconds.Value <= 0)
                    return ("sample_rate_seconds must be > 0", false);
                _store.SetMeta("sample_rate_seconds",
                    payload.SampleRateSeconds.Value.ToString(CultureInfo.InvariantCulture));
            }
            return (null, true);
        }
    }

    public (string? Err, bool Ok) HandleClearAllData()
    {
        lock (_lock)
        {
            if (_store == null) return ("Usage tracking is not enabled", false);

            // Preserve user settings across the wipe. Tracking stays on.
            var retention = _store.GetMeta("retention_days") ?? DefaultRetentionDays;
            var rateStr   = _store.GetMeta("sample_rate_seconds")
                            ?? DefaultSampleRateSeconds.ToString(CultureInfo.InvariantCulture);
            var enabledAt = _store.GetMeta("enabled_at_utc");
            if (string.IsNullOrEmpty(enabledAt))
                enabledAt = DateTime.UtcNow.ToString("O", CultureInfo.InvariantCulture);
            int rate = DefaultSampleRateSeconds;
            int.TryParse(rateStr, NumberStyles.Integer, CultureInfo.InvariantCulture, out rate);

            CloseStoreQuiet();
            try
            {
                DeleteDbAndSidecarsQuiet();
                if (File.Exists(_dbPath))
                    return ("Failed to clear usage database", false);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "usage.clear_all_data: failed to delete DB file");
                return ("Failed to clear usage database", false);
            }

            try
            {
                _store = new UsageStore(_dbPath, _factory.CreateLogger<UsageStore>());
                _store.RunMigrations();
                _store.SeedMeta(retention, rate, enabledAt);
                _store.SetMeta("enabled", "1");
                _store.SetMeta("enabled_at_utc", enabledAt);
            }
            catch (Exception ex)
            {
                _log.LogError(ex, "usage.clear_all_data: failed to recreate DB");
                _store = null;
                return ("Failed to recreate usage database", false);
            }
            return (null, true);
        }
    }

    // ── Retention ─────────────────────────────────────────────────────────

    /// <summary>
    /// Called from <see cref="DaemonWorker"/>'s 1-second tick. The tick
    /// itself gates the 24-hour cadence and the ≥5s-after-startup guard; we
    /// simply skip when tracking is disabled or the retention is 'forever'.
    /// </summary>
    public void RunRetentionIfDue(DateTime now)
    {
        lock (_lock)
        {
            if (_store == null) return;

            var retention = _store.GetMeta("retention_days") ?? DefaultRetentionDays;
            if (retention == "forever") return;

            if (!int.TryParse(retention, NumberStyles.Integer,
                    CultureInfo.InvariantCulture, out var days) || days <= 0)
            {
                _log.LogWarning("usage retention: invalid retention_days '{V}' — skipping prune", retention);
                return;
            }

            var cutoff = now.Date.AddDays(-days).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            try
            {
                var pruned = _store.PruneOlderThan(cutoff);
                if (pruned > 0)
                    _log.LogInformation("usage retention: pruned {N} rows older than {Cutoff}", pruned, cutoff);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "usage retention prune failed");
            }
        }
    }

    // ── Helper registration (Phase 3: real schtasks.exe wire-up) ─────────
    //
    // The Func<> seams (RegisterHelper / UnregisterHelper) still exist for
    // tests — see UsageServiceLifecycleTests. The default implementations
    // now shell out to schtasks.exe to (de)register a Standard-User
    // scheduled task that launches FocusLockUsageTracker.exe at logon.
    //
    // We chose schtasks.exe over TaskScheduler COM interop (Microsoft-Win32-
    // TaskScheduler NuGet, MMC APIs) to honour Phase 3's "no new NuGet deps"
    // constraint — schtasks ships with every supported Windows version.

    public (string? Err, bool Ok) RegisterHelperStub()
    {
        // schtasks.exe only exists on Windows. When the assembly is loaded on
        // a non-Windows host (dev laptop, cross-platform CI) treat register
        // as a silent no-op. This preserves the "default = safe no-op" contract
        // the Phase 2 lifecycle tests rely on (see the XML doc on
        // RegisterHelper) without inventing a separate test seam.
        if (!OperatingSystem.IsWindows())
        {
            _log.LogInformation("usage helper register: not on Windows — no-op");
            return (null, true);
        }

        try
        {
            var exePath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                "FocusLock", ScheduledTaskExeName);

            // /SC ONLOGON  — triggers when the interactive user signs in.
            // /RL LIMITED  — runs at Standard-User integrity (LUA-safe; the
            //                tracker only needs GetForegroundWindow +
            //                Process access to its own session).
            // /F           — overwrite an existing task with the same name.
            // NB: schtasks accepts /RU with a SID; we omit it so the task
            // runs as whichever user logs in (multi-user single-machine).
            var (exit, stdout, stderr) = RunSchtasks(
                "/Create", "/TN", ScheduledTaskName,
                "/SC",     "ONLOGON",
                "/RL",     "LIMITED",
                "/TR",     exePath,
                "/F");

            if (exit != 0)
            {
                _log.LogWarning(
                    "schtasks /Create failed (exit={Exit}): stdout='{Stdout}' stderr='{Stderr}'",
                    exit, stdout.Trim(), stderr.Trim());
                return ($"schtasks /Create failed (exit code {exit})", false);
            }

            _log.LogInformation("usage tracker scheduled task registered at {Path}", exePath);
            return (null, true);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "usage.enable: scheduled task registration threw");
            return (ex.Message, false);
        }
    }

    public (string? Err, bool Ok) UnregisterHelperStub()
    {
        // Symmetric non-Windows no-op — see RegisterHelperStub above.
        if (!OperatingSystem.IsWindows())
        {
            _log.LogInformation("usage helper unregister: not on Windows — no-op");
            return (null, true);
        }

        try
        {
            // Idempotent-disable per Oscar: a missing task must NOT surface as
            // an error. Query first — non-zero query means "not present" and
            // we short-circuit to success without touching the scheduler.
            var (queryExit, _, _) = RunSchtasks("/Query", "/TN", ScheduledTaskName);
            if (queryExit != 0)
            {
                _log.LogInformation(
                    "usage tracker scheduled task '{Name}' not present — unregister is a no-op",
                    ScheduledTaskName);
                return (null, true);
            }

            var (delExit, delOut, delErr) = RunSchtasks(
                "/Delete", "/TN", ScheduledTaskName, "/F");

            if (delExit != 0)
            {
                _log.LogWarning(
                    "schtasks /Delete failed (exit={Exit}): stdout='{Stdout}' stderr='{Stderr}'",
                    delExit, delOut.Trim(), delErr.Trim());
                return ($"schtasks /Delete failed (exit code {delExit})", false);
            }

            _log.LogInformation("usage tracker scheduled task unregistered");
            return (null, true);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "usage.disable: scheduled task removal threw");
            return (ex.Message, false);
        }
    }

    private static (int Exit, string Stdout, string Stderr) RunSchtasks(params string[] args)
    {
        var psi = new ProcessStartInfo("schtasks.exe")
        {
            RedirectStandardOutput = true,
            RedirectStandardError  = true,
            UseShellExecute        = false,
            CreateNoWindow         = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var proc = Process.Start(psi)
            ?? throw new InvalidOperationException("Failed to start schtasks.exe");
        var stdout = proc.StandardOutput.ReadToEnd();
        var stderr = proc.StandardError.ReadToEnd();
        proc.WaitForExit();
        return (proc.ExitCode, stdout, stderr);
    }

    // ── Internal helpers ──────────────────────────────────────────────────

    private static bool IsValidRetention(string s) =>
        s is "30" or "90" or "180" or "365" or "forever";

    private void CloseStoreQuiet()
    {
        if (_store == null) return;
        try { _store.Dispose(); } catch (Exception ex) { _log.LogDebug(ex, "UsageStore dispose raised"); }
        _store = null;
    }

    private void DeleteDbQuiet()
    {
        DeleteDbAndSidecarsQuiet();
    }

    /// <summary>
    /// Removes <c>usage.db</c> and every SQLite sidecar that could hold
    /// recoverable sample bytes. Rollback-journal mode (Microsoft.Data.Sqlite
    /// default) writes <c>usage.db-journal</c> during transactions; if the
    /// daemon is force-killed mid-transaction the journal survives. WAL mode
    /// would write <c>usage.db-wal</c> + <c>usage.db-shm</c>. We wipe all
    /// three unconditionally so a future switch to WAL — or a crash in
    /// rollback mode — cannot leave sample data on disk after disable /
    /// clear. Mirrors macOS's UsageService.swift wal/shm cleanup.
    /// Best-effort: a failing sidecar delete is logged but does not fail the
    /// disable/clear return — the primary DB is already gone.
    /// </summary>
    private void DeleteDbAndSidecarsQuiet()
    {
        foreach (var suffix in new[] { "", "-journal", "-wal", "-shm" })
        {
            var path = _dbPath + suffix;
            try { if (File.Exists(path)) File.Delete(path); }
            catch (Exception ex) { _log.LogWarning(ex, "Failed to delete {Path}", path); }
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        lock (_lock) CloseStoreQuiet();
    }
}
