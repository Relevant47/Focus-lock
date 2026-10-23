import Foundation

/// macOS counterpart to the Windows BrowserDohPolicyService. Forces
/// Chrome / Edge / Brave / Firefox off DNS-over-HTTPS while a session is
/// active. Without this, browser DoH bypasses /etc/hosts entirely — the
/// daemon writes `127.0.0.1 youtube.com` correctly, but the browser never
/// asks the OS to resolve it, so the block is invisible to the user.
///
/// On macOS the equivalent of Windows' HKLM Group Policy keys is a
/// managed-preference plist under `/Library/Managed Preferences/`. This is
/// the same admin/root scope as the daemon, and is the way Chrome, Edge,
/// Brave and Firefox actually read enterprise policy on macOS.
///
/// `apply()` backs up the prior plist contents to
/// `/Library/Application Support/FocusLock/doh_backup.json` once, writes the
/// "off" values, and is idempotent on subsequent calls. `restore()` reads
/// the backup and either rewrites the original value or deletes the value
/// (and the plist file, if we created it) if it was not previously set,
/// then deletes the backup file.
final class BrowserDohPolicyService {
    private static let stateDir: URL = {
        let base = URL(fileURLWithPath: "/Library/Application Support/FocusLock")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }()
    private static let managedPrefsDir = URL(fileURLWithPath: "/Library/Managed Preferences")
    private static let backupPath = stateDir.appendingPathComponent("doh_backup.json")

    /// One entry per browser plist we touch. Identified by `id` in the
    /// backup JSON.
    private struct PolicyTarget {
        /// Stable identifier used as a key in the backup JSON.
        let id: String
        /// Bundle / preference domain — file lives at
        /// `/Library/Managed Preferences/<domain>.plist`.
        let domain: String
        /// What this policy looks like.
        let kind: Kind

        enum Kind {
            /// Top-level string key with the given off value. Chrome / Edge / Brave.
            case topLevelString(key: String, offValue: String)
            /// Nested `DNSOverHTTPS` dict with `Enabled = false`. Firefox's
            /// documented enterprise policy mirrors Windows
            /// `Software\Policies\Mozilla\Firefox\DNSOverHTTPS\Enabled = 0`.
            case firefoxDnsOverHttpsDict
        }
    }

    private static let targets: [PolicyTarget] = [
        .init(id: "chrome",  domain: "com.google.Chrome",
              kind: .topLevelString(key: "DnsOverHttpsMode", offValue: "off")),
        .init(id: "edge",    domain: "com.microsoft.Edge",
              kind: .topLevelString(key: "DnsOverHttpsMode", offValue: "off")),
        .init(id: "brave",   domain: "com.brave.Browser",
              kind: .topLevelString(key: "DnsOverHttpsMode", offValue: "off")),
        .init(id: "firefox", domain: "org.mozilla.firefox",
              kind: .firefoxDnsOverHttpsDict),
    ]

    private let lock = NSLock()

    init() {}

    /// Force browser DoH off across all four plists, after backing up prior
    /// contents on first call. Safe to call repeatedly — subsequent calls
    /// reapply the "off" value but never overwrite the backup, so the
    /// original user preference is preserved across the whole session.
    func apply() {
        lock.lock(); defer { lock.unlock() }

        // If a backup already exists on disk we leave it alone — it captured
        // the *original* user preference, which is what we need to restore.
        // Re-snapshotting now would lock in our own "off" value as the user's
        // preference, defeating the restore.
        //
        // Trust the loaded dict, not FileManager.fileExists: a corrupt or
        // empty file used to satisfy fileExists but produced an empty dict,
        // which caused apply() to skip capture *and* skip save (leaving the
        // corrupt file in place) — and later caused restore() to delete
        // every DoH policy value. loadBackup() now clears corrupt files;
        // !backup.isEmpty is the ground truth.
        var backup = loadBackup()
        let backupExisted = !backup.isEmpty

        for target in Self.targets {
            do {
                if !backupExisted && backup[target.id] == nil {
                    backup[target.id] = readCurrent(target)
                }

                if try isAlreadyOff(target) {
                    continue
                }

                try writeOff(target)
                fputs("[doh] policy applied: \(target.domain)\n", stderr)
            } catch {
                fputs("[doh] failed to apply policy \(target.domain): \(error)\n", stderr)
            }
        }

        if !backupExisted {
            saveBackup(backup)
        }
    }

