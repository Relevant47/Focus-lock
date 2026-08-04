using FocusLock.Daemon.Storage;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FocusLock.Daemon.Tests;

/// <summary>
/// Unit tests for <see cref="UsageStore"/>. Each test uses a private temp DB
/// path so parallel test runs stay isolated.
/// </summary>
public sealed class UsageStoreTests : IDisposable
{
    private readonly string _dbPath;

    public UsageStoreTests()
    {
        _dbPath = Path.Combine(Path.GetTempPath(),
            "UsageStoreTest_" + Guid.NewGuid().ToString("N") + ".db");
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { if (File.Exists(_dbPath)) File.Delete(_dbPath); } catch { /* best effort */ }
    }

    private UsageStore NewStore() => new(_dbPath, NullLogger<UsageStore>.Instance);

    [Fact]
    public void RunMigrations_OnEmptyDb_CreatesTablesAndIndex()
    {
        using (var store = NewStore()) store.RunMigrations();

        using var conn = new SqliteConnection($"Data Source={_dbPath}");
        conn.Open();
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        using var cmd = conn.CreateCommand();
        cmd.CommandText =
            "SELECT name FROM sqlite_master WHERE type IN ('table','index')";
        using var reader = cmd.ExecuteReader();
        while (reader.Read()) names.Add(reader.GetString(0));

        Assert.Contains("usage_samples", names);
        Assert.Contains("usage_meta",    names);
        Assert.Contains("idx_usage_day", names);
    }

    [Fact]
    public void UpsertSample_IdempotentOnPk_SumsSeconds()
    {
        using var store = NewStore();
        store.RunMigrations();

        store.UpsertSample("2026-07-20", "", "chrome.exe", "Chrome", seconds: 60, inFocusSeconds: 40, outFocusSeconds: 20);
        store.UpsertSample("2026-07-20", "", "chrome.exe", "Chrome", seconds: 30, inFocusSeconds: 20, outFocusSeconds: 10);
        // Different bundle_id → separate row.
        store.UpsertSample("2026-07-20", "", "code.exe",   "VS Code", seconds: 100, inFocusSeconds: 100, outFocusSeconds: 0);

        var rows = store.QueryRange("2026-07-20", "2026-07-20", topN: null, includeApps: null);
        Assert.Equal(2, rows.Count);

        var chrome = rows.Single(r => r.BundleId == "chrome.exe");
        Assert.Equal(90, chrome.Seconds);
        Assert.Equal(60, chrome.InFocusSeconds);
        Assert.Equal(30, chrome.OutFocusSeconds);
    }

    [Fact]
    public void QueryRange_RespectsRangeTopNAndIncludeApps()
    {
        using var store = NewStore();
        store.RunMigrations();

        store.UpsertSample("2026-07-18", "", "chrome.exe", "Chrome",  100, 100, 0);
        store.UpsertSample("2026-07-19", "", "code.exe",   "VS Code", 200, 200, 0);
        store.UpsertSample("2026-07-19", "", "slack.exe",  "Slack",    50,   0, 50);
        store.UpsertSample("2026-07-20", "", "chrome.exe", "Chrome",   30,  30, 0);

        // Date range: only 2026-07-19 rows.
        var justOneDay = store.QueryRange("2026-07-19", "2026-07-19", topN: null, includeApps: null);
        Assert.Equal(2, justOneDay.Count);
        Assert.Contains(justOneDay, r => r.BundleId == "code.exe");
        Assert.Contains(justOneDay, r => r.BundleId == "slack.exe");

        // topN = 1 across the full range: highest-seconds row wins.
        var topOne = store.QueryRange("2026-07-18", "2026-07-20", topN: 1, includeApps: null);
        Assert.Single(topOne);
        Assert.Equal("code.exe", topOne[0].BundleId);

        // include_apps filter: only chrome rows.
        var chromeOnly = store.QueryRange("2026-07-18", "2026-07-20", topN: null, includeApps: new[] { "chrome.exe" });
        Assert.Equal(2, chromeOnly.Count);
        Assert.All(chromeOnly, r => Assert.Equal("chrome.exe", r.BundleId));
    }

