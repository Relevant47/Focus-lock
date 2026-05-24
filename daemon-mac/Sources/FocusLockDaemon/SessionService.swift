import Foundation
import CryptoKit

// ── Pomodoro state machine ────────────────────────────────────────────────────

private final class PomodoroState {
    let config: PomodoroConfig
    private(set) var phase: String = "work"
    private(set) var secondsRemaining: Double = 0
    private var phaseEnd: Date
    private var completedCycles = 0

    init(config: PomodoroConfig, sessionStart: Date) {
        self.config = config
        self.phaseEnd = sessionStart.addingTimeInterval(Double(config.workMinutes) * 60)
        self.secondsRemaining = phaseEnd.timeIntervalSinceNow
    }

    func tick(now: Date) {
        secondsRemaining = phaseEnd.timeIntervalSince(now)
        guard secondsRemaining <= 0 else { return }

        if phase == "work" {
            completedCycles += 1
            let long = completedCycles % config.cyclesBeforeLongBreak == 0
            phase = long ? "long_break" : "break"
            let mins = long ? config.longBreakMinutes : config.breakMinutes
            phaseEnd = now.addingTimeInterval(Double(mins) * 60)
        } else {
            phase = "work"
            phaseEnd = now.addingTimeInterval(Double(config.workMinutes) * 60)
        }
        secondsRemaining = phaseEnd.timeIntervalSince(now)
    }

    var isBreak: Bool { phase == "break" || phase == "long_break" }

    func skipToWork() {
        phase = "work"
        phaseEnd = Date().addingTimeInterval(Double(config.workMinutes) * 60)
        secondsRemaining = phaseEnd.timeIntervalSinceNow
    }
}

// ── Session service ───────────────────────────────────────────────────────────

