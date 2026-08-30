import Foundation

/// Holds the currently-effective cloud rules and exposes a union view that
/// the enforcement loop applies alongside any active focus session.
///
/// Phase 2.3 semantics:
///   • block_now    → blocked domains + processes added to the union.
///   • unblock_all  → kill-switch; family-side enforcement suppressed while present.
///   • schedule     → stored and surfaced in status but cron evaluation is
///                    deferred to Phase 2.4.
///
/// Rules are cached to family-rules.json so daemon restart re-applies the
/// last-known state before the WebSocket reconnects.
final class FamilyEnforcementService {
    private static let cachePath = "/Library/Application Support/FocusLock/family-rules.json"

    private let lock = NSLock()
    private var rules: [String: CloudRule] = [:]
    private var listeners: [() -> Void] = []
    private let signer: IntegritySigner
    private let audit: ParentAuditService
    // Compiled cron evaluators keyed by rule ID. Rebuilt as rules change so
    // we don't re-parse on every tick.
    private var cron: [String: CronEvaluator] = [:]

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()
    private let decoder = JSONDecoder()

    init(signer: IntegritySigner, audit: ParentAuditService) {
        self.signer = signer
        self.audit = audit
        loadCache()
    }

    func onRulesChanged(_ cb: @escaping () -> Void) {
        lock.lock(); listeners.append(cb); lock.unlock()
    }

    private func fire() {
        lock.lock()
        let copy = listeners
        lock.unlock()
        for l in copy { l() }
    }

    var hasActiveBlocks: Bool {
        lock.lock(); defer { lock.unlock() }
        if hasUnblockAllLocked() { return false }
        let now = Date()
        // Mirror union(): collect block_now/schedule targets, then lift
        // anything covered by a live unblock_specific rule. If nothing
        // survives, no blocks are actually enforced.
        var domains = Set<String>()
        var procs   = Set<String>()
        for r in rules.values where r.active {
            if r.targetDomains.isEmpty && r.targetApps.isEmpty { continue }
            let active = r.kind == "block_now"
                || (r.kind == "schedule" && (cron[r.id]?.matches(now) ?? false))
            guard active else { continue }
            for d in r.targetDomains where !d.isEmpty { domains.insert(d) }
            for a in r.targetApps    where !a.isEmpty { procs.insert(a) }
        }
        if domains.isEmpty && procs.isEmpty { return false }
        for r in rules.values where r.active && r.kind == "unblock_specific" {
            if let exp = r.expiresAt, !isFuture(exp) { continue }
            for d in r.targetDomains { domains.remove(d) }
            for a in r.targetApps    { procs.remove(a) }
            if domains.isEmpty && procs.isEmpty { return false }
        }
        return !domains.isEmpty || !procs.isEmpty
    }

    func union() -> (domains: [String], processes: [String]) {
        lock.lock(); defer { lock.unlock() }
        if hasUnblockAllLocked() { return ([], []) }
        let now = Date()
        var domains = Set<String>()
        var procs   = Set<String>()
        for r in rules.values where r.active {
            let active = r.kind == "block_now"
                || (r.kind == "schedule" && (cron[r.id]?.matches(now) ?? false))
            guard active else { continue }
            for d in r.targetDomains where !d.isEmpty { domains.insert(d) }
            for a in r.targetApps    where !a.isEmpty { procs.insert(a) }
        }
        // Phase 3.2: unblock_specific lifts the matching items as long as the
        // rule hasn't expired. We treat a nil expiresAt defensively (the server
        // filters out expired rules on the wire, so we shouldn't see one here,
        // but if we do we treat it as live).
        for r in rules.values where r.active && r.kind == "unblock_specific" {
            if let exp = r.expiresAt, !isFuture(exp) { continue }
            for d in r.targetDomains { domains.remove(d) }
            for a in r.targetApps    { procs.remove(a) }
        }
        return (Array(domains), Array(procs))
    }

    func snapshot() -> [FamilyRuleSummary] {
        lock.lock(); defer { lock.unlock() }
        return rules.values.map { r in
            FamilyRuleSummary(
                id: r.id, kind: r.kind,
                targetApps: r.targetApps, targetDomains: r.targetDomains,
                scheduleCron: r.scheduleCron, createdAt: r.createdAt,
                expiresAt: r.expiresAt)
        }
    }

