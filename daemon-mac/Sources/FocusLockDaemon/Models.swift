import Foundation

// ── Protocol types (mirrored from shared/protocol.ts) ────────────────────────

struct PomodoroConfig: Codable {
    var workMinutes: Int = 25
    var breakMinutes: Int = 5
    var longBreakMinutes: Int = 15
    var cyclesBeforeLongBreak: Int = 4
    var strictMode: Bool = false
}

struct SessionState: Codable {
    var sessionId: String = UUID().uuidString
    var profileId: String?
    var startTime: Date
    var endTime: Date
    var hardcoreMode: Bool = false
    var blockedDomains: [String] = []
    var blockedProcesses: [String] = []
    var allowlistedDomains: [String] = []
    var pomodoroConfig: PomodoroConfig?
    var unlockTokenHash: String?
    var motivationalMessage: String?
    var signature: String = ""

    var isActive: Bool { Date() < endTime }
    var remaining: TimeInterval { endTime.timeIntervalSinceNow }
}

struct FocusProfile: Codable {
    var id: String
    var name: String
    var blockedCategories: [String] = []
    var customBlockedDomains: [String] = []
    var customBlockedProcesses: [String] = []
    var allowlistedDomains: [String] = []
    var defaultDurationMinutes: Int = 25
    var pomodoroConfig: PomodoroConfig?
    var hardcoreMode: Bool = false
    var createdAt: String
    var updatedAt: String
}

struct ScheduledSession: Codable {
    var id: String
    var profileId: String
    var cronExpression: String
    var durationMinutes: Int
    var enabled: Bool
    var label: String
}

struct SessionLog: Codable {
    var sessionId: String
    var profileId: String?
    var startTime: Date
    var endTime: Date?
    var completed: Bool
    var blockAttempts: Int
    var focusScore: Int
}

// ── IPC message types ─────────────────────────────────────────────────────────

struct IpcRequest: Codable {
    var type: String
    var payload: AnyCodable?
}

struct StartSessionPayload: Codable {
    var profileId: String?
    var durationMinutes: Int
    var blockedDomains: [String]
    var blockedProcesses: [String]
    var allowlistedDomains: [String]
    var hardcoreMode: Bool
    var pomodoroConfig: PomodoroConfig?
    var unlockToken: String?
    var motivationalMessage: String?
}

struct StopSessionPayload: Codable {
    var unlockToken: String?
}

struct DaemonStatus: Codable {
    var version: String = "1.0.0"
    var sessionActive: Bool
    var session: SessionState?
    var secondsRemaining: Double?
    var pomodoroPhase: String?
    var pomodoroSecondsRemaining: Double?
    var blockAttempts: Int
    var hasFriendLock: Bool
    var friendLockRateLimited: Bool
    var friendLockRetryAfterSeconds: Double?
    var hardcoreCooldownUntil: String?
    var currentStreak: Int
    var lastFocusScore: Int?
}

struct IpcResponse: Codable {
    var type: String
    var payload: AnyCodable?
    var message: String?

    static func ok() -> IpcResponse { IpcResponse(type: "ok") }
    static func pong() -> IpcResponse { IpcResponse(type: "pong") }
    static func error(_ msg: String) -> IpcResponse { IpcResponse(type: "error", message: msg) }
    static func status(_ s: DaemonStatus) -> IpcResponse {
        IpcResponse(type: "status", payload: AnyCodable(s))
    }
    static func profiles(_ p: [FocusProfile]) -> IpcResponse {
        IpcResponse(type: "profiles", payload: AnyCodable(p))
    }
    static func logs(_ l: [SessionLog]) -> IpcResponse {
        IpcResponse(type: "logs", payload: AnyCodable(l))
    }
    static func schedules(_ s: [ScheduledSession]) -> IpcResponse {
        IpcResponse(type: "schedules", payload: AnyCodable(s))
    }
}

// ── AnyCodable helper for heterogeneous payloads ──────────────────────────────

struct AnyCodable: Codable {
    let value: Any

    init<T: Encodable>(_ value: T) { self.value = value }

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let v = try? container.decode(Bool.self)   { self.value = v; return }
        if let v = try? container.decode(Int.self)    { self.value = v; return }
        if let v = try? container.decode(Double.self) { self.value = v; return }
        if let v = try? container.decode(String.self) { self.value = v; return }
        if let v = try? container.decode([String: AnyCodable].self) { self.value = v; return }
        if let v = try? container.decode([AnyCodable].self) { self.value = v; return }
        self.value = ()
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch value {
        case let v as Bool:   try container.encode(v)
        case let v as Int:    try container.encode(v)
        case let v as Double: try container.encode(v)
        case let v as String: try container.encode(v)
        case let v as Encodable:
            try v.encode(to: encoder)
        default:
            try container.encodeNil()
        }
    }
}
