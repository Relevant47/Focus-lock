import Foundation

/// Append-only audit log for parental-control events. Mirrors the sessions.jsonl
/// pattern: one JSON record per line at /Library/Application Support/FocusLock/parent.audit.jsonl.
/// Surfaced to a verified parent via get_parent_audit IPC.
final class ParentAuditService {
    private static let stateDir = URL(fileURLWithPath: "/Library/Application Support/FocusLock")
    private static let logPath = stateDir.appendingPathComponent("parent.audit.jsonl")

    private let writeLock = NSLock()
    private var permissionsApplied = false

    private let enc: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        e.dateEncodingStrategy = .iso8601
        return e
    }()
    private let dec: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    init() {
        try? FileManager.default.createDirectory(at: Self.stateDir, withIntermediateDirectories: true)
    }

    func record(_ eventType: String, command: String? = nil, detail: String? = nil) {
        let entry = ParentAuditEntry(
            timestamp: Date(),
            event: eventType,
            command: command,
            detail: detail
        )
        do {
            let data = try enc.encode(entry)
            guard var line = String(data: data, encoding: .utf8) else { return }
            line += "\n"
            writeLock.withLock {
                if let handle = FileHandle(forWritingAtPath: Self.logPath.path) {
                    handle.seekToEndOfFile()
                    handle.write(line.data(using: .utf8)!)
                    handle.closeFile()
                } else {
                    try? line.data(using: .utf8)?.write(to: Self.logPath)
                }
                ensurePermissionsLocked()
            }
        } catch {
            fputs("[parent-audit] Failed to record event \(eventType)\n", stderr)
        }
    }

    /// Returns the most recent `limit` entries, newest first.
    func recent(limit: Int) -> [ParentAuditEntry] {
        guard let content = try? String(contentsOf: Self.logPath, encoding: .utf8) else { return [] }
        return content
            .components(separatedBy: "\n")
            .filter { !$0.isEmpty }
            .compactMap { try? dec.decode(ParentAuditEntry.self, from: Data($0.utf8)) }
            .suffix(limit)
            .reversed()
    }

    private func ensurePermissionsLocked() {
        // Apply chmod 600 once per process lifetime — after the first append creates
        // the file. Mirrors parent.cred / parent.tokenkey: only root can read.
        if permissionsApplied { return }
        chmod(Self.logPath.path, 0o600)
        permissionsApplied = true
    }
}

struct ParentAuditEntry: Codable {
    var timestamp: Date
    var event: String
    var command: String?
    var detail: String?
}

/// Wire-stable event names matching the Windows daemon and shared/protocol.ts.
enum ParentAuditEvents {
    static let pinSet              = "pin_set"
    static let pinChanged          = "pin_changed"
    static let pinCleared          = "pin_cleared"
    static let pinVerifySuccess    = "pin_verify_success"
    static let pinVerifyFail       = "pin_verify_fail"
    static let pinVerifyRateLimit  = "pin_verify_rate_limited"
    static let gateBlocked         = "gate_blocked"
    static let gateAllowed         = "gate_allowed"
    static let familyPaired        = "family_paired"
    static let familyUnpaired      = "family_unpaired"
    static let familyOffline5Min   = "family_offline_5min"
    static let familyReconnected   = "family_reconnected"
    static let familyCacheTampered = "family_cache_tampered"
    static let uninstallAuthorized = "uninstall_authorized"
}