    // ── Mutators ───────────────────────────────────────────────────────────

    func upsert(_ rule: CloudRule) {
        if rule.id.isEmpty { return }
        var changed = false
        lock.lock()
        let existing = rules[rule.id]
        if existing == nil || !equalLocked(existing!, rule) {
            rules[rule.id] = rule
            rebuildCronLocked()
            saveCacheLocked()
            changed = true
        }
        lock.unlock()
        if changed {
            fputs("[family] rule upsert id=\(rule.id) kind=\(rule.kind)\n", stderr)
            fire()
        }
    }

    func remove(ruleId: String) {
        var changed = false
        lock.lock()
        if rules.removeValue(forKey: ruleId) != nil {
            rebuildCronLocked()
            saveCacheLocked()
            changed = true
        }
        lock.unlock()
        if changed {
            fputs("[family] rule removed id=\(ruleId)\n", stderr)
            fire()
        }
    }

    func replace(_ newRules: [CloudRule]) {
        lock.lock()
        rules = Dictionary(uniqueKeysWithValues: newRules
            .filter { !$0.id.isEmpty }
            .map { ($0.id, $0) })
        rebuildCronLocked()
        saveCacheLocked()
        lock.unlock()
        fputs("[family] rules replaced count=\(newRules.count)\n", stderr)
        fire()
    }

    func clearAll() {
        var changed = false
        lock.lock()
        if !rules.isEmpty {
            rules.removeAll()
            cron.removeAll()
            signer.deleteSigned(path: Self.cachePath)
            changed = true
        }
        lock.unlock()
        if changed {
            fputs("[family] rules cleared\n", stderr)
            fire()
        }
    }

    // ── Internals ──────────────────────────────────────────────────────────

    /// Recomputes `cron` from `rules`. Caller holds the lock.
    private func rebuildCronLocked() {
        var next: [String: CronEvaluator] = [:]
        for r in rules.values {
            guard r.kind == "schedule", let cronStr = r.scheduleCron, !cronStr.isEmpty else { continue }
            if let c = CronEvaluator.parse(cronStr) {
                next[r.id] = c
            } else {
                fputs("[family] schedule rule \(r.id) has invalid cron '\(cronStr)' — ignored\n", stderr)
            }
        }
        cron = next
    }

    private func hasUnblockAllLocked() -> Bool {
        for r in rules.values where r.active && r.kind == "unblock_all" { return true }
        return false
    }

    private func equalLocked(_ a: CloudRule, _ b: CloudRule) -> Bool {
        return a.active == b.active
            && a.kind == b.kind
            && a.scheduleCron == b.scheduleCron
            && a.expiresAt == b.expiresAt
            && a.targetApps == b.targetApps
            && a.targetDomains == b.targetDomains
    }

    /// True iff the ISO-8601 timestamp parses and lies strictly in the future.
    /// Used to decide whether an unblock_specific rule is still in effect.
    private func isFuture(_ iso: String) -> Bool {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d > Date() }
        // Some emitters omit fractional seconds; retry without that option.
        f.formatOptions = [.withInternetDateTime]
        if let d = f.date(from: iso) { return d > Date() }
        return false
    }

    private func loadCache() {
        guard let data = signer.readVerified(path: Self.cachePath) else {
            if FileManager.default.fileExists(atPath: Self.cachePath) {
                fputs("[family] cache has no valid signature — discarding\n", stderr)
                audit.record(ParentAuditEvents.familyCacheTampered, detail: "family-rules.json")
            }
            return
        }
        do {
            let arr = try decoder.decode([CloudRule].self, from: data)
            rules = Dictionary(uniqueKeysWithValues: arr.filter { !$0.id.isEmpty }.map { ($0.id, $0) })
            rebuildCronLocked()
            fputs("[family] cache loaded count=\(rules.count)\n", stderr)
        } catch {
            fputs("[family] cache unreadable: \(error)\n", stderr)
        }
    }

    private func saveCacheLocked() {
        do {
            let arr = Array(rules.values)
            let data = try encoder.encode(arr)
            signer.writeSigned(path: Self.cachePath, data: data)
        } catch {
            fputs("[family] cache write failed: \(error)\n", stderr)
        }
    }
}