    /// Restore the original DoH policy values from the backup file, or
    /// remove our values if no backup exists (e.g. clean reinstall). Deletes
    /// the backup JSON on success so the next session captures a fresh
    /// snapshot.
    func restore() {
        lock.lock(); defer { lock.unlock() }

        guard FileManager.default.fileExists(atPath: Self.backupPath.path) else {
            return
        }

        let backup = loadBackup()

        if backup.isEmpty {
            // Backup file was empty or unreadable (loadBackup already
            // cleared it if it was corrupt). We have no record of the user's
            // original DoH preferences — deleting all four values now would
            // silently wipe them. Leave the current "off" values in place;
            // the operator can rerun a fresh session to re-capture, or
            // manually reconfigure their browser DoH.
            fputs("[doh] backup was empty or unreadable — skipping restore to avoid wiping unknown originals\n", stderr)
            return
        }

        for target in Self.targets {
            do {
                guard let prior = backup[target.id] else {
                    // No backup row for this key — treat as "was unset".
                    try deleteValue(target, plistDidNotExistBefore: true)
                    continue
                }

                if !prior.wasSet {
                    try deleteValue(target, plistDidNotExistBefore: !prior.plistExisted)
                } else {
                    try writeOriginal(target, prior: prior)
                }
                fputs("[doh] policy restored: \(target.domain)\n", stderr)
            } catch {
                fputs("[doh] failed to restore policy \(target.domain): \(error)\n", stderr)
            }
        }

        do {
            try FileManager.default.removeItem(at: Self.backupPath)
        } catch {
            fputs("[doh] could not delete backup file: \(error)\n", stderr)
        }
    }

    // ── Plist helpers ─────────────────────────────────────────────────────────

    private func plistURL(for target: PolicyTarget) -> URL {
        Self.managedPrefsDir.appendingPathComponent("\(target.domain).plist")
    }

    /// Reads the plist at the given URL into a mutable dictionary. Returns
    /// `nil` if the file does not exist, an empty dict if it exists but is
    /// malformed.
    private func readPlist(at url: URL) -> [String: Any]? {
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        guard let data = try? Data(contentsOf: url) else { return [:] }
        guard let obj = try? PropertyListSerialization.propertyList(
            from: data, options: [], format: nil) else { return [:] }
        return (obj as? [String: Any]) ?? [:]
    }

