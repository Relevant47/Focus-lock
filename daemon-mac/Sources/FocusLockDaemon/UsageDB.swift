import Foundation
import SQLite3

// SQLITE_TRANSIENT is a macro in C; Swift's SQLite3 module doesn't expose it.
// Re-cast the sentinel here so bind_text copies its string argument.
private let SQLITE_TRANSIENT_FL = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

enum UsageDBError: Error, CustomStringConvertible {
    case open(String)
    case prepare(String)
    case step(String)
    case exec(String)

    var description: String {
        switch self {
        case .open(let m):    return "open: \(m)"
        case .prepare(let m): return "prepare: \(m)"
        case .step(let m):    return "step: \(m)"
        case .exec(let m):    return "exec: \(m)"
        }
    }
}

/// Raw-SQLite3 wrapper for usage.db. Not thread-safe on its own — the caller
/// (UsageService) serializes every entrypoint on a private DispatchQueue.
final class UsageDB {
    private var db: OpaquePointer?
    let path: String

    // MARK: - Lifecycle

    init(path: String) throws {
        self.path = path
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        let rc = sqlite3_open_v2(path, &db, flags, nil)
        if rc != SQLITE_OK {
            let msg = db.map { String(cString: sqlite3_errmsg($0)) } ?? "(no handle)"
            if db != nil { sqlite3_close(db); db = nil }
            throw UsageDBError.open("sqlite3_open_v2(\(rc)): \(msg)")
        }
        // 0600 — root-only. sqlite3_open_v2 with CREATE has already created the file.
        _ = chmod(path, 0o600)
        try exec("PRAGMA journal_mode=WAL;")
        try exec("PRAGMA synchronous=NORMAL;")
    }

    func close() {
        if db != nil {
            sqlite3_close(db)
            db = nil
        }
    }

    deinit { close() }

    // MARK: - Schema / meta

    func runMigrations() throws {
        try exec(UsageMigrations.v1)
    }

    /// Seed the five documented meta rows. `schema_version` is INSERT-OR-IGNORE so
    /// a re-enable doesn't clobber an upgraded value; the rest are overwritten.
    func seedMeta(retentionDays: String, sampleRateSeconds: Int, enabledAtUTC: String) throws {
        try exec("INSERT OR IGNORE INTO usage_meta(key, value) VALUES ('schema_version', '1');")
        try setMeta(key: "retention_days", value: retentionDays)
        try setMeta(key: "sample_rate_seconds", value: String(sampleRateSeconds))
        try setMeta(key: "enabled", value: "1")
        try setMeta(key: "enabled_at_utc", value: enabledAtUTC)
    }

