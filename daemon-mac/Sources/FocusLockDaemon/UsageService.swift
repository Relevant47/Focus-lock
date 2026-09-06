import Foundation
import SystemConfiguration  // SCDynamicStoreCopyConsoleUser

/// Owns usage.db and serves the seven `usage.*` IPC verbs.
///
/// Concurrency model: every DB touch runs on the private serial queue
/// `focuslock.usage`. Reads that a UI caller waits on use `queue.sync`;
/// fire-and-forget writes (report_sample) use `queue.async`.
///
/// Enable/disable atomicity follows Oscar's spec:
///   ENABLE  : create → migrate → seed → registerHelper → ok
///             (rollback deletes the file if helper registration fails)
///   DISABLE : unregisterHelper → close+delete → ok
///             (if unregister fails the DB is preserved so the user is recoverable)
final class UsageService {
    private let stateDir: String
    private let queue = DispatchQueue(label: "focuslock.usage")
    private var db: UsageDB?
    private var retentionTimer: DispatchSourceTimer?

    /// Path getter — value never changes after init.
    private var dbPath: String { "\(stateDir)/usage.db" }
    private var walPath: String { "\(stateDir)/usage.db-wal" }
    private var shmPath: String { "\(stateDir)/usage.db-shm" }
    /// Rollback-journal sidecar. `UsageDB` currently opens in the default
    /// rollback mode, not WAL, so a force-killed daemon can leave this file
    /// on disk holding pre-transaction pages with sample data. We wipe it
    /// alongside `-wal` / `-shm` on every delete path so a future switch
    /// between journal modes can't leave recoverable sample bytes behind.
    private var journalPath: String { "\(stateDir)/usage.db-journal" }

    // MARK: - Init

    init(stateDir: String) {
        self.stateDir = stateDir
        try? FileManager.default.createDirectory(
            atPath: stateDir, withIntermediateDirectories: true, attributes: nil)
        // Reopen if a DB file already exists (a previous enable survived a
        // daemon restart). We do NOT re-seed — the meta rows persist across
        // restarts and re-seeding would zero enabled_at_utc.
        if FileManager.default.fileExists(atPath: dbPath) {
            do {
                let opened = try UsageDB(path: dbPath)
                queue.sync { self.db = opened }
                fputs("[usage] Reopened existing usage.db at \(dbPath)\n", stderr)
            } catch {
                fputs("[usage] Failed to reopen existing usage.db: \(error)\n", stderr)
            }
        }
    }

    // MARK: - Enable / Disable (atomic per Oscar's order)

    func handleEnable() -> (String?, Bool) {
        return queue.sync {
            // Idempotent: already enabled → success no-op.
            if db != nil { return (nil, true) }

            let opened: UsageDB
            do {
                // (1) Create DB file
                opened = try UsageDB(path: dbPath)
                // (2) Run migrations
                try opened.runMigrations()
                // (3) Seed usage_meta rows
                try opened.seedMeta(
                    retentionDays: "90",
                    sampleRateSeconds: 5,
                    enabledAtUTC: Self.nowIso()
                )
            } catch {
                // Partial-create: scrub the file so a retry starts clean.
                try? FileManager.default.removeItem(atPath: dbPath)
                try? FileManager.default.removeItem(atPath: walPath)
                try? FileManager.default.removeItem(atPath: shmPath)
                try? FileManager.default.removeItem(atPath: journalPath)
                return ("Failed to initialize usage.db: \(error)", false)
            }

            // (4) Register the LaunchAgent for the console user.
            let (helperErr, helperOk) = registerLaunchAgent()
            if !helperOk {
                // Rollback: close DB then delete the file.
                opened.close()
                try? FileManager.default.removeItem(atPath: dbPath)
                try? FileManager.default.removeItem(atPath: walPath)
                try? FileManager.default.removeItem(atPath: shmPath)
                try? FileManager.default.removeItem(atPath: journalPath)
                return (helperErr ?? "Failed to register helper", false)
            }

            self.db = opened
            fputs("[usage] Enabled — usage.db at \(dbPath)\n", stderr)
            // (5) Return ok
            return (nil, true)
        }
    }

