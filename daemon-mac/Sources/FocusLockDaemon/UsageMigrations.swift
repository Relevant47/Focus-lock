import Foundation

// Phase 1 skeleton — DDL only. No runtime execution.
// Phase 2 will build UsageDB.swift (raw SQLite3, per Q1) and execute this
// script on first enable. The `usage_meta` seed keys are documented in
// docs/usage-analytics-schema.md.

enum UsageMigrations {
    static let v1: String = """
    CREATE TABLE IF NOT EXISTS usage_samples (
        day TEXT NOT NULL,
        user_sid TEXT NOT NULL DEFAULT '',
        bundle_id TEXT NOT NULL,
        app_name TEXT NOT NULL,
        seconds INTEGER NOT NULL,
        in_focus_seconds INTEGER NOT NULL,
        out_focus_seconds INTEGER NOT NULL,
        PRIMARY KEY (day, user_sid, bundle_id)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_day ON usage_samples(day);

    CREATE TABLE IF NOT EXISTS usage_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
    """
}
