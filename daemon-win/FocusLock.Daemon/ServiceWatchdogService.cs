using System.Diagnostics;
using FocusLock.Daemon.Services;
using Microsoft.Win32;

namespace FocusLock.Daemon;

/// <summary>
/// Monitors the Windows service registry key during an active session.
/// If the FocusLockDaemon service entry is deleted while a session is active
/// (e.g. someone ran "sc delete"), re-registers it immediately.
/// This does not prevent the service from being stopped — it only prevents
/// the service registration from being permanently removed mid-session.
/// </summary>
public sealed class ServiceWatchdogService : BackgroundService
{
    private const string ServiceName    = "FocusLockDaemon";
    private const string ServiceRegPath = @"SYSTEM\CurrentControlSet\Services\FocusLockDaemon";

    private readonly SessionService _session;
    private readonly ILogger<ServiceWatchdogService> _log;

    public ServiceWatchdogService(SessionService session, ILogger<ServiceWatchdogService> log)
    {
        _session = session;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _log.LogInformation("Service watchdog started");

        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(TimeSpan.FromSeconds(30), ct).ConfigureAwait(false);

            if (!_session.IsActive) continue;

            if (!IsServiceRegistered())
            {
                _log.LogWarning("Service registry entry missing during active session — re-registering");
                ReRegisterService();
            }
        }
    }

    private static bool IsServiceRegistered()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(ServiceRegPath);
            return key != null;
        }
        catch
        {
            return true; // assume registered if we can't check
        }
    }

    private void ReRegisterService()
    {
        try
        {
            var exePath = Environment.ProcessPath ?? string.Empty;
            if (string.IsNullOrEmpty(exePath)) return;

            // Re-register via sc.exe
            RunSc($"create {ServiceName} binPath= \"{exePath}\" DisplayName= \"FocusLock Daemon\" start= auto");
            RunSc($"failure {ServiceName} reset= 300 actions= restart/5000/restart/10000/restart/30000");
            _log.LogInformation("Service re-registered successfully");
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to re-register service");
        }
    }

    private static void RunSc(string args)
    {
        using var p = Process.Start(new ProcessStartInfo
        {
            FileName = "sc.exe",
            Arguments = args,
            CreateNoWindow = true,
            UseShellExecute = false,
        });
        p?.WaitForExit(5000);
    }
}
