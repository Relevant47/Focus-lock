using System.Runtime.Versioning;
using FocusLock.Daemon.Services;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Win32;
using Xunit;

namespace FocusLock.Daemon.Tests;

/// <summary>
/// Integration tests for <see cref="BrowserDohPolicyService"/>. They exercise
/// the real Win32 registry under a sandbox subtree at
/// <c>HKCU\Software\FocusLockTest_{guid}</c> via a thin subclass that
/// overrides <c>OpenRoot()</c>. Each test cleans up the subtree on dispose.
/// </summary>
[Trait("Category", "Integration")]
[SupportedOSPlatform("windows")]
public sealed class BrowserDohPolicyServiceTests : IDisposable
{
    private readonly string _sandboxRoot;
    private readonly string _backupPath;
    private readonly TestableDohService _svc;

    public BrowserDohPolicyServiceTests()
    {
        // Unique per-test root so parallel test runs don't trample each other.
        _sandboxRoot = "Software\\FocusLockTest_" + Guid.NewGuid().ToString("N");
        _backupPath = Path.Combine(Path.GetTempPath(), $"doh_backup_{Guid.NewGuid():N}.json");
        _svc = new TestableDohService(_sandboxRoot, _backupPath);
    }

    public void Dispose()
    {
        try
        {
            Registry.CurrentUser.DeleteSubKeyTree(_sandboxRoot, throwOnMissingSubKey: false);
        }
        catch { /* best effort */ }
        try
        {
            if (File.Exists(_backupPath)) File.Delete(_backupPath);
        }
        catch { /* best effort */ }
    }

    [Fact]
    public void Apply_SetsAllFourKeysToOff_WhenNoneExist()
    {
        _svc.Apply();

        Assert.Equal("off",
            ReadString(@"Software\Policies\Google\Chrome", "DnsOverHttpsMode"));
        Assert.Equal("off",
            ReadString(@"Software\Policies\Microsoft\Edge", "DnsOverHttpsMode"));
        Assert.Equal("off",
            ReadString(@"Software\Policies\BraveSoftware\Brave", "DnsOverHttpsMode"));
        Assert.Equal(0,
            ReadDword(@"Software\Policies\Mozilla\Firefox\DNSOverHTTPS", "Enabled"));
    }

    [Fact]
    public void Apply_WritesBackupJson_OnFirstCall()
    {
        Assert.False(File.Exists(_backupPath));
        _svc.Apply();
        Assert.True(File.Exists(_backupPath));
    }

    [Fact]
    public void Apply_DoesNotOverwriteBackup_OnSecondCall()
    {
        // Pre-seed an original value the user supposedly had.
        WriteString(@"Software\Policies\Google\Chrome", "DnsOverHttpsMode", "automatic");

        _svc.Apply();
        var firstBackup = File.ReadAllText(_backupPath);

        // Now the registry holds "off" — if Apply re-snapshotted, we'd lock
        // in "off" as the user preference and lose "automatic" forever.
        _svc.Apply();
        var secondBackup = File.ReadAllText(_backupPath);

        Assert.Equal(firstBackup, secondBackup);
        Assert.Contains("automatic", firstBackup);
    }

    [Fact]
    public void Apply_IsIdempotent_WhenAlreadyOff()
    {
        _svc.Apply();
        var firstWrite = File.GetLastWriteTimeUtc(_backupPath);

        // No throw, no change.
        _svc.Apply();
        var secondWrite = File.GetLastWriteTimeUtc(_backupPath);

        Assert.Equal(firstWrite, secondWrite);
        Assert.Equal("off",
            ReadString(@"Software\Policies\Google\Chrome", "DnsOverHttpsMode"));
    }

    [Fact]
    public void Restore_PutsBackOriginalStringValue()
    {
        WriteString(@"Software\Policies\Google\Chrome", "DnsOverHttpsMode", "automatic");
        WriteString(@"Software\Policies\Microsoft\Edge", "DnsOverHttpsMode", "secure");

        _svc.Apply();
        _svc.Restore();

        Assert.Equal("automatic",
            ReadString(@"Software\Policies\Google\Chrome", "DnsOverHttpsMode"));
        Assert.Equal("secure",
            ReadString(@"Software\Policies\Microsoft\Edge", "DnsOverHttpsMode"));
    }

    [Fact]
    public void Restore_PutsBackOriginalDwordValue()
    {
        WriteDword(@"Software\Policies\Mozilla\Firefox\DNSOverHTTPS", "Enabled", 2);

        _svc.Apply();
        _svc.Restore();

        Assert.Equal(2,
            ReadDword(@"Software\Policies\Mozilla\Firefox\DNSOverHTTPS", "Enabled"));
    }

    [Fact]
    public void Restore_DeletesValue_WhenOriginallyUnset()
    {
        // Nothing exists pre-Apply; Apply creates the off-value; Restore must
        // remove it so the registry ends in the same shape it started.
        _svc.Apply();
        Assert.Equal("off",
            ReadString(@"Software\Policies\Google\Chrome", "DnsOverHttpsMode"));

        _svc.Restore();
        Assert.Null(
            ReadString(@"Software\Policies\Google\Chrome", "DnsOverHttpsMode"));
    }

    [Fact]
    public void Restore_DeletesBackupFile()
    {
        _svc.Apply();
        Assert.True(File.Exists(_backupPath));

        _svc.Restore();
        Assert.False(File.Exists(_backupPath));
    }

    [Fact]
    public void Restore_NoOp_WhenNoBackupExists()
    {
        // Should not throw even when called without a prior Apply().
        _svc.Restore();
        Assert.False(File.Exists(_backupPath));
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    private string? ReadString(string subKey, string name)
    {
        using var sub = Registry.CurrentUser.OpenSubKey(_sandboxRoot + "\\" + subKey);
        return sub?.GetValue(name) as string;
    }

    private int? ReadDword(string subKey, string name)
    {
        using var sub = Registry.CurrentUser.OpenSubKey(_sandboxRoot + "\\" + subKey);
        var v = sub?.GetValue(name);
        return v == null ? null : Convert.ToInt32(v);
    }

    private void WriteString(string subKey, string name, string value)
    {
        using var sub = Registry.CurrentUser.CreateSubKey(_sandboxRoot + "\\" + subKey)!;
        sub.SetValue(name, value, RegistryValueKind.String);
    }

    private void WriteDword(string subKey, string name, int value)
    {
        using var sub = Registry.CurrentUser.CreateSubKey(_sandboxRoot + "\\" + subKey)!;
        sub.SetValue(name, value, RegistryValueKind.DWord);
    }

    /// <summary>
    /// Test-only subclass that re-roots all registry operations under
    /// <c>HKCU\{prefix}</c> instead of HKLM. This lets the test run as a
    /// non-elevated user without needing admin rights.
    /// </summary>
    private sealed class TestableDohService : BrowserDohPolicyService
    {
        private readonly string _prefix;

        public TestableDohService(string prefix, string backupPath)
            : base(NullLogger<BrowserDohPolicyService>.Instance, backupPath)
        {
            _prefix = prefix;
        }

        protected override RegistryKey OpenRoot()
        {
            // Open HKCU and create the sandbox prefix if necessary, then hand
            // back a subkey that *acts* as a fake HKLM root: any
            // "Software\Policies\..." path the production code asks for
            // resolves under our prefix.
            var hkcu = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Default);
            var rooted = hkcu.CreateSubKey(_prefix, writable: true)!;
            hkcu.Dispose();
            return rooted;
        }
    }
}
