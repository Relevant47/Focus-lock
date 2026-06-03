using System.Runtime.Versioning;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Win32;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Forces Chrome / Edge / Brave / Firefox to use the system DNS resolver while
/// a session is active. Without this, browser DNS-over-HTTPS bypasses the
/// Windows hosts file — the daemon writes <c>127.0.0.1 youtube.com</c>
/// correctly, but the browser never asks the OS to resolve it, so the block is
/// invisible to the user.
/// <para>
/// Apply() backs up the prior registry values to
/// <c>%ProgramData%\FocusLock\doh_backup.json</c> once, writes the "off"
/// values, and is idempotent on subsequent calls. Restore() reads the backup
/// and either rewrites the original value or deletes the value if it was not
/// previously set, then deletes the backup file.
/// </para>
/// </summary>
[SupportedOSPlatform("windows")]
public class BrowserDohPolicyService
{
    private static readonly string StateDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "FocusLock");

    private static readonly string BackupPath = Path.Combine(StateDir, "doh_backup.json");

    // The four registry locations we force to "off" during a session. Chrome,
    // Edge and Brave share a string-valued "DnsOverHttpsMode" key under their
    // respective policy roots; Firefox uses a DWORD under a nested subkey.
    private static readonly DohPolicyKey[] Keys =
    [
        new(@"Software\Policies\Google\Chrome",            "DnsOverHttpsMode", DohValueKind.String, "off"),
        new(@"Software\Policies\Microsoft\Edge",           "DnsOverHttpsMode", DohValueKind.String, "off"),
        new(@"Software\Policies\BraveSoftware\Brave",      "DnsOverHttpsMode", DohValueKind.String, "off"),
        new(@"Software\Policies\Mozilla\Firefox\DNSOverHTTPS", "Enabled",      DohValueKind.Dword,  0),
    ];

    private readonly ILogger<BrowserDohPolicyService> _log;
    private readonly string _backupPath;
    private readonly object _lock = new();

    public BrowserDohPolicyService(ILogger<BrowserDohPolicyService> log)
        : this(log, BackupPath) { }

    // Test seam: lets unit tests redirect the backup JSON path so they don't
    // collide with a real daemon's backup file or require ProgramData write
    // access.
    internal BrowserDohPolicyService(ILogger<BrowserDohPolicyService> log, string backupPath)
    {
        _log = log;
        _backupPath = backupPath;
        Directory.CreateDirectory(Path.GetDirectoryName(_backupPath)!);
    }

    /// <summary>
    /// Force browser DoH off across all four roots, after backing up prior
    /// values on first call. Safe to call repeatedly — subsequent calls
    /// reapply the "off" value but never overwrite the backup, so the
    /// original user preference is preserved across the whole session.
    /// </summary>
    public virtual void Apply()
    {
        lock (_lock)
        {
            // If a backup already exists on disk we leave it alone — it
            // captured the *original* user preference, which is what we need
            // to restore. Re-snapshotting now would lock in our own "off"
            // value as the user's preference, defeating the restore.
            Dictionary<string, BackupEntry> backup = LoadBackup();
            bool backupExisted = backup.Count > 0 || File.Exists(_backupPath);

            foreach (var key in Keys)
            {
                try
                {
                    if (!backupExisted && !backup.ContainsKey(key.Id))
                        backup[key.Id] = ReadCurrent(key);

                    if (IsAlreadyOff(key))
                        continue;

                    WriteOff(key);
                    _log.LogInformation("DoH policy applied: {Path}\\{Name}", key.SubKey, key.ValueName);
                }
                catch (UnauthorizedAccessException ex)
                {
                    _log.LogWarning(ex, "Cannot write DoH policy {Path}\\{Name} — registry access denied", key.SubKey, key.ValueName);
                }
                catch (Exception ex)
                {
                    _log.LogError(ex, "Failed to apply DoH policy {Path}\\{Name}", key.SubKey, key.ValueName);
                }
            }

            if (!backupExisted)
                SaveBackup(backup);
        }
    }

    /// <summary>
    /// Restore the original DoH policy values from the backup file, or remove
    /// our values if no backup exists (e.g. clean reinstall). Deletes the
    /// backup JSON on success so the next session captures a fresh snapshot.
    /// </summary>
    public virtual void Restore()
    {
        lock (_lock)
        {
            if (!File.Exists(_backupPath))
            {
                _log.LogDebug("No DoH backup to restore");
                return;
            }

            var backup = LoadBackup();

            foreach (var key in Keys)
            {
                try
                {
                    if (!backup.TryGetValue(key.Id, out var prior))
                    {
                        // No backup row for this key — treat as "was unset".
                        DeleteValue(key);
                        continue;
                    }

                    if (!prior.WasSet)
                        DeleteValue(key);
                    else
                        WriteOriginal(key, prior);

                    _log.LogInformation("DoH policy restored: {Path}\\{Name}", key.SubKey, key.ValueName);
                }
                catch (UnauthorizedAccessException ex)
                {
                    _log.LogWarning(ex, "Cannot restore DoH policy {Path}\\{Name} — registry access denied", key.SubKey, key.ValueName);
                }
                catch (Exception ex)
                {
                    _log.LogError(ex, "Failed to restore DoH policy {Path}\\{Name}", key.SubKey, key.ValueName);
                }
            }

            try
            {
                File.Delete(_backupPath);
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Could not delete DoH backup file");
            }
        }
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    // Test seam: subclasses can override to use HKCU + a sandbox prefix during
    // unit tests instead of touching the real HKLM policy tree.
    protected virtual RegistryKey OpenRoot() =>
        RegistryKey.OpenBaseKey(RegistryHive.LocalMachine, RegistryView.Registry64);

    private BackupEntry ReadCurrent(DohPolicyKey key)
    {
        using var root = OpenRoot();
        using var sub = root.OpenSubKey(key.SubKey, writable: false);
        if (sub == null)
            return new BackupEntry { WasSet = false };

        var value = sub.GetValue(key.ValueName, defaultValue: null);
        if (value == null)
            return new BackupEntry { WasSet = false };

        var kind = sub.GetValueKind(key.ValueName);
        return new BackupEntry
        {
            WasSet = true,
            Kind = kind.ToString(),
            StringValue = kind == RegistryValueKind.String ? value.ToString() : null,
            DwordValue  = kind == RegistryValueKind.DWord  ? Convert.ToInt32(value) : (int?)null,
        };
    }

    private bool IsAlreadyOff(DohPolicyKey key)
    {
        using var root = OpenRoot();
        using var sub = root.OpenSubKey(key.SubKey, writable: false);
        if (sub == null) return false;
        var value = sub.GetValue(key.ValueName, defaultValue: null);
        if (value == null) return false;

        return key.Kind switch
        {
            DohValueKind.String => string.Equals(value.ToString(), (string)key.OffValue, StringComparison.Ordinal),
            DohValueKind.Dword  => Convert.ToInt32(value) == (int)key.OffValue,
            _ => false,
        };
    }

    private void WriteOff(DohPolicyKey key)
    {
        using var root = OpenRoot();
        using var sub = root.CreateSubKey(key.SubKey, writable: true);
        if (sub == null) throw new InvalidOperationException($"Could not open or create {key.SubKey}");

        switch (key.Kind)
        {
            case DohValueKind.String:
                sub.SetValue(key.ValueName, (string)key.OffValue, RegistryValueKind.String);
                break;
            case DohValueKind.Dword:
                sub.SetValue(key.ValueName, (int)key.OffValue, RegistryValueKind.DWord);
                break;
        }
    }

    private void WriteOriginal(DohPolicyKey key, BackupEntry prior)
    {
        using var root = OpenRoot();
        using var sub = root.CreateSubKey(key.SubKey, writable: true);
        if (sub == null) return;

        if (prior.StringValue != null)
            sub.SetValue(key.ValueName, prior.StringValue, RegistryValueKind.String);
        else if (prior.DwordValue.HasValue)
            sub.SetValue(key.ValueName, prior.DwordValue.Value, RegistryValueKind.DWord);
    }

    private void DeleteValue(DohPolicyKey key)
    {
        using var root = OpenRoot();
        using var sub = root.OpenSubKey(key.SubKey, writable: true);
        if (sub == null) return;
        try
        {
            sub.DeleteValue(key.ValueName, throwOnMissingValue: false);
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "DeleteValue noop for {Path}\\{Name}", key.SubKey, key.ValueName);
        }
    }

    private Dictionary<string, BackupEntry> LoadBackup()
    {
        if (!File.Exists(_backupPath))
            return new Dictionary<string, BackupEntry>(StringComparer.Ordinal);

        try
        {
            var json = File.ReadAllText(_backupPath);
            var dict = JsonSerializer.Deserialize<Dictionary<string, BackupEntry>>(json);
            return dict ?? new Dictionary<string, BackupEntry>(StringComparer.Ordinal);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "DoH backup file unreadable — treating as empty");
            return new Dictionary<string, BackupEntry>(StringComparer.Ordinal);
        }
    }

    private void SaveBackup(Dictionary<string, BackupEntry> backup)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_backupPath)!);
            var json = JsonSerializer.Serialize(backup, new JsonSerializerOptions { WriteIndented = true });
            File.WriteAllText(_backupPath, json);
            _log.LogDebug("DoH backup written to {Path}", _backupPath);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to write DoH backup file");
        }
    }

    // ── Types ─────────────────────────────────────────────────────────────────

    private enum DohValueKind { String, Dword }

    private sealed record DohPolicyKey(string SubKey, string ValueName, DohValueKind Kind, object OffValue)
    {
        // Stable identifier for the backup JSON map — `SubKey|ValueName`.
        public string Id => SubKey + "|" + ValueName;
    }

    // Public so System.Text.Json can construct it; not exposed via the service
    // surface.
    public sealed class BackupEntry
    {
        public bool WasSet { get; set; }
        public string? Kind { get; set; }
        public string? StringValue { get; set; }
        public int? DwordValue { get; set; }
    }
}
