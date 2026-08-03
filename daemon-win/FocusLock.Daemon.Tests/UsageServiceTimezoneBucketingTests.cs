using System.Globalization;
using FocusLock.Daemon.Models;
using FocusLock.Daemon.Services;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FocusLock.Daemon.Tests;

/// <summary>
/// Phase 3 boundary test (Oscar's required coverage). Proves that the daemon
/// buckets a UTC wire timestamp into the correct <em>local</em> day when the
/// UTC instant straddles local midnight in either direction.
///
/// <para>
/// This is the single most load-bearing invariant of the Phase 1 contract
/// (docs/usage-analytics-schema.md §1.1): the tracker sends UTC, the daemon
/// converts to local at write time. A regression here means users see
/// "yesterday's" usage attributed to "today" (or vice-versa) — the exact bug
/// class the schema doc calls out as unacceptable for a personal-analytics
/// tool.
/// </para>
///
/// <para>
/// Uses <see cref="TimeZoneInfo.Local"/> + <see cref="DateTime.Today"/> so
/// the tests pass regardless of where CI (or a dev's laptop) is running.
/// The tests DO fail correctly if the daemon starts computing local day
/// from local time, or if it drops the timezone offset entirely.
/// </para>
/// </summary>
public sealed class UsageServiceTimezoneBucketingTests : IDisposable
{
    private readonly string _stateDir;
    private readonly string _dbPath;

    public UsageServiceTimezoneBucketingTests()
    {
        _stateDir = Path.Combine(Path.GetTempPath(),
            "UsageSvcTzTest_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_stateDir);
        _dbPath = Path.Combine(_stateDir, "usage.db");
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { if (Directory.Exists(_stateDir)) Directory.Delete(_stateDir, recursive: true); }
        catch { /* best effort */ }
    }

    private UsageService NewService() =>
        new(_stateDir, NullLogger<UsageService>.Instance, NullLoggerFactory.Instance);

    [Fact]
    public void HandleReportSample_WithUtcTimestamp30MinBeforeLocalMidnight_BucketsToYesterdayLocal()
    {
        using var svc = NewService();
        var (_, enOk) = svc.HandleEnable();
        Assert.True(enOk);

        // Yesterday 23:30 local — 30 min BEFORE today's local midnight.
        var localTarget = DateTime.Today.AddMinutes(-30);
        var expectedDay = localTarget.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        var utcMoment = TimeZoneInfo.ConvertTimeToUtc(localTarget, TimeZoneInfo.Local);
        var wireTs    = utcMoment.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

        svc.HandleReportSample(new UsageReportSamplePayload
        {
            BundleId  = "chrome.exe",
            AppName   = "Chrome",
            Seconds   = 30,
            InFocus   = true,
            Timestamp = wireTs,
        });

        var rows = svc.HandleQuery(new UsageQueryPayload
        {
            StartDate    = expectedDay,
            EndDate      = expectedDay,
            SplitByFocus = true,
        }).Rows;

        Assert.Single(rows);
        Assert.Equal(expectedDay, rows[0].Day);
        Assert.Equal(30, rows[0].Seconds);
    }

    [Fact]
    public void HandleReportSample_WithUtcTimestamp30MinAfterLocalMidnight_BucketsToTodayLocal()
    {
        using var svc = NewService();
        var (_, enOk) = svc.HandleEnable();
        Assert.True(enOk);

        // Today 00:30 local — 30 min AFTER today's local midnight.
        var localTarget = DateTime.Today.AddMinutes(30);
        var expectedDay = localTarget.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        var utcMoment = TimeZoneInfo.ConvertTimeToUtc(localTarget, TimeZoneInfo.Local);
        var wireTs    = utcMoment.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);

        svc.HandleReportSample(new UsageReportSamplePayload
        {
            BundleId  = "chrome.exe",
            AppName   = "Chrome",
            Seconds   = 30,
            InFocus   = true,
            Timestamp = wireTs,
        });

        var rows = svc.HandleQuery(new UsageQueryPayload
        {
            StartDate    = expectedDay,
            EndDate      = expectedDay,
            SplitByFocus = true,
        }).Rows;

        Assert.Single(rows);
        Assert.Equal(expectedDay, rows[0].Day);
        Assert.Equal(30, rows[0].Seconds);
    }
}