    func handleDisable() -> (String?, Bool) {
        return queue.sync {
            // Idempotent: already disabled → success. Also scrub any orphan file.
            if db == nil {
                try? FileManager.default.removeItem(atPath: dbPath)
                try? FileManager.default.removeItem(atPath: walPath)
                try? FileManager.default.removeItem(atPath: shmPath)
                try? FileManager.default.removeItem(atPath: journalPath)
                return (nil, true)
            }

            // (1) Unregister the LaunchAgent for the console user.
            let (helperErr, helperOk) = unregisterLaunchAgent()
            if !helperOk {
                // Per spec: keep the DB so the user is recoverable.
                return (helperErr ?? "Failed to unregister helper", false)
            }

            // (2) Close SQLite handle THEN delete the file (per Oscar: `rm`, not DELETE FROM).
            db?.close()
            db = nil
            do {
                try FileManager.default.removeItem(atPath: dbPath)
            } catch {
                let ns = error as NSError
                // File-already-gone races are fine; everything else is a partial-disable.
                if ns.code != NSFileNoSuchFileError && ns.domain != NSCocoaErrorDomain {
                    return ("Failed to delete usage.db: \(error)", false)
                }
            }
            try? FileManager.default.removeItem(atPath: walPath)
            try? FileManager.default.removeItem(atPath: shmPath)
            try? FileManager.default.removeItem(atPath: journalPath)
            fputs("[usage] Disabled — usage.db removed\n", stderr)
            return (nil, true)
        }
    }

    // MARK: - Sample / Query

    func handleReportSample(_ payload: UsageReportSamplePayload) {
        // Fire-and-forget: the IPC response is `ok` regardless of DB outcome
        // and we never block the socket on a disk write.
        queue.async {
            guard let db = self.db else { return }  // Silently drop when disabled.
            let day = Self.dayFromTimestamp(payload.timestamp)
            let inFocus  = payload.in_focus ? payload.seconds : 0
            let outFocus = payload.in_focus ? 0 : payload.seconds
            do {
                try db.upsertSample(
                    day: day,
                    userSid: "",                // macOS always uses ''
                    bundleId: payload.bundle_id,
                    appName: payload.app_name,
                    seconds: payload.seconds,
                    inFocusSeconds: inFocus,
                    outFocusSeconds: outFocus
                )
            } catch {
                fputs("[usage] upsertSample failed: \(error)\n", stderr)
            }
        }
    }

    func handleQuery(_ payload: UsageQueryPayload) -> UsageQueryResult {
        return queue.sync {
            guard let db = self.db else {
                return UsageQueryResult(rows: [], other_apps_total_seconds: nil)
            }
            let topN = payload.top_n
            let hasIncludeFilter = !(payload.include_apps?.isEmpty ?? true)
            do {
                let rows = try db.queryRange(
                    startDate: payload.start_date,
                    endDate: payload.end_date,
                    topN: topN,
                    includeApps: payload.include_apps
                )
                // Per §2.5: `other_apps_total_seconds` only appears when top_n
                // (not include_apps) truncated the result. Skip the second query
                // unless we've hit the LIMIT boundary. Exclude by bundle_id — a
                // top app's day-rows outside the top-N are still that app, not
                // "other apps."
                var otherTotal: Int? = nil
                if let n = topN, n > 0, !hasIncludeFilter, rows.count == n {
                    let full = try db.queryRange(
                        startDate: payload.start_date,
                        endDate: payload.end_date,
                        topN: nil,
                        includeApps: nil
                    )
                    if full.count > rows.count {
                        let topBundleIds = Set(rows.map { $0.bundle_id })
                        otherTotal = full
                            .filter { !topBundleIds.contains($0.bundle_id) }
                            .reduce(0) { $0 + $1.seconds }
                    }
                }
                return UsageQueryResult(rows: rows, other_apps_total_seconds: otherTotal)
            } catch {
                fputs("[usage] queryRange failed: \(error)\n", stderr)
                return UsageQueryResult(rows: [], other_apps_total_seconds: nil)
            }
        }
    }

    // MARK: - Settings

