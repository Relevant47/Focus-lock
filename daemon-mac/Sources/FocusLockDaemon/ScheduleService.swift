import Foundation

private let categoryDomains: [String: [String]] = [
    "social_media": [
        "instagram.com", "tiktok.com", "twitter.com", "x.com",
        "reddit.com", "facebook.com", "snapchat.com", "linkedin.com",
        "pinterest.com", "tumblr.com", "threads.net", "bereal.com",
    ],
    "streaming": [
        "youtube.com", "netflix.com", "twitch.tv", "disneyplus.com",
        "hbomax.com", "max.com", "hulu.com", "primevideo.com",
        "peacocktv.com", "paramountplus.com", "crunchyroll.com",
        "spotify.com", "soundcloud.com",
    ],
    "gaming": [
        "store.steampowered.com", "steamcommunity.com",
        "epicgames.com", "battle.net", "origin.com",
        "ea.com", "xbox.com", "gog.com", "itch.io",
    ],
    "news": [
        "cnn.com", "bbc.com", "bbc.co.uk", "news.ycombinator.com",
        "theguardian.com", "nytimes.com", "washingtonpost.com",
        "foxnews.com", "nbcnews.com", "cbsnews.com", "apnews.com",
        "reuters.com", "huffpost.com", "buzzfeed.com",
    ],
    "adult": [
        "pornhub.com", "xvideos.com", "xnxx.com", "onlyfans.com",
        "chaturbate.com", "cam4.com", "myfreecams.com",
    ],
]

final class ScheduleService {
    private let profiles: ProfileService
    private let session: SessionService
    private var lastFired: [String: Date] = [:]

    init(profiles: ProfileService, session: SessionService) {
        self.profiles = profiles
        self.session = session
    }

    func tick() {
        guard !session.isActive else { return }
        let now = Date()
        let cal = Calendar.current

        for schedule in profiles.getSchedules() where schedule.enabled {
            if let last = lastFired[schedule.id],
               now.timeIntervalSince(last) < 60 { continue }
            guard cronMatches(schedule.cronExpression, date: now, calendar: cal) else { continue }

            lastFired[schedule.id] = now
            guard let profile = profiles.getProfiles().first(where: { $0.id == schedule.profileId }) else { continue }

            let domains = expandDomains(profile: profile)
            let payload = StartSessionPayload(
                profileId: profile.id,
                durationMinutes: schedule.durationMinutes,
                blockedDomains: domains,
                blockedProcesses: profile.customBlockedProcesses,
                allowlistedDomains: profile.allowlistedDomains,
                hardcoreMode: profile.hardcoreMode,
                pomodoroConfig: profile.pomodoroConfig
            )
            _ = session.startSession(payload)
            break
        }
    }

    // ── Cron (5-field: min hour day month weekday) ────────────────────────────

    private func cronMatches(_ expr: String, date: Date, calendar: Calendar) -> Bool {
        let parts = expr.trimmingCharacters(in: .whitespaces)
                        .components(separatedBy: .whitespaces)
                        .filter { !$0.isEmpty }
        guard parts.count == 5 else { return false }
        let comps = calendar.dateComponents([.minute, .hour, .day, .month, .weekday], from: date)
        // .weekday: 1=Sun…7=Sat → convert to 0=Sun…6=Sat
        let wday = (comps.weekday ?? 1) - 1
        return fieldMatches(parts[0], value: comps.minute ?? 0)
            && fieldMatches(parts[1], value: comps.hour ?? 0)
            && fieldMatches(parts[2], value: comps.day ?? 1)
            && fieldMatches(parts[3], value: comps.month ?? 1)
            && fieldMatches(parts[4], value: wday)
    }

    private func fieldMatches(_ field: String, value: Int) -> Bool {
        if field == "*" { return true }
        if field.contains("/") {
            let p = field.components(separatedBy: "/")
            guard p.count == 2, let step = Int(p[1]) else { return false }
            let start = p[0] == "*" ? 0 : (Int(p[0]) ?? 0)
            return value >= start && (value - start) % step == 0
        }
        if field.contains(",") {
            return field.components(separatedBy: ",").compactMap(Int.init).contains(value)
        }
        if field.contains("-") {
            let p = field.components(separatedBy: "-")
            guard p.count == 2, let lo = Int(p[0]), let hi = Int(p[1]) else { return false }
            return value >= lo && value <= hi
        }
        return Int(field) == value
    }

    private func expandDomains(profile: FocusProfile) -> [String] {
        var domains = Set<String>()
        for cat in profile.blockedCategories {
            (categoryDomains[cat] ?? []).forEach { domains.insert($0) }
        }
        profile.customBlockedDomains.forEach { domains.insert($0) }
        return Array(domains)
    }
}
