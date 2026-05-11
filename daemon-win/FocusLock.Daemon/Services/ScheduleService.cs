using FocusLock.Daemon.Models;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Fires scheduled sessions based on cron expressions.
/// Supports the standard 5-field format: minute hour day month weekday.
/// </summary>
public sealed class ScheduleService
{
    // Domain lists mirrored from shared/protocol.ts CATEGORY_DOMAINS
    private static readonly Dictionary<string, string[]> CategoryDomains = new()
    {
        ["social_media"] = [
            "instagram.com", "tiktok.com", "twitter.com", "x.com",
            "reddit.com", "facebook.com", "snapchat.com", "linkedin.com",
            "pinterest.com", "tumblr.com", "threads.net", "bereal.com",
        ],
        ["streaming"] = [
            "youtube.com", "netflix.com", "twitch.tv", "disneyplus.com",
            "hbomax.com", "max.com", "hulu.com", "primevideo.com",
            "peacocktv.com", "paramountplus.com", "crunchyroll.com",
            "spotify.com", "soundcloud.com",
        ],
        ["gaming"] = [
            "store.steampowered.com", "steamcommunity.com",
            "epicgames.com", "battle.net", "origin.com",
            "ea.com", "xbox.com", "gog.com", "itch.io",
        ],
        ["news"] = [
            "cnn.com", "bbc.com", "bbc.co.uk", "news.ycombinator.com",
            "theguardian.com", "nytimes.com", "washingtonpost.com",
            "foxnews.com", "nbcnews.com", "cbsnews.com", "apnews.com",
            "reuters.com", "huffpost.com", "buzzfeed.com",
        ],
        ["adult"] = [
            "pornhub.com", "xvideos.com", "xnxx.com", "onlyfans.com",
            "chaturbate.com", "cam4.com", "myfreecams.com",
        ],
    };

    private readonly ProfileService _profiles;
    private readonly SessionService _session;
    private readonly ILogger<ScheduleService> _log;

    // Tracks the last time each schedule fired to prevent double-firing within a minute
    private readonly Dictionary<string, DateTime> _lastFired = new();

    public ScheduleService(
        ProfileService profiles,
        SessionService session,
        ILogger<ScheduleService> log)
    {
        _profiles = profiles;
        _session = session;
        _log = log;
    }

    public void Tick()
    {
        if (_session.IsActive) return;

        var now = DateTime.Now;

        foreach (var schedule in _profiles.GetSchedules())
        {
            if (!schedule.Enabled) continue;

            // Only fire once per minute
            if (_lastFired.TryGetValue(schedule.Id, out var last) &&
                (now - last).TotalMinutes < 1)
                continue;

            if (!CronMatches(schedule.CronExpression, now)) continue;

            _lastFired[schedule.Id] = now;

            var profile = _profiles.GetAll().FirstOrDefault(p => p.Id == schedule.ProfileId);
            if (profile == null)
            {
                _log.LogWarning("Schedule {Id} references missing profile {ProfileId}",
                    schedule.Id, schedule.ProfileId);
                continue;
            }

            _log.LogInformation("Auto-starting session for schedule \"{Label}\"", schedule.Label);

            var payload = new StartSessionPayload
            {
                ProfileId = profile.Id,
                DurationMinutes = schedule.DurationMinutes,
                BlockedDomains = ExpandDomains(profile),
                BlockedProcesses = profile.CustomBlockedProcesses,
                AllowlistedDomains = profile.AllowlistedDomains,
                HardcoreMode = profile.HardcoreMode,
                PomodoroConfig = profile.PomodoroConfig,
            };
            _session.StartSession(payload);
            break; // one session at a time
        }
    }

    private static List<string> ExpandDomains(FocusProfile profile)
    {
        var domains = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        foreach (var category in profile.BlockedCategories)
        {
            if (CategoryDomains.TryGetValue(category, out var list))
                foreach (var d in list) domains.Add(d);
        }

        foreach (var d in profile.CustomBlockedDomains)
            domains.Add(d);

        return [.. domains];
    }

    // ── Cron parsing (5-field: minute hour day month weekday) ─────────────────

    private static bool CronMatches(string expression, DateTime dt)
    {
        try
        {
            var parts = expression.Trim().Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length != 5) return false;

            return FieldMatches(parts[0], dt.Minute)
                && FieldMatches(parts[1], dt.Hour)
                && FieldMatches(parts[2], dt.Day)
                && FieldMatches(parts[3], dt.Month)
                && FieldMatches(parts[4], (int)dt.DayOfWeek);
        }
        catch
        {
            return false;
        }
    }

    private static bool FieldMatches(string field, int value)
    {
        if (field == "*") return true;

        if (field.Contains('/'))
        {
            var p = field.Split('/');
            int step = int.Parse(p[1]);
            int start = p[0] == "*" ? 0 : int.Parse(p[0]);
            return value >= start && (value - start) % step == 0;
        }

        if (field.Contains(','))
            return field.Split(',').Select(int.Parse).Contains(value);

        if (field.Contains('-'))
        {
            var p = field.Split('-');
            return value >= int.Parse(p[0]) && value <= int.Parse(p[1]);
        }

        return int.Parse(field) == value;
    }
}