    [Fact]
    public void QueryRange_TopN_SelectsTopUniqueApps_ReturnsAllTheirDays()
    {
        // Regression test for #323: `top_n` limits (day, bundle_id) pairs
        // instead of unique apps, so the Usage chart is nearly empty for
        // multi-day ranges. Set-up: 5 days, 3 apps; the two busiest apps by
        // total seconds should each contribute their full set of day rows.
        using var store = NewStore();
        store.RunMigrations();

        // code.exe: 4 days, total 400s → most-used
        store.UpsertSample("2026-07-16", "", "code.exe",   "VS Code",  50,  50, 0);
        store.UpsertSample("2026-07-17", "", "code.exe",   "VS Code", 150, 150, 0);
        store.UpsertSample("2026-07-18", "", "code.exe",   "VS Code", 100, 100, 0);
        store.UpsertSample("2026-07-19", "", "code.exe",   "VS Code", 100, 100, 0);
        // chrome.exe: 3 days, total 300s → second most-used
        store.UpsertSample("2026-07-16", "", "chrome.exe", "Chrome",  100, 100, 0);
        store.UpsertSample("2026-07-18", "", "chrome.exe", "Chrome",  100, 100, 0);
        store.UpsertSample("2026-07-20", "", "chrome.exe", "Chrome",  100, 100, 0);
        // slack.exe: 1 day, total 30s → excluded from top-2
        store.UpsertSample("2026-07-17", "", "slack.exe",  "Slack",    30,   0, 30);

        var rows = store.QueryRange("2026-07-16", "2026-07-20", topN: 2, includeApps: null);

        // Every code.exe day AND every chrome.exe day must be present — 7 rows,
        // NOT the 2 rows a naive `LIMIT 2` on the grouped result would return.
        Assert.Equal(7, rows.Count);
        var codeDays   = rows.Where(r => r.BundleId == "code.exe").Select(r => r.Day).OrderBy(d => d).ToArray();
        var chromeDays = rows.Where(r => r.BundleId == "chrome.exe").Select(r => r.Day).OrderBy(d => d).ToArray();
        Assert.Equal(new[] { "2026-07-16", "2026-07-17", "2026-07-18", "2026-07-19" }, codeDays);
        Assert.Equal(new[] { "2026-07-16", "2026-07-18", "2026-07-20" }, chromeDays);
        // slack.exe is outside the top-2 unique apps.
        Assert.DoesNotContain(rows, r => r.BundleId == "slack.exe");
    }

    [Fact]
    public void PruneOlderThan_DeletesMatchingRowsAndReturnsCount()
    {
        using var store = NewStore();
        store.RunMigrations();

        store.UpsertSample("2026-07-10", "", "chrome.exe", "Chrome", 10, 10, 0);
        store.UpsertSample("2026-07-15", "", "chrome.exe", "Chrome", 20, 20, 0);
        store.UpsertSample("2026-07-20", "", "chrome.exe", "Chrome", 30, 30, 0);

        var pruned = store.PruneOlderThan("2026-07-16");
        Assert.Equal(2, pruned);

        var remaining = store.QueryRange("2026-07-01", "2026-08-01", topN: null, includeApps: null);
        Assert.Single(remaining);
        Assert.Equal("2026-07-20", remaining[0].Day);

        // Second prune at the same cutoff: no rows to delete.
        Assert.Equal(0, store.PruneOlderThan("2026-07-16"));
    }

    [Fact]
    public void Meta_SetAndGet_RoundTrips_ReplaceSemantics()
    {
        using var store = NewStore();
        store.RunMigrations();

        Assert.Null(store.GetMeta("nope"));

        store.SetMeta("k1", "v1");
        Assert.Equal("v1", store.GetMeta("k1"));

        // INSERT OR REPLACE — second write overrides.
        store.SetMeta("k1", "v2");
        Assert.Equal("v2", store.GetMeta("k1"));

        // SeedMeta uses INSERT OR IGNORE — must NOT clobber a mutated value.
        store.SeedMeta(retentionDays: "365", sampleRateSeconds: 10, enabledAtUtc: "seed-ts");
        store.SetMeta("retention_days", "30");
        store.SeedMeta(retentionDays: "365", sampleRateSeconds: 10, enabledAtUtc: "later-ts");
        Assert.Equal("30", store.GetMeta("retention_days"));
    }
}