    /// Atomically writes a dictionary as a binary plist to the given URL,
    /// creating the parent directory if necessary.
    private func writePlist(_ dict: [String: Any], to url: URL) throws {
        try FileManager.default.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true)
        let data = try PropertyListSerialization.data(
            fromPropertyList: dict, format: .binary, options: 0)
        try data.write(to: url, options: .atomic)
    }

    // ── Per-target operations ─────────────────────────────────────────────────

    private func readCurrent(_ target: PolicyTarget) -> BackupEntry {
        let url = plistURL(for: target)
        let plist = readPlist(at: url)
        let plistExisted = (plist != nil)
        let dict = plist ?? [:]

        switch target.kind {
        case .topLevelString(let key, _):
            if let v = dict[key] as? String {
                return BackupEntry(wasSet: true, kind: "string",
                                   stringValue: v, intValue: nil, boolValue: nil,
                                   firefoxDohDict: nil, plistExisted: plistExisted)
            }
            return BackupEntry(wasSet: false, kind: nil,
                               stringValue: nil, intValue: nil, boolValue: nil,
                               firefoxDohDict: nil, plistExisted: plistExisted)

        case .firefoxDnsOverHttpsDict:
            if let sub = dict["DNSOverHTTPS"] as? [String: Any] {
                // Capture the whole dict so we can rewrite it exactly.
                let captured = encodeFirefoxDohDict(sub)
                return BackupEntry(wasSet: true, kind: "firefoxDohDict",
                                   stringValue: nil, intValue: nil, boolValue: nil,
                                   firefoxDohDict: captured, plistExisted: plistExisted)
            }
            return BackupEntry(wasSet: false, kind: nil,
                               stringValue: nil, intValue: nil, boolValue: nil,
                               firefoxDohDict: nil, plistExisted: plistExisted)
        }
    }

    private func isAlreadyOff(_ target: PolicyTarget) throws -> Bool {
        let url = plistURL(for: target)
        guard let dict = readPlist(at: url) else { return false }

        switch target.kind {
        case .topLevelString(let key, let off):
            return (dict[key] as? String) == off
        case .firefoxDnsOverHttpsDict:
            guard let sub = dict["DNSOverHTTPS"] as? [String: Any] else { return false }
            let enabled = (sub["Enabled"] as? Bool) ?? (((sub["Enabled"] as? NSNumber)?.boolValue) ?? true)
            return enabled == false
        }
    }

    private func writeOff(_ target: PolicyTarget) throws {
        let url = plistURL(for: target)
        var dict = readPlist(at: url) ?? [:]

        switch target.kind {
        case .topLevelString(let key, let off):
            dict[key] = off
        case .firefoxDnsOverHttpsDict:
            // Lock the policy too — `Locked = true` prevents the user from
            // overriding it via about:config during the session, matching
            // the spirit of the Windows HKLM\Software\Policies enforcement.
            dict["DNSOverHTTPS"] = ["Enabled": false, "Locked": true] as [String: Any]
        }

        try writePlist(dict, to: url)
    }

    private func writeOriginal(_ target: PolicyTarget, prior: BackupEntry) throws {
        let url = plistURL(for: target)
        var dict = readPlist(at: url) ?? [:]

        switch target.kind {
        case .topLevelString(let key, _):
            if let s = prior.stringValue {
                dict[key] = s
            }
        case .firefoxDnsOverHttpsDict:
            if let captured = prior.firefoxDohDict {
                dict["DNSOverHTTPS"] = decodeFirefoxDohDict(captured)
            }
        }

        try writePlist(dict, to: url)
    }

    /// Removes the target's value from its plist. If the plist did not
    /// exist before we touched it AND removing our value would leave the
    /// plist empty, we delete the plist file entirely so we don't leave a
    /// stub behind that may surprise users or MDM tooling.
    private func deleteValue(_ target: PolicyTarget, plistDidNotExistBefore: Bool) throws {
        let url = plistURL(for: target)
        guard var dict = readPlist(at: url) else { return }

        switch target.kind {
        case .topLevelString(let key, _):
            dict.removeValue(forKey: key)
        case .firefoxDnsOverHttpsDict:
            dict.removeValue(forKey: "DNSOverHTTPS")
        }

        if plistDidNotExistBefore && dict.isEmpty {
            try FileManager.default.removeItem(at: url)
            return
        }

        if dict.isEmpty {
            // Edge case: file existed before but was empty originally —
            // rewrite as empty plist rather than deleting.
            try writePlist(dict, to: url)
            return
        }

        try writePlist(dict, to: url)
    }

    // ── Firefox DNSOverHTTPS dict JSON encoding ───────────────────────────────

    /// Reduces a `DNSOverHTTPS` policy dict to a JSON-friendly form for the
    /// backup file. Only the keys Firefox actually reads (Enabled, Locked,
    /// ProviderURL, ExcludedDomains) round-trip cleanly. Unknown keys are
    /// preserved as strings where possible.
    private func encodeFirefoxDohDict(_ dict: [String: Any]) -> [String: FirefoxDohValue] {
        var out: [String: FirefoxDohValue] = [:]
        for (k, v) in dict {
            if let b = v as? Bool {
                out[k] = FirefoxDohValue(kind: "bool", boolValue: b, stringValue: nil, stringArray: nil)
            } else if let n = v as? NSNumber {
                // NSNumber for bool is captured above via cast. Anything else
                // we treat as int — Firefox's DNSOverHTTPS policy has no ints
                // today but capture defensively.
                out[k] = FirefoxDohValue(kind: "bool", boolValue: n.boolValue, stringValue: nil, stringArray: nil)
            } else if let s = v as? String {
                out[k] = FirefoxDohValue(kind: "string", boolValue: nil, stringValue: s, stringArray: nil)
            } else if let arr = v as? [String] {
                out[k] = FirefoxDohValue(kind: "stringArray", boolValue: nil, stringValue: nil, stringArray: arr)
            }
        }
        return out
    }

    private func decodeFirefoxDohDict(_ encoded: [String: FirefoxDohValue]) -> [String: Any] {
        var out: [String: Any] = [:]
        for (k, v) in encoded {
            switch v.kind {
            case "bool":   if let b = v.boolValue   { out[k] = b }
            case "string": if let s = v.stringValue { out[k] = s }
            case "stringArray": if let a = v.stringArray { out[k] = a }
            default: break
            }
        }
        return out
    }

    // ── Backup JSON I/O ───────────────────────────────────────────────────────

    private func loadBackup() -> [String: BackupEntry] {
        guard FileManager.default.fileExists(atPath: Self.backupPath.path) else {
            return [:]
        }
        guard let data = try? Data(contentsOf: Self.backupPath) else { return [:] }
        let dec = JSONDecoder()
        guard let dict = try? dec.decode([String: BackupEntry].self, from: data) else {
            fputs("[doh] backup file unreadable — deleting and treating as fresh\n", stderr)
            do {
                try FileManager.default.removeItem(at: Self.backupPath)
            } catch {
                fputs("[doh] could not delete corrupt DoH backup file at \(Self.backupPath.path): \(error)\n", stderr)
            }
            return [:]
        }
        return dict
    }

    private func saveBackup(_ backup: [String: BackupEntry]) {
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        do {
            try FileManager.default.createDirectory(
                at: Self.stateDir, withIntermediateDirectories: true)
            let data = try enc.encode(backup)
            try data.write(to: Self.backupPath, options: .atomic)
        } catch {
            fputs("[doh] failed to write backup file: \(error)\n", stderr)
        }
    }

    // ── Backup record ─────────────────────────────────────────────────────────

    /// One row per `PolicyTarget`. The Codable shape is intentionally flat
    /// so the JSON file is human-readable and trivially diffable when
    /// debugging on a user machine.
    struct BackupEntry: Codable {
        let wasSet: Bool
        let kind: String?
        let stringValue: String?
        let intValue: Int?
        let boolValue: Bool?
        let firefoxDohDict: [String: FirefoxDohValue]?
        let plistExisted: Bool
    }

    struct FirefoxDohValue: Codable {
        let kind: String
        let boolValue: Bool?
        let stringValue: String?
        let stringArray: [String]?
    }
}
