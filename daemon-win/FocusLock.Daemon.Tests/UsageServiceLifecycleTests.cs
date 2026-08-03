using FocusLock.Daemon.Models;
using FocusLock.Daemon.Services;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FocusLock.Daemon.Tests;

/// <summary>
/// Covers the atomic enable/disable ordering Oscar locked in:
/// <list type="bullet">
///   <item>Enable: create → migrate → seed → register → ok; register failure
///     deletes the DB.</item>
///   <item>Disable: unregister → delete DB → ok; unregister failure keeps
///     the DB and surfaces the error.</item>
///   <item>Report-sample is a silent no-op when disabled (must not touch
///     the filesystem).</item>
/// </list>
/// Tests use a per-test temp state dir so nothing lands under
/// <c>%ProgramData%\FocusLock</c>.
/// </summary>
public sealed class UsageServiceLifecycleTests : IDisposable
{
    private readonly string _stateDir;
    private readonly string _dbPath;

    public UsageServiceLifecycleTests()
    {
        _stateDir = Path.Combine(Path.GetTempPath(),
            "UsageSvcTest_" + Guid.NewGuid().ToString("N"));
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
    public void Enable_HappyPath_CreatesFileAndSeedsMeta()
    {
        using var svc = NewService();
        Assert.False(svc.IsEnabled);

        var (err, ok) = svc.HandleEnable();

        Assert.True(ok, $"expected ok, got '{err}'");
        Assert.Null(err);
        Assert.True(File.Exists(_dbPath));
        Assert.True(svc.IsEnabled);

        var settings = svc.HandleGetSettings();
        Assert.True(settings.Enabled);
        Assert.Equal("90", settings.RetentionDays);
        Assert.Equal(5, settings.SampleRateSeconds);
        Assert.False(string.IsNullOrEmpty(settings.EnabledAtUtc));
    }

    [Fact]
    public void Enable_RegisterHelperFailure_RollsBackDbFile()
    {
        using var svc = NewService();
        svc.RegisterHelper = () => ("simulated register failure", false);

        var (err, ok) = svc.HandleEnable();

        Assert.False(ok);
        Assert.Equal("simulated register failure", err);
        // Roll-back guarantee: the DB file must NOT be left behind.
        Assert.False(File.Exists(_dbPath));
        Assert.False(svc.IsEnabled);
    }

    [Fact]
    public void Disable_HappyPath_RemovesDbFile()
    {
        using var svc = NewService();
        var (_, enOk) = svc.HandleEnable();
        Assert.True(enOk);
        Assert.True(File.Exists(_dbPath));

        var (err, ok) = svc.HandleDisable();

        Assert.True(ok, $"expected ok, got '{err}'");
        Assert.False(File.Exists(_dbPath));
        Assert.False(svc.IsEnabled);
    }

    [Fact]
    public void Disable_UnregisterFailure_KeepsDbAndReturnsError()
    {
        using var svc = NewService();
        var (_, enOk) = svc.HandleEnable();
        Assert.True(enOk);

        svc.UnregisterHelper = () => ("simulated unregister failure", false);
        var (err, ok) = svc.HandleDisable();

        Assert.False(ok);
        Assert.Equal("simulated unregister failure", err);
        // Per Oscar: on step-1 failure, DB is untouched.
        Assert.True(File.Exists(_dbPath));
        Assert.True(svc.IsEnabled);
    }

    [Fact]
    public void HandleReportSample_WhenDisabled_NoOps_NoFileCreated()
    {
        using var svc = NewService();
        var payload = new UsageReportSamplePayload
        {
            BundleId  = "chrome.exe",
            AppName   = "Chrome",
            Seconds   = 5,
            InFocus   = false,
            Timestamp = DateTime.UtcNow.ToString("O"),
        };

        // Tracking was never enabled — the sample must be dropped silently.
        svc.HandleReportSample(payload);

        Assert.False(File.Exists(_dbPath));
        Assert.False(svc.IsEnabled);

        // A subsequent query is also empty (and does not create the DB).
        var q = svc.HandleQuery(new UsageQueryPayload
        {
            StartDate = "2026-07-01",
            EndDate   = "2026-07-31",
            SplitByFocus = true,
        });
        Assert.Empty(q.Rows);
        Assert.False(File.Exists(_dbPath));
    }

    [Fact]
    public void ReportSample_WhenEnabled_PersistsAggregatedRow()
    {
        // Sanity that the happy report path works end-to-end. Not strictly
        // in the required list, but adds trivial coverage of the wire-up.
        using var svc = NewService();
        var (_, enOk) = svc.HandleEnable();
        Assert.True(enOk);

        var ts = DateTimeOffset.Now.ToString("O");
        var day = DateTimeOffset.Parse(ts).LocalDateTime.ToString("yyyy-MM-dd");

        svc.HandleReportSample(new UsageReportSamplePayload
        {
            BundleId = "chrome.exe", AppName = "Chrome",
            Seconds = 30, InFocus = true, Timestamp = ts,
        });
        svc.HandleReportSample(new UsageReportSamplePayload
        {
            BundleId = "chrome.exe", AppName = "Chrome",
            Seconds = 20, InFocus = false, Timestamp = ts,
        });

        var q = svc.HandleQuery(new UsageQueryPayload
        {
            StartDate = day, EndDate = day, SplitByFocus = true,
        });
        Assert.Single(q.Rows);
        Assert.Equal(50, q.Rows[0].Seconds);
        Assert.Equal(30, q.Rows[0].InFocusSeconds);
        Assert.Equal(20, q.Rows[0].OutFocusSeconds);
    }
}
