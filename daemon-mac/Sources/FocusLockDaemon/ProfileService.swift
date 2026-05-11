import Foundation

/// JSON-file-backed persistence for focus profiles and scheduled sessions.
final class ProfileService {
    private static let dataDir: URL = {
        let base = URL(fileURLWithPath: "/Library/Application Support/FocusLock")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()
    private static let profilesPath  = dataDir.appendingPathComponent("profiles.json")
    private static let schedulesPath = dataDir.appendingPathComponent("schedules.json")

    private let enc: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = .prettyPrinted
        return e
    }()
    private let dec = JSONDecoder()

    // ── Profiles ──────────────────────────────────────────────────────────────

    func getProfiles() -> [FocusProfile] {
        load([FocusProfile].self, from: Self.profilesPath) ?? []
    }

    func saveProfile(_ profile: FocusProfile) {
        var profiles = getProfiles()
        if let idx = profiles.firstIndex(where: { $0.id == profile.id }) {
            profiles[idx] = profile
        } else {
            profiles.append(profile)
        }
        save(profiles, to: Self.profilesPath)
    }

    func deleteProfile(id: String) {
        var profiles = getProfiles()
        profiles.removeAll { $0.id == id }
        save(profiles, to: Self.profilesPath)
    }

    // ── Schedules ─────────────────────────────────────────────────────────────

    func getSchedules() -> [ScheduledSession] {
        load([ScheduledSession].self, from: Self.schedulesPath) ?? []
    }

    func saveSchedule(_ schedule: ScheduledSession) {
        var schedules = getSchedules()
        if let idx = schedules.firstIndex(where: { $0.id == schedule.id }) {
            schedules[idx] = schedule
        } else {
            schedules.append(schedule)
        }
        save(schedules, to: Self.schedulesPath)
    }

    func deleteSchedule(id: String) {
        var schedules = getSchedules()
        schedules.removeAll { $0.id == id }
        save(schedules, to: Self.schedulesPath)
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private func load<T: Decodable>(_ type: T.Type, from url: URL) -> T? {
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? dec.decode(type, from: data)
    }

    private func save<T: Encodable>(_ value: T, to url: URL) {
        guard let data = try? enc.encode(value) else { return }
        try? data.write(to: url)
    }
}
