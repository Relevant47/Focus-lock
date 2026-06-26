using Microsoft.Extensions.Logging;
using Microsoft.Win32;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Best-effort registration of the FocusLock service in Windows Safe Boot so
/// the daemon starts when the user reboots into Safe Mode. Without this, a
/// kid can bypass FocusLock by holding Shift while clicking Restart and
/// picking "Enable Safe Mode" — the default SafeBoot key list does not include
/// our service.
///
/// We register under both <c>Minimal</c> (Safe Mode without networking) and
/// <c>Network</c> (Safe Mode with networking). In the no-network variant the
/// CloudSync WebSocket fails and the daemon falls back to the locally cached
/// rule set — which is exactly what we want.
///
/// Writes require admin (we run as SYSTEM in production). Failures are logged
/// and swallowed; the daemon stays useful even when registration fails.
/// </summary>
public sealed class SafeModeRegistration : IHostedService
{
    // Must exactly match the SCM service key created by install-service.ps1 /
    // nsis-hook.nsh (sc.exe create FocusLockDaemon ...). Windows only honours
    // SafeBoot\Minimal|Network subkeys whose names match a real service key
    // under SYSTEM\CurrentControlSet\Services\, so the old "FocusLock" name
    // silently registered nothing — Safe Mode booted with no daemon at all.
    private const string ServiceName = "FocusLockDaemon";
    private const string ValueData   = "Service";

    private static readonly string[] SafeBootKeys =
    {
        @"SYSTEM\CurrentControlSet\Control\SafeBoot\Minimal",
        @"SYSTEM\CurrentControlSet\Control\SafeBoot\Network",
    };

    private readonly ILogger<SafeModeRegistration> _log;

    public SafeModeRegistration(ILogger<SafeModeRegistration> log) => _log = log;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows()) return Task.CompletedTask;

        foreach (var parent in SafeBootKeys)
        {
            try
            {
                using var parentKey = Registry.LocalMachine.OpenSubKey(parent, writable: true);
                if (parentKey == null)
                {
                    _log.LogWarning("SafeBoot parent key {Path} missing — skipping", parent);
                    continue;
                }
                using var sub = parentKey.CreateSubKey(ServiceName, writable: true);
                if (sub == null) continue;
                var existing = sub.GetValue(null) as string;
                if (existing == ValueData) continue;  // already registered
                sub.SetValue(null, ValueData, RegistryValueKind.String);
                _log.LogInformation("Registered FocusLock under {Path}", parent);
            }
            catch (UnauthorizedAccessException)
            {
                // Daemon not running as SYSTEM/admin — diagnostic run. Don't
                // flood logs; this is expected in dev.
                _log.LogDebug("No permission to write {Path} — not running as SYSTEM", parent);
                return Task.CompletedTask;
            }
            catch (Exception ex)
            {
                _log.LogWarning(ex, "Safe Mode registration failed for {Path}", parent);
            }
        }
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
