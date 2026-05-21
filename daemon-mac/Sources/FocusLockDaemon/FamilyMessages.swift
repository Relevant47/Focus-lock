import Foundation

// ── On-disk + IPC family state ─────────────────────────────────────────────

/// Persisted under /Library/Application Support/FocusLock/family.json.
/// Missing/empty file means not paired.
struct FamilyConfig: Codable {
    var serverUrl: String
    var accountId: String
    var deviceId: String
    var deviceToken: String  // 1-year JWT
    var pairedAt: String
    var hostname: String?
    /// Mirror of the Windows flag. macOS daemon doesn't currently implement
    /// firewall lockdown (pfctl deferred), but the flag round-trips so a
    /// future implementation can read it without a schema bump.
    var firewallLockdownEnabled: Bool?
}

struct FamilyRuleSummary: Codable {
    var id: String
    var kind: String          // block_now | schedule | unblock_all
    var targetApps: [String]
    var targetDomains: [String]
    var scheduleCron: String?
    var createdAt: String
}

struct FamilyStatus: Codable {
    var paired: Bool
    var connected: Bool
    var accountId: String?
    var deviceId: String?
    var serverUrl: String?
    var lastConnectedAt: String?
    var lastDisconnectedAt: String?
    var lastError: String?
    var activeRuleCount: Int
    /// Seconds since the last successful connection. 0 when currently connected.
    var offlineSeconds: Int
    var activeRules: [FamilyRuleSummary]
    var firewallLockdownEnabled: Bool
    var firewallLockdownActive: Bool
}

// ── IPC payloads ───────────────────────────────────────────────────────────

struct FamilyRedeemPayload: Codable {
    var code: String
    var serverUrl: String
}

struct FamilyRedeemResult: Codable {
    var accountId: String
    var deviceId: String
    var pairedAt: String
}

/// Snapshot of the host environment as seen by the daemon. Used by the parent
/// setup flow to gate pairing on a non-admin child account being available
/// and to surface elevation warnings.
struct FamilyEnvironment: Codable {
    var platform: String            // "windows" | "macos"
    var osVersion: String
    var daemonElevated: Bool        // SYSTEM (Win) or root (mac)
    var uacEnabled: Bool?           // Windows-only; nil on macOS
    var currentUser: String?        // Daemon's own identity (informational)
    var localUsers: [LocalUserAccount]  // Per-user admin enumeration; empty when unavailable
}

/// One local account on the host. Surfaced so the parent setup flow can name
/// which accounts need to be demoted from administrator before pairing.
struct LocalUserAccount: Codable {
    var name: String
    var isAdmin: Bool
    var isCurrent: Bool
    var isBuiltIn: Bool
}

// ── Cloud wire shapes ──────────────────────────────────────────────────────

struct CloudRule: Codable {
    var id: String
    var deviceId: String
    var kind: String
    var targetApps: [String]
    var targetDomains: [String]
    var scheduleCron: String?
    var active: Bool
    var createdAt: String
}

struct CloudRulesEnvelope: Codable {
    var rules: [CloudRule]
}

struct CloudMessage: Codable {
    var type: String
    var rule: CloudRule?
    var ruleId: String?
    var t: Int64?
}

struct RedeemResponse: Codable {
    var accountId: String
    var deviceId: String
    var deviceToken: String
    var expiresInSeconds: Int64
}
