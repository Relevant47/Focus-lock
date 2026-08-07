using FocusLock.Daemon.Services;

namespace FocusLock.Daemon;

public sealed class DaemonWorker : BackgroundService
{
    private readonly SessionService _session;
    private readonly HostsFileService _hosts;
    private readonly BrowserDohPolicyService _doh;
    private readonly ProcessKillService _procs;
    private readonly ScheduleService _schedules;
    private readonly FamilyEnforcementService _family;
    private readonly UsageService _usage;
    private readonly ILogger<DaemonWorker> _log;

    private int _tickCount;
    private bool _hostsApplied;          // hosts file currently carries a FocusLock block
    private bool _dohApplied;            // DoH policy currently forced off
    private string _lastFingerprint = "";

    // Usage-analytics retention gate. First run fires ≥5 ticks after startup
    // (so the daemon is fully up); subsequent runs at 24h intervals. When
    // tracking is disabled or set to 'forever', UsageService itself no-ops.
    private DateTime _lastRetentionRun = DateTime.MinValue;

    public DaemonWorker(
        SessionService session,
        HostsFileService hosts,
        BrowserDohPolicyService doh,
        ProcessKillService procs,
        ScheduleService schedules,
        FamilyEnforcementService family,
        UsageService usage,
        ILogger<DaemonWorker> log)
    {
        _session = session;
        _hosts = hosts;
        _doh = doh;
        _procs = procs;
        _schedules = schedules;
        _family = family;
        _usage = usage;
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

            // Piggyback the daily usage-retention prune on this tick. Guarded
            // by _tickCount >= 5 to skip the first few seconds of startup, and
            // by a 24h cadence thereafter. UsageService no-ops when tracking
            // is disabled or retention is 'forever'.
            if (_tickCount >= 5 &&
                (DateTime.UtcNow - _lastRetentionRun) >= TimeSpan.FromHours(24))
            {
                _usage.RunRetentionIfDue(DateTime.UtcNow);
                _lastRetentionRun = DateTime.UtcNow;
            }
        }

        // Only clear the hosts block when there's nothing left to enforce.
        // If a session is still active or family rules are in force, stripping
        // the block on graceful stop (Windows Update, `sc stop focuslock`,
        // NSIS-silent self-update) opens a bypass window until the service
        // restarts and re-applies. macOS's signal handler already omits the
        // remove for the same reason.
        if (_session.IsActive || _family.HasActiveBlocks)
        {
            _log.LogInformation("FocusLock daemon stopped — hosts block retained (session or family rules still active)");
        }
        else
        {
            _hosts.Remove();
            _log.LogInformation("FocusLock daemon stopped");
        }
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
            // DoH restore is handled in SessionService.FinalizeSession so the
            // backup is paired with the lifecycle that captured it. We just
            // clear our local "applied" flag here.
            _dohApplied = false;
            return;
        }

        // Cheap dirty-check: only rewrite the hosts file when the effective
        // set actually changes (or the periodic re-enforce tick fires).
        var fingerprint = string.Join(",", unionDomains.OrderBy(x => x)) + "|" +
                          string.Join(",", sessionAllow.OrderBy(x => x));
        bool fingerprintChanged = fingerprint != _lastFingerprint;

        // Force browser DoH off whenever there are domains to block. The
        // service itself is idempotent — re-applying when the keys already
        // hold "off" and the backup file already exists is a no-op. We still
        // want to drive Apply() on the periodic re-enforce tick so a
        // browser policy refresh after install picks up our value within 30s.
        if (force || fingerprintChanged || !_dohApplied)
        {
            _doh.Apply();
            _dohApplied = true;
        }

        if (!force && !fingerprintChanged && _hostsApplied) return;

        _hosts.Apply(unionDomains, sessionAllow);
        _hostsApplied = true;
        _lastFingerprint = fingerprint;
    }
}
