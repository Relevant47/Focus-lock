using FocusLock.Daemon.Services;

namespace FocusLock.Daemon;

public sealed class DaemonWorker : BackgroundService
{
    private readonly SessionService _session;
    private readonly HostsFileService _hosts;
    private readonly ProcessKillService _procs;
    private readonly ScheduleService _schedules;
    private readonly FamilyEnforcementService _family;
    private readonly ILogger<DaemonWorker> _log;

    private int _tickCount;
    private bool _hostsApplied;          // hosts file currently carries a FocusLock block
    private string _lastFingerprint = "";

    public DaemonWorker(
        SessionService session,
        HostsFileService hosts,
        ProcessKillService procs,
        ScheduleService schedules,
        FamilyEnforcementService family,
        ILogger<DaemonWorker> log)
    {
        _session = session;
        _hosts = hosts;
        _procs = procs;
        _schedules = schedules;
        _family = family;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _log.LogInformation("FocusLock daemon started");

        ApplyEnforcement(force: true);

        while (!ct.IsCancellationRequested)
        {
            await Task.Delay(1000, ct).ConfigureAwait(false);
            _tickCount++;

            _session.Tick();

            // Re-enforce every 30s regardless to overwrite manual hosts edits.
            ApplyEnforcement(force: _tickCount % 30 == 0);

            // ProcessKill respects both session + family lists; family rules
            // are enforced even outside a focus session.
            bool sessionWorking = _session.IsActive && !_session.ShouldLiftBlocksDuringBreak;
            bool familyHas      = _family.HasActiveBlocks;
            if ((sessionWorking || familyHas) && _tickCount % 2 == 0)
                _procs.Poll();

            if (_tickCount % 60 == 0)
                _schedules.Tick();
        }

        _hosts.Remove();
        _log.LogInformation("FocusLock daemon stopped");
    }

    /// <summary>
    /// Computes the union of (active session blocks) + (active family rules)
    /// and reconciles the hosts file against it. Honours Pomodoro break-lift
    /// for the *session* contribution only — parent-side rules are not lifted
    /// by the user's own break.
    /// </summary>
    private void ApplyEnforcement(bool force)
    {
        var session       = _session.Active;
        bool sessionLive  = _session.IsActive && session != null;
        bool lift         = _session.ShouldLiftBlocksDuringBreak;

        var sessionDomains = (sessionLive && !lift) ? session!.BlockedDomains      : new List<string>();
        var sessionAllow   = (sessionLive)          ? session!.AllowlistedDomains  : new List<string>();
        var (familyDomains, _) = _family.GetUnion();

        var unionDomains = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var d in sessionDomains) unionDomains.Add(d);
        foreach (var d in familyDomains)  unionDomains.Add(d);

        if (unionDomains.Count == 0)
        {
            if (_hostsApplied)
            {
                _hosts.Remove();
                _hostsApplied = false;
                _lastFingerprint = "";
            }
            return;
        }

        // Cheap dirty-check: only rewrite the hosts file when the effective
        // set actually changes (or the periodic re-enforce tick fires).
        var fingerprint = string.Join(",", unionDomains.OrderBy(x => x)) + "|" +
                          string.Join(",", sessionAllow.OrderBy(x => x));
        if (!force && fingerprint == _lastFingerprint && _hostsApplied) return;

        _hosts.Apply(unionDomains, sessionAllow);
        _hostsApplied = true;
        _lastFingerprint = fingerprint;
    }
}
