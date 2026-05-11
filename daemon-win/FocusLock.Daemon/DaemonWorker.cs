using FocusLock.Daemon.Services;

namespace FocusLock.Daemon;

public sealed class DaemonWorker : BackgroundService
{
    private readonly SessionService _session;
    private readonly HostsFileService _hosts;
    private readonly ProcessKillService _procs;
    private readonly ScheduleService _schedules;
    private readonly ILogger<DaemonWorker> _log;

    private int _tickCount;
    private bool _wasActive;
    private string? _lastAppliedSessionId;
    private bool _hostsCurrentlyLifted; // true when blocks are temporarily removed during break

    public DaemonWorker(
        SessionService session,
        HostsFileService hosts,
        ProcessKillService procs,
        ScheduleService schedules,
        ILogger<DaemonWorker> log)
    {
        _session = session;
        _hosts = hosts;
        _procs = procs;
        _schedules = schedules;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _log.LogInformation("FocusLock daemon started");

        if (_session.IsActive && _session.Active != null)
        {
            _hosts.Apply(_session.Active);
            _lastAppliedSessionId = _session.Active.SessionId;
            _wasActive = true;
        }
        else
        {
            _hosts.Remove();
        }

        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(1000, ct).ConfigureAwait(false);
            _tickCount++;

            _session.Tick();

            bool isActive = _session.IsActive;

            if (isActive && _session.Active != null)
            {
                var sid = _session.Active.SessionId;
                bool shouldLift = _session.ShouldLiftBlocksDuringBreak;

                if (shouldLift)
                {
                    // Non-strict Pomodoro break — temporarily remove blocks
                    if (!_hostsCurrentlyLifted)
                    {
                        _hosts.Remove();
                        _hostsCurrentlyLifted = true;
                        _log.LogDebug("Pomodoro break — blocks lifted temporarily");
                    }
                    // Don't kill processes during break either
                }
                else
                {
                    // Work phase or strict mode — enforce blocks
                    if (_hostsCurrentlyLifted || sid != _lastAppliedSessionId || _tickCount % 30 == 0)
                    {
                        _hosts.Apply(_session.Active);
                        _lastAppliedSessionId = sid;
                        _hostsCurrentlyLifted = false;
                    }

                    if (_tickCount % 2 == 0)
                        _procs.Poll();
                }

                _wasActive = true;
            }
            else if (_wasActive && !isActive)
            {
                _hosts.Remove();
                _lastAppliedSessionId = null;
                _wasActive = false;
                _hostsCurrentlyLifted = false;
            }

            if (_tickCount % 60 == 0)
                _schedules.Tick();
        }

        _hosts.Remove();
        _log.LogInformation("FocusLock daemon stopped");
    }
}