    func handleGetSettings() -> UsageGetSettingsResult {
        return queue.sync {
            guard let db = self.db else {
                return UsageGetSettingsResult(
                    enabled: false,
                    retention_days: "90",
                    sample_rate_seconds: 5,
                    enabled_at_utc: nil
                )
            }
            let enabled   = metaOr(db, key: "enabled", fallback: "0") == "1"
            let retention = metaOr(db, key: "retention_days", fallback: "90")
            let rateStr   = metaOr(db, key: "sample_rate_seconds", fallback: "5")
            let rawAt     = metaOr(db, key: "enabled_at_utc", fallback: "")
            return UsageGetSettingsResult(
                enabled: enabled,
                retention_days: retention,
                sample_rate_seconds: Int(rateStr) ?? 5,
                enabled_at_utc: rawAt.isEmpty ? nil : rawAt
            )
        }
    }

    func handleSetSettings(_ payload: UsageSetSettingsPayload) -> (String?, Bool) {
        return queue.sync {
            guard let db = self.db else {
                return ("Usage tracking is disabled", false)
            }
            if let r = payload.retention_days {
                let allowed: Set<String> = ["30", "90", "180", "365", "forever"]
                guard allowed.contains(r) else {
                    return ("Invalid retention_days: \(r)", false)
                }
                do { try db.setMeta(key: "retention_days", value: r) }
                catch { return ("Failed to update retention_days: \(error)", false) }
            }
            if let s = payload.sample_rate_seconds {
                guard s > 0 else { return ("sample_rate_seconds must be > 0", false) }
                do { try db.setMeta(key: "sample_rate_seconds", value: String(s)) }
                catch { return ("Failed to update sample_rate_seconds: \(error)", false) }
            }
            return (nil, true)
        }
    }

    func handleClearAllData() -> (String?, Bool) {
        return queue.sync {
            // Spec: delete file, recreate, re-seed. Tracking stays on.
            // If tracking is off there's nothing to clear — treat as no-op.
            guard let openDb = db else { return (nil, true) }

            // Preserve user settings across the wipe. Mirrors Windows behavior.
            let retention = ((try? openDb.getMeta(key: "retention_days")) ?? nil) ?? "90"
            let rateStr = ((try? openDb.getMeta(key: "sample_rate_seconds")) ?? nil) ?? "5"
            let rate = Int(rateStr) ?? 5
            let enabledAt = ((try? openDb.getMeta(key: "enabled_at_utc")) ?? nil) ?? Self.nowIso()

            openDb.close()
            db = nil
            try? FileManager.default.removeItem(atPath: dbPath)
            try? FileManager.default.removeItem(atPath: walPath)
            try? FileManager.default.removeItem(atPath: shmPath)
            try? FileManager.default.removeItem(atPath: journalPath)
            do {
                let opened = try UsageDB(path: dbPath)
                try opened.runMigrations()
                try opened.seedMeta(
                    retentionDays: retention,
                    sampleRateSeconds: rate,
                    enabledAtUTC: enabledAt
                )
                self.db = opened
                fputs("[usage] Cleared all usage data (tracking remains on)\n", stderr)
                return (nil, true)
            } catch {
                return ("Failed to reset usage.db: \(error)", false)
            }
        }
    }

    // MARK: - Retention timer

