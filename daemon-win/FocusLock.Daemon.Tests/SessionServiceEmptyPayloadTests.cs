using FocusLock.Daemon.Models;
using FocusLock.Daemon.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace FocusLock.Daemon.Tests;

/// <summary>
/// Covers the new "session must block at least one site or app" guard added
/// to <see cref="SessionService.StartSession"/>. Each test gets its own
/// throwaway state directory under TEMP via the internal test-only ctor, so
/// nothing leaks into %ProgramData%\FocusLock.
/// </summary>
public sealed class SessionServiceEmptyPayloadTests : IDisposable
{
    private readonly string _stateDir;

    public SessionServiceEmptyPayloadTests()
    {
        _stateDir = Path.Combine(Path.GetTempPath(), "FocusLockTest_" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(_stateDir);
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_stateDir))
                Directory.Delete(_stateDir, recursive: true);
        }
        catch { /* best effort */ }
    }


    [Fact]
    public void StartSession_RejectsEmptyPayload_WithBothListsEmpty()
    {
        var svc = NewService();
        var payload = new StartSessionPayload
        {
            DurationMinutes = 25,
            BlockedDomains = new List<string>(),
            BlockedProcesses = new List<string>(),
            AllowlistedDomains = new List<string>(),
        };

        var (error, success) = svc.StartSession(payload);

        Assert.False(success);
        Assert.Equal("Session must block at least one site or app", error);
        Assert.False(svc.IsActive);
    }

    [Fact]
    public void StartSession_AcceptsDomainOnlyPayload()
    {
        var svc = NewService();
        var payload = new StartSessionPayload
        {
            DurationMinutes = 25,
            BlockedDomains = new List<string> { "example.com" },
            BlockedProcesses = new List<string>(),
            AllowlistedDomains = new List<string>(),
        };

        var (error, success) = svc.StartSession(payload);

        try
        {
            Assert.True(success, $"expected success, got error '{error}'");
            Assert.Equal(string.Empty, error);
            Assert.True(svc.IsActive);
        }
        finally
        {
            // Don't leak an active session into the disk state for the
            // next test run.
            svc.StopSession();
        }
    }

    [Fact]
    public void StartSession_AcceptsProcessOnlyPayload()
    {
        var svc = NewService();
        var payload = new StartSessionPayload
        {
            DurationMinutes = 25,
            BlockedDomains = new List<string>(),
            BlockedProcesses = new List<string> { "chrome.exe" },
            AllowlistedDomains = new List<string>(),
        };

        var (error, success) = svc.StartSession(payload);

        try
        {
            Assert.True(success, $"expected success, got error '{error}'");
            Assert.True(svc.IsActive);
        }
        finally
        {
            svc.StopSession();
        }
    }

    private SessionService NewService()
    {
        // Internal test-seam ctor — no DoH service, state under our per-test
        // temp dir. The DoH path is exercised by BrowserDohPolicyServiceTests;
        // here we just want the StartSession validation branch.
        return new SessionService(NullLogger<SessionService>.Instance, doh: null, stateDir: _stateDir);
    }
}
