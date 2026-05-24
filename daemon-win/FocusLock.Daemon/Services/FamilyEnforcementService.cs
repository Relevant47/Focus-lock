using System.Text.Json;
using FocusLock.Daemon.Models;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Holds the *currently effective* cloud rules for this device and exposes a
/// union view that the enforcement loop can apply alongside any active focus
/// session.
///
/// Rule semantics:
///   • <c>block_now</c>  → blocked domains + processes added to the union.
///   • <c>unblock_all</c> → kill-switch that empties the union and suppresses
///                          family-side enforcement until the rule is removed.
///   • <c>schedule</c>   → cron-evaluated every tick (see <see cref="CronEvaluator"/>);
///                          a matching window contributes the rule's domains and
///                          processes to the same union as <c>block_now</c>.
///
/// Persistence: rules are cached to <c>family-rules.json</c> so a daemon
/// restart re-applies the last-known state before the WebSocket reconnects.
/// </summary>
public sealed class FamilyEnforcementService
{
    private static readonly string StateDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "FocusLock");

    private static readonly string CachePath = Path.Combine(StateDir, "family-rules.json");

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
        WriteIndented = true,
    };

    private readonly ILogger<FamilyEnforcementService> _log;
    private readonly IntegritySigner _signer;
    private readonly ParentAuditService _audit;
    private readonly object _lock = new();
    private Dictionary<string, CloudRule> _rules = new();
    // Compiled cron evaluators keyed by rule ID. Rebuilt as rules change so
    // we don't re-parse on every tick.
    private Dictionary<string, CronEvaluator> _cron = new();

    public event Action? RulesChanged;

    public FamilyEnforcementService(ILogger<FamilyEnforcementService> log, IntegritySigner signer, ParentAuditService audit)
    {
        _log = log;
        _signer = signer;
        _audit = audit;
        Directory.CreateDirectory(StateDir);
        LoadCache();
    }

    /// <summary>True when at least one rule is enforcing blocks on this device.</summary>
    public bool HasActiveBlocks
    {
        get
        {
            lock (_lock)
            {
                if (HasUnblockAll()) return false;
                var now = DateTime.Now;
                foreach (var r in _rules.Values)
                {
                    if (!r.Active) continue;
                    if (r.TargetDomains.Count == 0 && r.TargetApps.Count == 0) continue;
                    if (r.Kind == "block_now") return true;
                    if (r.Kind == "schedule" && _cron.TryGetValue(r.Id, out var c) && c.Matches(now))
                        return true;
                }
                return false;
            }
        }
    }

    public (IReadOnlyCollection<string> Domains, IReadOnlyCollection<string> Processes) GetUnion()
    {
        lock (_lock)
        {
            if (HasUnblockAll())
                return (Array.Empty<string>(), Array.Empty<string>());

            var now = DateTime.Now;
            var domains = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var procs   = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var r in _rules.Values)
            {
                if (!r.Active) continue;
                bool active = r.Kind == "block_now"
                    || (r.Kind == "schedule"
                        && _cron.TryGetValue(r.Id, out var c) && c.Matches(now));
                if (!active) continue;
                foreach (var d in r.TargetDomains) if (!string.IsNullOrWhiteSpace(d)) domains.Add(d);
                foreach (var a in r.TargetApps)    if (!string.IsNullOrWhiteSpace(a)) procs.Add(a);
            }
            return (domains, procs);
        }
    }

    public IReadOnlyList<FamilyRuleSummary> Snapshot()
    {
        lock (_lock)
        {
            return _rules.Values.Select(r => new FamilyRuleSummary
            {
                Id            = r.Id,
                Kind          = r.Kind,
                TargetApps    = new List<string>(r.TargetApps),
                TargetDomains = new List<string>(r.TargetDomains),
                ScheduleCron  = r.ScheduleCron,
                CreatedAt     = r.CreatedAt,
            }).ToList();
        }
    }

    // ── Mutators called by CloudSyncService ────────────────────────────────

    public void Upsert(CloudRule rule)
    {
        if (string.IsNullOrEmpty(rule.Id)) return;
        bool changed;
        lock (_lock)
        {
            changed = !_rules.TryGetValue(rule.Id, out var existing) || !RuleEquals(existing, rule);
            _rules[rule.Id] = rule;
            if (changed) { RebuildCronLocked(); SaveCache(); }
        }
        if (changed)
        {
            _log.LogInformation("Family rule upserted: id={Id} kind={Kind} domains={D} apps={A}",
                rule.Id, rule.Kind, rule.TargetDomains.Count, rule.TargetApps.Count);
            RulesChanged?.Invoke();
        }
    }

    public void Remove(string ruleId)
    {
        bool changed;
        lock (_lock)
        {
            changed = _rules.Remove(ruleId);
            if (changed) { RebuildCronLocked(); SaveCache(); }
        }
        if (changed)
        {
            _log.LogInformation("Family rule removed: id={Id}", ruleId);
            RulesChanged?.Invoke();
        }
    }

    public void Replace(IEnumerable<CloudRule> rules)
    {
        lock (_lock)
        {
            _rules = rules
                .Where(r => !string.IsNullOrEmpty(r.Id))
                .ToDictionary(r => r.Id, r => r);
            RebuildCronLocked();
            SaveCache();
        }
        _log.LogInformation("Family rules replaced: count={Count}", _rules.Count);
        RulesChanged?.Invoke();
    }

    public void Clear()
    {
        lock (_lock)
        {
            if (_rules.Count == 0) return;
            _rules.Clear();
            _cron.Clear();
            _signer.DeleteSigned(CachePath);
        }
        _log.LogInformation("Family rules cleared");
        RulesChanged?.Invoke();
    }

    // ── Internals ──────────────────────────────────────────────────────────

    /// <summary>Recomputes <see cref="_cron"/> from <see cref="_rules"/>. Caller holds the lock.</summary>
    private void RebuildCronLocked()
    {
        var next = new Dictionary<string, CronEvaluator>();
        foreach (var r in _rules.Values)
        {
            if (r.Kind != "schedule" || string.IsNullOrWhiteSpace(r.ScheduleCron)) continue;
            var c = CronEvaluator.Parse(r.ScheduleCron);
            if (c != null) next[r.Id] = c;
            else _log.LogWarning("Schedule rule {Id} has invalid cron '{Cron}' — ignored", r.Id, r.ScheduleCron);
        }
        _cron = next;
    }

    private bool HasUnblockAll()
    {
        foreach (var r in _rules.Values)
            if (r.Active && r.Kind == "unblock_all") return true;
        return false;
    }

    private static bool RuleEquals(CloudRule a, CloudRule b) =>
        a.Active == b.Active &&
        a.Kind == b.Kind &&
        a.ScheduleCron == b.ScheduleCron &&
        a.TargetApps.SequenceEqual(b.TargetApps) &&
        a.TargetDomains.SequenceEqual(b.TargetDomains);

    private void LoadCache()
    {
        var bytes = _signer.ReadVerified(CachePath);
        if (bytes == null)
        {
            if (File.Exists(CachePath))
            {
                _log.LogWarning("Family rule cache has no valid signature — discarding");
                _audit.Record(ParentAuditEvents.FamilyCacheTampered, detail: "family-rules.json");
            }
            return;
        }
        try
        {
            var rules = JsonSerializer.Deserialize<List<CloudRule>>(bytes, JsonOpts);
            if (rules == null) return;
            _rules = rules.Where(r => !string.IsNullOrEmpty(r.Id)).ToDictionary(r => r.Id, r => r);
            RebuildCronLocked();
            _log.LogInformation("Loaded {Count} cached family rules", _rules.Count);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Family rule cache unreadable — ignoring");
        }
    }

    private void SaveCache()
    {
        try
        {
            var bytes = JsonSerializer.SerializeToUtf8Bytes(_rules.Values.ToList(), JsonOpts);
            _signer.WriteSigned(CachePath, bytes);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to persist family rule cache");
        }
    }
}