    func startRetentionTimer() {
        // Runs ON the same serial queue as all other DB ops → no locking needed.
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + .seconds(5),
                   repeating: .seconds(86_400),
                   leeway: .seconds(60))
        t.setEventHandler { [weak self] in self?.runRetentionPrune() }
        t.resume()
        retentionTimer = t
    }

    private func runRetentionPrune() {
        // Executes on `queue`; safe to touch db directly.
        guard let db = self.db else { return }
        let retention = metaOr(db, key: "retention_days", fallback: "90")
        if retention == "forever" { return }
        guard let days = Int(retention), days > 0 else { return }
        guard let cutoff = Calendar.current.date(byAdding: .day, value: -days, to: Date()) else {
            return
        }
        let day = Self.dayFormatter.string(from: cutoff)
        do {
            let n = try db.pruneOlderThan(day: day)
            if n > 0 { fputs("[usage] Pruned \(n) rows older than \(day)\n", stderr) }
        } catch {
            fputs("[usage] Retention prune failed: \(error)\n", stderr)
        }
    }

    // MARK: - LaunchAgent registration (Phase 3)
    //
    // The tracker runs in the console user's GUI session, not root — it needs
    // NSWorkspace.frontmostApplication which is a user-level API. We do that
    // by dropping a per-user LaunchAgent plist into
    // `~/Library/LaunchAgents/com.focuslock.usage-tracker.plist` and bootstrap-
    // ing it into that user's launchd domain with `launchctl bootstrap
    // gui/<uid>`. The daemon (running as root) has authority to write into
    // any user's LaunchAgents dir and to boot into any gui/<uid> domain.

    private static let launchAgentLabel  = "com.focuslock.usage-tracker"
    private static let launchAgentPlist  = "com.focuslock.usage-tracker.plist"

    /// Locate the FocusLockUsageTracker binary as a sibling of the running
    /// daemon binary.
    ///
    /// - In production the daemon lives at
    ///   `<...>/FocusLock.app/Contents/Library/LaunchDaemons/FocusLockDaemon`
    ///   and the tracker at
    ///   `<...>/FocusLock.app/Contents/Library/LaunchAgents/FocusLockUsageTracker`.
    ///   We detect the `LaunchDaemons` parent and swap it for `LaunchAgents`.
    /// - In `swift run` / dev builds both binaries land in
    ///   `.build/{release,debug}/` — the daemon and tracker are siblings and
    ///   we fall through to the same-directory case.
    ///
    /// Returns nil if we can't resolve any usable path.
    private func resolveTrackerPath() -> String? {
        guard let daemonPath = Bundle.main.executablePath ?? CommandLine.arguments.first else {
            return nil
        }
        let daemonURL = URL(fileURLWithPath: daemonPath).resolvingSymlinksInPath()
        let daemonDir = daemonURL.deletingLastPathComponent()
        if daemonDir.lastPathComponent == "LaunchDaemons" {
            let launchAgents = daemonDir.deletingLastPathComponent()
                .appendingPathComponent("LaunchAgents", isDirectory: true)
            return launchAgents.appendingPathComponent("FocusLockUsageTracker").path
        }
        return daemonDir.appendingPathComponent("FocusLockUsageTracker").path
    }

    /// Resolve the console (GUI-logged-in) user's uid/gid/home. Returns nil
    /// when nobody is logged in (screen-lock at login window, fast-user-
    /// switching in progress, headless boot). Callers treat nil as
    /// "cannot register" and let the enable flow roll back.
    private func consoleUser() -> (uid: uid_t, gid: gid_t, home: String)? {
        var uid: uid_t = 0
        var gid: gid_t = 0
        // Bridging CFString? → String? via `as` is documented as safe here.
        let nameCF = SCDynamicStoreCopyConsoleUser(nil, &uid, &gid)
        let name = nameCF as String?
        // Apple's "no console user" signals: nil name, name=="loginwindow",
        // uid==0 (system context), or uid==UID_MAX (older sentinel).
        guard let name = name, !name.isEmpty, name != "loginwindow" else { return nil }
        if uid == 0 || uid == uid_t.max { return nil }
        guard let pw = getpwuid(uid) else { return nil }
        let home = String(cString: pw.pointee.pw_dir)
        if home.isEmpty { return nil }
        return (uid, gid, home)
    }

    /// Materialize the plist template with the tracker and log-dir paths
    /// substituted in.
    private func renderLaunchAgentPlist(trackerPath: String, logDir: String) -> String {
        return Self.launchAgentPlistTemplate
            .replacingOccurrences(of: "__TRACKER_PATH__", with: trackerPath)
            .replacingOccurrences(of: "__LOG_DIR__",       with: logDir)
    }

    /// Spawn `launchctl` with the given args, wait for exit, and return
    /// (exitCode, mergedOutput). We capture stdout+stderr so the caller can
    /// log meaningful launchd diagnostics on failure.
    @discardableResult
    private func runLaunchctl(_ args: [String]) -> (Int32, String) {
        let proc = Process()
        proc.launchPath = "/bin/launchctl"
        proc.arguments = args
        let pipe = Pipe()
        proc.standardOutput = pipe
        proc.standardError  = pipe
        do {
            try proc.run()
        } catch {
            return (-1, "spawn failed: \(error)")
        }
        proc.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let out  = String(data: data, encoding: .utf8) ?? ""
        return (proc.terminationStatus, out.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    /// Called under `queue.sync` from handleEnable. On failure caller
    /// rolls back the DB.
    func registerLaunchAgent() -> (String?, Bool) {
        // (1) Console user.
        guard let user = consoleUser() else {
            let msg = "No GUI console user — cannot install tracker LaunchAgent"
            fputs("[usage] register: \(msg)\n", stderr)
            return (msg, false)
        }
        let uid = user.uid, gid = user.gid, home = user.home

        // (2/3) Tracker binary path — sibling of the daemon binary.
        guard let trackerPath = resolveTrackerPath() else {
            let msg = "Cannot resolve tracker binary path from daemon location"
            fputs("[usage] register: \(msg)\n", stderr)
            return (msg, false)
        }
        if !FileManager.default.isExecutableFile(atPath: trackerPath) {
            let msg = "Tracker binary missing or not executable at \(trackerPath)"
            fputs("[usage] register: \(msg)\n", stderr)
            return (msg, false)
        }

        // (4) Prepare directories, then write the substituted plist. Both
        // ~/Library/LaunchAgents and ~/Library/Logs/FocusLock may not exist
        // on a fresh install; create them and chown to the user so launchd
        // and the tracker can write.
        let launchAgentsDir = "\(home)/Library/LaunchAgents"
        let logDir          = "\(home)/Library/Logs/FocusLock"
        let plistPath       = "\(launchAgentsDir)/\(Self.launchAgentPlist)"
        do {
            try FileManager.default.createDirectory(
                atPath: launchAgentsDir, withIntermediateDirectories: true, attributes: nil)
            try FileManager.default.createDirectory(
                atPath: logDir, withIntermediateDirectories: true, attributes: nil)
        } catch {
            let msg = "Failed to create LaunchAgent/log directories: \(error)"
            fputs("[usage] register: \(msg)\n", stderr)
            return (msg, false)
        }
        // Best-effort chown of directories we may have just created.
        _ = chown(launchAgentsDir, uid, gid)
        _ = chown(logDir, uid, gid)

        let plistBody = renderLaunchAgentPlist(trackerPath: trackerPath, logDir: logDir)
        do {
            try plistBody.write(toFile: plistPath, atomically: true, encoding: .utf8)
        } catch {
            let msg = "Failed to write LaunchAgent plist at \(plistPath): \(error)"
            fputs("[usage] register: \(msg)\n", stderr)
            return (msg, false)
        }

        // (5) Chown plist to the user. launchd requires the file to be owned
        // by root or the target user; chowning removes any doubt.
        _ = chown(plistPath, uid, gid)
        _ = chmod(plistPath, 0o644)

        // (6) launchctl bootstrap gui/<uid> <plist>. If the LaunchAgent is
        // already loaded (a stale prior enable that skipped disable), the
        // second bootstrap fails with a non-zero code — bootout first, then
        // retry once.
        let domain = "gui/\(uid)"
        var (rc, out) = runLaunchctl(["bootstrap", domain, plistPath])
        if rc != 0 {
            fputs("[usage] register: initial bootstrap rc=\(rc) out=\(out) — bootout+retry\n", stderr)
            _ = runLaunchctl(["bootout", "\(domain)/\(Self.launchAgentLabel)"])
            (rc, out) = runLaunchctl(["bootstrap", domain, plistPath])
        }
        if rc != 0 {
            // Roll back: remove the plist we just wrote so a retry starts clean.
            try? FileManager.default.removeItem(atPath: plistPath)
            let msg = "launchctl bootstrap failed rc=\(rc): \(out)"
            fputs("[usage] register: \(msg)\n", stderr)
            return (msg, false)
        }

        fputs("[usage] register: LaunchAgent installed at \(plistPath) (uid=\(uid))\n", stderr)
        return (nil, true)
    }

    /// Called under `queue.sync` from handleDisable. Best-effort: we tolerate
    /// "not loaded" / "no such file" so the DB delete still runs.
    func unregisterLaunchAgent() -> (String?, Bool) {
        // (1) Console user. We tolerate a missing console user here so file
        // cleanup still happens — a screen-locked machine can still disable.
        // Without a uid we can't call launchctl bootout, but we CAN delete
        // the plist file: launchd will not re-load it on next login.
        let user = consoleUser()
        var launchctlErr: String? = nil

        if let user = user {
            let target = "gui/\(user.uid)/\(Self.launchAgentLabel)"
            let (rc, out) = runLaunchctl(["bootout", target])
            if rc != 0 {
                // launchctl exits non-zero when the service isn't loaded
                // (rc == 113 on modern macOS: "Could not find specified
                // service"). Any 'not found'-shaped output is fine.
                let lower = out.lowercased()
                let tolerated =
                    lower.contains("could not find") ||
                    lower.contains("no such process") ||
                    lower.contains("not loaded") ||
                    lower.contains("service not") ||
                    rc == 113
                if !tolerated {
                    launchctlErr = "launchctl bootout rc=\(rc): \(out)"
                    fputs("[usage] unregister: \(launchctlErr!)\n", stderr)
                }
            }
        } else {
            fputs("[usage] unregister: no console user — skipping bootout, cleaning plist only\n", stderr)
        }

        // (2) Delete the plist. If it isn't there we're already clean.
        // Walk every logged-in user home (well, at least the console user
        // when known + the current $HOME if different) — but in practice
        // one user's plist is all that ever exists, since enable only
        // installs for the console user at enable-time.
        var deleteErr: String? = nil
        if let user = user {
            let path = "\(user.home)/Library/LaunchAgents/\(Self.launchAgentPlist)"
            do {
                if FileManager.default.fileExists(atPath: path) {
                    try FileManager.default.removeItem(atPath: path)
                    fputs("[usage] unregister: removed \(path)\n", stderr)
                }
            } catch {
                deleteErr = "Failed to delete \(path): \(error)"
                fputs("[usage] unregister: \(deleteErr!)\n", stderr)
            }
        }

        // (3) Fold errors: launchctl failure wins (indicates the tracker is
        // still running); file delete failure surfaces only when launchctl
        // succeeded. Per Oscar's disable rule the DB stays in place on any
        // hard failure so the user's history is recoverable.
        if let err = launchctlErr { return (err, false) }
        if let err = deleteErr    { return (err, false) }
        return (nil, true)
    }

    /// LaunchAgent plist template — must stay byte-for-byte in sync with
    /// `daemon-mac/Resources/com.focuslock.usage-tracker.plist`. The on-disk
    /// file is the human-readable canonical version; this embedded copy is
    /// what the daemon actually ships and substitutes at register time.
    /// (Rationale: SPM resource bundling for a raw executable target adds
    /// bundle-discovery complexity when installed under FocusLock.app — the
    /// embedded string avoids that entire class of runtime path issues.)
    private static let launchAgentPlistTemplate = """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
        <key>Label</key>
        <string>com.focuslock.usage-tracker</string>

        <key>ProgramArguments</key>
        <array>
            <string>__TRACKER_PATH__</string>
        </array>

        <key>RunAtLoad</key>
        <true/>

        <key>KeepAlive</key>
        <true/>

        <key>ThrottleInterval</key>
        <integer>10</integer>

        <key>StandardOutPath</key>
        <string>__LOG_DIR__/usage-tracker.log</string>
        <key>StandardErrorPath</key>
        <string>__LOG_DIR__/usage-tracker.log</string>
    </dict>
    </plist>
    """

    // MARK: - Helpers

    private func metaOr(_ db: UsageDB, key: String, fallback: String) -> String {
        do {
            return try db.getMeta(key: key) ?? fallback
        } catch {
            return fallback
        }
    }

    /// ISO-8601 timestamp of `Date()` in UTC (Z suffix), no fractional seconds.
    private static func nowIso() -> String {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f.string(from: Date())
    }

    /// Turn an ISO-8601 timestamp from the tracker into a YYYY-MM-DD day string
    /// using the daemon's LOCAL timezone (per Oscar's spec:
    /// `Calendar.current.startOfDay`). Falls back to today if the string is
    /// malformed — dropping the sample would lose real data.
    private static func dayFromTimestamp(_ ts: String) -> String {
        let date = parseIso(ts) ?? Date()
        let sod = Calendar.current.startOfDay(for: date)
        return dayFormatter.string(from: sod)
    }

    private static func parseIso(_ s: String) -> Date? {
        let f1 = ISO8601DateFormatter()
        f1.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f1.date(from: s) { return d }
        let f2 = ISO8601DateFormatter()
        f2.formatOptions = [.withInternetDateTime]
        return f2.date(from: s)
    }

    /// YYYY-MM-DD formatter fixed to en_US_POSIX / Gregorian so device-locale
    /// changes never rewrite the day column format.
    private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()
}