final class SessionService {
    private static let stateDir: URL = {
        let base = URL(fileURLWithPath: "/Library/Application Support/FocusLock")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()
    private static let statePath = stateDir.appendingPathComponent("session.json")
    private static let keyPath   = stateDir.appendingPathComponent("daemon.key")
    private static let logPath   = stateDir.appendingPathComponent("sessions.jsonl")

    private let lock = NSLock()
    private var _active: SessionState?
    private var _signingKey: SymmetricKey
    private var _blockAttempts = 0
    private var _pomodoro: PomodoroState?

    // ── Monotonic clock anchoring (anti clock-tamper) ───────────────────────────
    // Mirror of the Windows daemon's SessionService monotonic logic. The wall-
    // clock endTime is still persisted so a session survives a daemon restart /
    // reboot (we can't reconstruct elapsed time across a process death), but while
    // the daemon runs, expiry is governed by a monotonic clock so moving the
    // system clock — forward to end a Hardcore session early, or back to extend it
    // — cannot change when the session actually ends.
    //
    // On startSession / resume we anchor: record the monotonic timestamp and the
    // remaining seconds at that instant. Authoritative remaining is then
    // (remainingAtAnchor − monotonicElapsedSinceAnchor). We also compare the wall
    // clock's movement against the monotonic movement; a large divergence is
    // logged once as suspected tampering, but the monotonic value is enforced.
    private var _anchorMonotonicSeconds: Double = 0     // monotonicNow() at anchor
    private var _remainingAtAnchorSeconds: Double = 0   // wall-clock remaining at anchor
    private var _anchorWallClock = Date()               // Date() at anchor (tamper detection only)
    private var _clockTamperLogged = false              // one-shot log guard per session
    // Slack between wall-clock and monotonic drift before we treat it as tampering
    // rather than ordinary scheduler jitter / NTP nudges.
    private static let clockTamperToleranceSeconds = 30.0

    // Friend-lock rate limiting
    private var _failedUnlockAttempts = 0
    private var _nextUnlockAllowed = Date.distantPast

    // Hardcore cooldown
    private var _hardcoreCooldownUntil: Date?

    init() {
        _signingKey = Self.loadOrCreateKey()
        verifyBinaryHash()
        _active = Self.loadPersistedSession(key: _signingKey)
        if _active != nil {
            // Re-anchor the monotonic clock from the persisted wall-clock endTime.
            // Across a process restart there's no record of elapsed time, so the
            // wall clock is the only available source for "how much is left" — but
            // from this instant on, the monotonic timer governs expiry again.
            anchorMonotonic()
        }
        if let a = _active, a.pomodoroConfig != nil {
            _pomodoro = PomodoroState(config: a.pomodoroConfig!, sessionStart: a.startTime)
        }
    }

    private func verifyBinaryHash() {
        // CommandLine.arguments.first is the actual executable path for CLI tools
        guard let execPath = CommandLine.arguments.first else { return }
        let hashPath = Self.stateDir.appendingPathComponent("daemon.hash")
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: execPath)) else { return }
        let digest = SHA256.hash(data: data)
        let currentHash = Data(digest).hexString
        if let stored = try? String(contentsOf: hashPath, encoding: .utf8).trimmingCharacters(in: .whitespaces),
           stored != currentHash {
            fputs("[security] Daemon binary hash mismatch — binary may have been tampered with\n", stderr)
        }
        try? currentHash.write(to: hashPath, atomically: true, encoding: .utf8)
    }

    var active: SessionState? { lock.withLock { _active } }
    var isActive: Bool { lock.withLock { computeIsActive() } }
    var blockAttempts: Int { lock.withLock { _blockAttempts } }

    // ── Monotonic-clock helpers ─────────────────────────────────────────────────

    /// Seconds from a monotonic source that cannot be moved by changing the wall
    /// clock. Uses clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) to match the proven,
    /// CI-validated pattern in CloudSyncService — mach_continuous_time isn't
    /// bridged into Swift in this SDK setup (see CloudSyncService.swift).
    private static func monotonicNow() -> Double {
        return Double(clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)) / 1_000_000_000.0
    }

    /// Records the monotonic anchor for the current `_active` session. Caller must
    /// hold `lock`.
    private func anchorMonotonic() {
        guard let active = _active else { return }
        _anchorMonotonicSeconds = Self.monotonicNow()
        _anchorWallClock = Date()
        _remainingAtAnchorSeconds = max(0, active.endTime.timeIntervalSinceNow)
        _clockTamperLogged = false
    }

    /// Authoritative seconds remaining, governed by the monotonic clock (not the
    /// wall clock). Returns 0 once the full duration has elapsed. Caller must hold
    /// `lock`.
    private func computeRemainingSeconds() -> Double {
        guard _active != nil else { return 0 }

        var monotonicElapsed = Self.monotonicNow() - _anchorMonotonicSeconds
        if monotonicElapsed < 0 { monotonicElapsed = 0 }   // never goes back; defensive
        let monotonicRemaining = _remainingAtAnchorSeconds - monotonicElapsed

        // Tamper detection: wall-clock vs monotonic movement since the anchor.
        let wallElapsed = Date().timeIntervalSince(_anchorWallClock)
        let divergence = abs(wallElapsed - monotonicElapsed)
        if divergence > Self.clockTamperToleranceSeconds && !_clockTamperLogged {
            _clockTamperLogged = true
            fputs("[security] System clock moved ~\(Int(divergence))s relative to the monotonic clock "
                + "during session \(_active?.sessionId ?? "?") — enforcing the monotonic timer "
                + "(clock changes cannot end a session early).\n", stderr)
        }

        return max(0, monotonicRemaining)
    }

    private func computeIsActive() -> Bool {
        _active != nil && computeRemainingSeconds() > 0
    }

    /// True when in a non-strict Pomodoro break — blocks should be temporarily lifted.
    var shouldLiftBlocksDuringBreak: Bool {
        lock.withLock {
            guard let pomo = _pomodoro else { return false }
            if _active?.pomodoroConfig?.strictMode == true { return false }
            return pomo.isBreak
        }
    }

    func incrementBlockAttempt() { lock.withLock { _blockAttempts += 1 } }

    func getStatus() -> DaemonStatus {
        lock.withLock {
            let rateRemaining = _nextUnlockAllowed > Date() ? _nextUnlockAllowed.timeIntervalSinceNow : nil
            let logs = getLogs(limit: 90)
            let sessionIsActive = computeIsActive()
            return DaemonStatus(
                sessionActive: sessionIsActive,
                session: _active,
                secondsRemaining: sessionIsActive ? computeRemainingSeconds() : nil,
                pomodoroPhase: _pomodoro?.phase,
                pomodoroSecondsRemaining: _pomodoro?.secondsRemaining,
                blockAttempts: _blockAttempts,
                hasFriendLock: _active?.unlockTokenHash != nil,
                friendLockRateLimited: rateRemaining != nil,
                friendLockRetryAfterSeconds: rateRemaining,
                hardcoreCooldownUntil: _hardcoreCooldownUntil.map { ISO8601DateFormatter().string(from: $0) },
                currentStreak: computeCurrentStreak(logs: logs),
                lastFocusScore: logs.first?.focusScore
            )
        }
    }

    func skipBreak() -> (String, Bool) {
        lock.withLock {
            guard let pomodoro = _pomodoro else { return ("No Pomodoro active", false) }
            guard pomodoro.isBreak else { return ("Not in a break phase", false) }
            guard _active?.pomodoroConfig?.strictMode != true else { return ("Strict mode — breaks cannot be skipped", false) }
            pomodoro.skipToWork()
            return ("", true)
        }
    }

    func requestDisableHardcore() -> (String, Bool) {
        lock.withLock {
            if let until = _hardcoreCooldownUntil, Date() < until { return ("Cooldown already in progress", false) }
            _hardcoreCooldownUntil = Date().addingTimeInterval(86400)
            fputs("[hardcore] Disable requested — cooldown until \(ISO8601DateFormatter().string(from: _hardcoreCooldownUntil!))\n", stderr)
            return ("", true)
        }
    }

    private func computeCurrentStreak(logs: [SessionLog]) -> Int {
        let completedDays = Set(logs.filter { $0.completed }.map { cal.startOfDay(for: $0.startTime) })
        guard !completedDays.isEmpty else { return 0 }
        let today = cal.startOfDay(for: Date())
        var streak = 0
        var day = today
        while completedDays.contains(day) { streak += 1; day = cal.date(byAdding: .day, value: -1, to: day)! }
        if streak == 0 {
            day = cal.date(byAdding: .day, value: -1, to: today)!
            while completedDays.contains(day) { streak += 1; day = cal.date(byAdding: .day, value: -1, to: day)! }
        }
        return streak
    }

    private let cal = Calendar.current

    func startSession(_ payload: StartSessionPayload) -> (String, Bool) {
        lock.withLock {
            guard !computeIsActive() else { return ("Session already active", false) }

            let trimmedIntention = payload.intention?.trimmingCharacters(in: .whitespacesAndNewlines)
            var state = SessionState(
                profileId: payload.profileId,
                startTime: Date(),
                endTime: Date().addingTimeInterval(Double(payload.durationMinutes) * 60),
                hardcoreMode: payload.hardcoreMode,
                blockedDomains: payload.blockedDomains,
                blockedProcesses: payload.blockedProcesses,
                allowlistedDomains: payload.allowlistedDomains,
                pomodoroConfig: payload.pomodoroConfig,
                unlockTokenHash: payload.unlockToken.map { hashToken($0) },
                motivationalMessage: payload.motivationalMessage,
                intention: (trimmedIntention?.isEmpty == false) ? trimmedIntention : nil
            )
            state.signature = sign(state, key: _signingKey)
            _active = state
            anchorMonotonic()
            _blockAttempts = 0
            _failedUnlockAttempts = 0
            _nextUnlockAllowed = .distantPast

            if let cfg = payload.pomodoroConfig {
                _pomodoro = PomodoroState(config: cfg, sessionStart: state.startTime)
            }
            persist(state)
            return ("", true)
        }
    }

    func stopSession(unlockToken: String? = nil) -> (String, Bool) {
        lock.withLock {
            guard let active = _active else { return ("No active session", false) }
            guard !active.hardcoreMode else { return ("Cannot stop a Hardcore Mode session", false) }

            if let tokenHash = active.unlockTokenHash {
                guard let provided = unlockToken, !provided.trimmingCharacters(in: .whitespaces).isEmpty else {
                    return ("Friend lock is active — provide the unlock token", false)
                }
                if Date() < _nextUnlockAllowed {
                    let wait = Int(_nextUnlockAllowed.timeIntervalSinceNow.rounded(.up))
                    return ("Too many failed attempts — wait \(wait)s", false)
                }
                let providedHash = hashToken(provided)
                guard providedHash == tokenHash else {
                    _failedUnlockAttempts += 1
                    let backoff = backoffSeconds(_failedUnlockAttempts)
                    _nextUnlockAllowed = Date().addingTimeInterval(Double(backoff))
                    return ("Incorrect token. Try again in \(backoff)s", false)
                }
                _failedUnlockAttempts = 0
            }

            finalizeSession(completed: false)
            return ("", true)
        }
    }

    func tick() {
        lock.withLock {
            guard _active != nil else { return }
            if !computeIsActive() {
                finalizeSession(completed: true)
            }
            _pomodoro?.tick(now: Date())
        }
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    private func finalizeSession(completed: Bool) {
        guard let active = _active else { return }
        let log = SessionLog(
            sessionId: active.sessionId,
            profileId: active.profileId,
            startTime: active.startTime,
            endTime: Date(),
            completed: completed,
            blockAttempts: _blockAttempts,
            focusScore: calculateScore(completed: completed),
            intention: active.intention
        )
        appendLog(log)
        _active = nil
        _pomodoro = nil
        try? FileManager.default.removeItem(at: Self.statePath)
    }

    private func calculateScore(completed: Bool) -> Int {
        guard completed else { return 0 }
        let penalty = min(_blockAttempts * 5, 50)
        let base = max(100 - penalty, 10)
        let streak = computeCurrentStreak(logs: getLogs(limit: 90))
        let multiplier = 1.0 + min(Double(streak) * 0.02, 0.20)
        return min(Int(Double(base) * multiplier), 100)
    }

    private func persist(_ state: SessionState) {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        if let data = try? enc.encode(state) {
            try? data.write(to: Self.statePath)
        }
    }

    private func appendLog(_ log: SessionLog) {
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        guard let data = try? enc.encode(log),
              var line = String(data: data, encoding: .utf8) else { return }
        line += "\n"
        if let fileHandle = FileHandle(forWritingAtPath: Self.logPath.path) {
            fileHandle.seekToEndOfFile()
            fileHandle.write(line.data(using: .utf8)!)
            fileHandle.closeFile()
        } else {
            try? line.data(using: .utf8)?.write(to: Self.logPath)
        }
    }

    func getLogs(limit: Int) -> [SessionLog] {
        guard let content = try? String(contentsOf: Self.logPath, encoding: .utf8) else { return [] }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        return content
            .components(separatedBy: "\n")
            .filter { !$0.isEmpty }
            .compactMap { try? dec.decode(SessionLog.self, from: Data($0.utf8)) }
            .suffix(limit)
            .reversed()
    }

    // ── HMAC signing ──────────────────────────────────────────────────────────

    private static func loadOrCreateKey() -> SymmetricKey {
        let path = keyPath
        if let data = try? Data(contentsOf: path), data.count == 32 {
            return SymmetricKey(data: data)
        }
        let key = SymmetricKey(size: .bits256)
        let raw = key.withUnsafeBytes { Data($0) }
        try? raw.write(to: path)
        // Restrict permissions: only root can read
        chmod(path.path, 0o600)
        return key
    }

    private func sign(_ s: SessionState, key: SymmetricKey) -> String {
        let parts: [String] = [
            s.sessionId,
            s.startTime.iso8601,
            s.endTime.iso8601,
            "\(s.hardcoreMode)",
            s.blockedDomains.joined(separator: ","),
            s.blockedProcesses.joined(separator: ","),
            s.allowlistedDomains.joined(separator: ","),
            s.unlockTokenHash ?? "",
        ]
        let payload = parts.joined(separator: "|")
        let mac = HMAC<SHA256>.authenticationCode(for: Data(payload.utf8), using: key)
        return Data(mac).hexString
    }

    private static func loadPersistedSession(key: SymmetricKey) -> SessionState? {
        guard let data = try? Data(contentsOf: statePath) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        guard let state = try? dec.decode(SessionState.self, from: data) else { return nil }
        guard state.isActive else { return nil }
        return state
    }

    private func hashToken(_ token: String) -> String {
        let digest = SHA256.hash(data: Data(token.trimmingCharacters(in: .whitespaces).utf8))
        return Data(digest).hexString
    }

    private func backoffSeconds(_ attempts: Int) -> Int {
        switch attempts {
        case 1: return 10
        case 2: return 30
        case 3: return 60
        default: return 300
        }
    }
}

// ── Extensions ────────────────────────────────────────────────────────────────

private extension Date {
    var iso8601: String {
        ISO8601DateFormatter().string(from: self)
    }
}

extension Data {
    var hexString: String { map { String(format: "%02x", $0) }.joined() }
}

extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        lock(); defer { unlock() }
        return body()
    }
}