    func setMeta(key: String, value: String) throws {
        let sql = """
        INSERT INTO usage_meta(key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value;
        """
        try withPrepared(sql, label: "setMeta") { stmt in
            sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT_FL)
            sqlite3_bind_text(stmt, 2, value, -1, SQLITE_TRANSIENT_FL)
            let rc = sqlite3_step(stmt)
            if rc != SQLITE_DONE {
                throw UsageDBError.step("setMeta(\(key)): \(String(cString: sqlite3_errmsg(self.db)))")
            }
        }
    }

    func getMeta(key: String) throws -> String? {
        var out: String? = nil
        try withPrepared("SELECT value FROM usage_meta WHERE key = ? LIMIT 1;",
                         label: "getMeta") { stmt in
            sqlite3_bind_text(stmt, 1, key, -1, SQLITE_TRANSIENT_FL)
            if sqlite3_step(stmt) == SQLITE_ROW {
                if let cstr = sqlite3_column_text(stmt, 0) {
                    out = String(cString: cstr)
                }
            }
        }
        return out
    }

    // MARK: - Samples

    func upsertSample(day: String, userSid: String, bundleId: String, appName: String,
                      seconds: Int, inFocusSeconds: Int, outFocusSeconds: Int) throws {
        let sql = """
        INSERT INTO usage_samples(day, user_sid, bundle_id, app_name,
                                  seconds, in_focus_seconds, out_focus_seconds)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(day, user_sid, bundle_id) DO UPDATE SET
          seconds           = seconds + excluded.seconds,
          in_focus_seconds  = in_focus_seconds + excluded.in_focus_seconds,
          out_focus_seconds = out_focus_seconds + excluded.out_focus_seconds,
          app_name          = excluded.app_name;
        """
        try withPrepared(sql, label: "upsertSample") { stmt in
            sqlite3_bind_text(stmt, 1, day, -1, SQLITE_TRANSIENT_FL)
            sqlite3_bind_text(stmt, 2, userSid, -1, SQLITE_TRANSIENT_FL)
            sqlite3_bind_text(stmt, 3, bundleId, -1, SQLITE_TRANSIENT_FL)
            sqlite3_bind_text(stmt, 4, appName, -1, SQLITE_TRANSIENT_FL)
            sqlite3_bind_int64(stmt, 5, Int64(seconds))
            sqlite3_bind_int64(stmt, 6, Int64(inFocusSeconds))
            sqlite3_bind_int64(stmt, 7, Int64(outFocusSeconds))
            let rc = sqlite3_step(stmt)
            if rc != SQLITE_DONE {
                throw UsageDBError.step("upsertSample: \(String(cString: sqlite3_errmsg(self.db)))")
            }
        }
    }

    /// Aggregates over user_sid inside the range. On macOS user_sid is always '',
    /// so this is a no-op collapse; on Windows one machine can serve multiple SIDs
    /// so the SUM keeps the query portable.
    func queryRange(startDate: String, endDate: String,
                    topN: Int?, includeApps: [String]?) throws -> [UsageQueryRow] {
        var sql = """
        SELECT day, bundle_id, MAX(app_name) AS app_name,
               SUM(seconds) AS s, SUM(in_focus_seconds) AS ifs, SUM(out_focus_seconds) AS ofs
        FROM usage_samples
        WHERE day BETWEEN ? AND ?
        """
        var binds: [String] = [startDate, endDate]
        if let apps = includeApps, !apps.isEmpty {
            let placeholders = Array(repeating: "?", count: apps.count).joined(separator: ",")
            sql += " AND bundle_id IN (\(placeholders))"
            binds.append(contentsOf: apps)
        }
        sql += " GROUP BY day, bundle_id ORDER BY s DESC"
        if let n = topN, n > 0 { sql += " LIMIT \(n)" }

        var rows: [UsageQueryRow] = []
        try withPrepared(sql, label: "queryRange") { stmt in
            for (i, s) in binds.enumerated() {
                sqlite3_bind_text(stmt, Int32(i + 1), s, -1, SQLITE_TRANSIENT_FL)
            }
            while sqlite3_step(stmt) == SQLITE_ROW {
                let dayStr    = sqlite3_column_text(stmt, 0).map { String(cString: $0) } ?? ""
                let bundleStr = sqlite3_column_text(stmt, 1).map { String(cString: $0) } ?? ""
                let nameStr   = sqlite3_column_text(stmt, 2).map { String(cString: $0) } ?? ""
                rows.append(UsageQueryRow(
                    day: dayStr,
                    bundle_id: bundleStr,
                    app_name: nameStr,
                    seconds: Int(sqlite3_column_int64(stmt, 3)),
                    in_focus_seconds: Int(sqlite3_column_int64(stmt, 4)),
                    out_focus_seconds: Int(sqlite3_column_int64(stmt, 5))
                ))
            }
        }
        return rows
    }

    /// Delete rows strictly older than `day`. Returns the delete count.
    func pruneOlderThan(day: String) throws -> Int {
        try withPrepared("DELETE FROM usage_samples WHERE day < ?;",
                         label: "pruneOlderThan") { stmt in
            sqlite3_bind_text(stmt, 1, day, -1, SQLITE_TRANSIENT_FL)
            let rc = sqlite3_step(stmt)
            if rc != SQLITE_DONE {
                throw UsageDBError.step("pruneOlderThan: \(String(cString: sqlite3_errmsg(self.db)))")
            }
        }
        return Int(sqlite3_changes(db))
    }

    // MARK: - Internals

    private func withPrepared(_ sql: String, label: String,
                              _ body: (OpaquePointer?) throws -> Void) throws {
        var stmt: OpaquePointer?
        let rc = sqlite3_prepare_v2(db, sql, -1, &stmt, nil)
        if rc != SQLITE_OK {
            let msg = String(cString: sqlite3_errmsg(db))
            throw UsageDBError.prepare("\(label)(\(rc)): \(msg)")
        }
        defer { sqlite3_finalize(stmt) }
        try body(stmt)
    }

    private func exec(_ sql: String) throws {
        var errmsg: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(db, sql, nil, nil, &errmsg)
        if rc != SQLITE_OK {
            let msg = errmsg.map { String(cString: $0) } ?? "unknown"
            if let e = errmsg { sqlite3_free(e) }
            throw UsageDBError.exec("(\(rc)): \(msg)")
        }
    }
}
