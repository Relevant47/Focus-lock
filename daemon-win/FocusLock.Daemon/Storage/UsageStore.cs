using System.Text;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging;
using FocusLock.Daemon.Models;

namespace FocusLock.Daemon.Storage;

/// <summary>
/// SQLite wrapper for the usage-analytics DB. Holds a single long-lived
/// <see cref="SqliteConnection"/>; <see cref="Close"/> disposes it and clears
/// the connection pool so the caller can then <c>File.Delete</c> the DB file
/// without a sharing violation (this is how <c>usage.disable</c> rolls back /
/// tears down).
/// </summary>
/// <remarks>
/// Not thread-safe on its own — the calling <see cref="Services.UsageService"/>
/// serialises access under a single lock. Follows the
/// <c>ProfileService</c> conventions for Sqlite command usage.
/// </remarks>
public sealed class UsageStore : IDisposable
{
    private readonly string _dbPath;
    private readonly ILogger<UsageStore> _log;
    private SqliteConnection? _conn;
    private bool _disposed;

    public UsageStore(string dbPath, ILogger<UsageStore> log)
    {
        _dbPath = dbPath;
        _log = log;
        _conn = new SqliteConnection($"Data Source={dbPath}");
        _conn.Open();
    }

    private SqliteConnection Conn =>
        _conn ?? throw new InvalidOperationException("UsageStore has been closed");

    /// <summary>Runs the v1 DDL. Idempotent (<c>CREATE ... IF NOT EXISTS</c>).</summary>
    public void RunMigrations()
    {
        using var cmd = Conn.CreateCommand();
        cmd.CommandText = UsageMigrations.V1;
        cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// Seeds the five <c>usage_meta</c> keys documented in
    /// <c>docs/usage-analytics-schema.md §1.3</c>. Uses <c>INSERT OR IGNORE</c>
    /// so a repeat call after a partial-crash adoption does not clobber
    /// values a user has since changed via <c>usage.set_settings</c>.
    /// </summary>
    public void SeedMeta(string retentionDays, int sampleRateSeconds, string enabledAtUtc)
    {
        SeedOne("schema_version", "1");
        SeedOne("retention_days", retentionDays);
        SeedOne("sample_rate_seconds", sampleRateSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
        SeedOne("enabled", "1");
        SeedOne("enabled_at_utc", enabledAtUtc);
    }

    private void SeedOne(string key, string value)
    {
        using var cmd = Conn.CreateCommand();
        cmd.CommandText = "INSERT OR IGNORE INTO usage_meta (key, value) VALUES (@k, @v)";
        cmd.Parameters.AddWithValue("@k", key);
        cmd.Parameters.AddWithValue("@v", value);
        cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// Aggregating upsert. On PK conflict the counters ADD; the human label
    /// (<c>app_name</c>) is overwritten with the latest observation so a
    /// renamed process doesn't stay under its old label forever.
    /// </summary>
    public void UpsertSample(
        string day, string userSid, string bundleId, string appName,
        int seconds, int inFocusSeconds, int outFocusSeconds)
    {
        using var cmd = Conn.CreateCommand();
        cmd.CommandText = @"
            INSERT INTO usage_samples
                (day, user_sid, bundle_id, app_name, seconds, in_focus_seconds, out_focus_seconds)
            VALUES (@day, @sid, @bid, @app, @s, @inf, @outf)
            ON CONFLICT(day, user_sid, bundle_id) DO UPDATE SET
                seconds           = seconds           + excluded.seconds,
                in_focus_seconds  = in_focus_seconds  + excluded.in_focus_seconds,
                out_focus_seconds = out_focus_seconds + excluded.out_focus_seconds,
                app_name          = excluded.app_name;";
        cmd.Parameters.AddWithValue("@day", day);
        cmd.Parameters.AddWithValue("@sid", userSid);
        cmd.Parameters.AddWithValue("@bid", bundleId);
        cmd.Parameters.AddWithValue("@app", appName);
        cmd.Parameters.AddWithValue("@s",   seconds);
        cmd.Parameters.AddWithValue("@inf", inFocusSeconds);
        cmd.Parameters.AddWithValue("@outf",outFocusSeconds);
        cmd.ExecuteNonQuery();
    }

    /// <summary>
    /// Range query. Aggregates across all <c>user_sid</c> values so a
    /// multi-user machine returns a single row per (day, bundle_id) — Phase 2
    /// UI does not segment by SID. <paramref name="topN"/> caps rows;
    /// <paramref name="includeApps"/> restricts to those bundle_ids.
    /// </summary>
    public List<UsageQueryRow> QueryRange(string startDate, string endDate, int? topN, string[]? includeApps)
    {
        var sql = new StringBuilder(@"
            SELECT day, bundle_id, MAX(app_name) AS app_name,
                   SUM(seconds)           AS seconds,
                   SUM(in_focus_seconds)  AS in_focus_seconds,
                   SUM(out_focus_seconds) AS out_focus_seconds
            FROM usage_samples
            WHERE day >= @start AND day <= @end");

        using var cmd = Conn.CreateCommand();
        cmd.Parameters.AddWithValue("@start", startDate);
        cmd.Parameters.AddWithValue("@end",   endDate);

        if (includeApps != null && includeApps.Length > 0)
        {
            var names = new List<string>(includeApps.Length);
            for (int i = 0; i < includeApps.Length; i++)
            {
                var p = "@app" + i;
                names.Add(p);
                cmd.Parameters.AddWithValue(p, includeApps[i]);
            }
            sql.Append(" AND bundle_id IN (").Append(string.Join(",", names)).Append(')');
        }

        sql.Append(" GROUP BY day, bundle_id ORDER BY seconds DESC, day ASC, bundle_id ASC");
        if (topN.HasValue && topN.Value > 0)
            sql.Append(" LIMIT ").Append(topN.Value); // int, not user string — safe

        cmd.CommandText = sql.ToString();

        var rows = new List<UsageQueryRow>();
        using var r = cmd.ExecuteReader();
        while (r.Read())
        {
            rows.Add(new UsageQueryRow
            {
                Day             = r.GetString(0),
                BundleId        = r.GetString(1),
                AppName         = r.IsDBNull(2) ? string.Empty : r.GetString(2),
                Seconds         = (int)r.GetInt64(3),
                InFocusSeconds  = (int)r.GetInt64(4),
                OutFocusSeconds = (int)r.GetInt64(5),
            });
        }
        return rows;
    }

    /// <summary>Deletes rows with <c>day &lt; @day</c>. Returns the number deleted.</summary>
    public int PruneOlderThan(string day)
    {
        using var cmd = Conn.CreateCommand();
        cmd.CommandText = "DELETE FROM usage_samples WHERE day < @day";
        cmd.Parameters.AddWithValue("@day", day);
        return cmd.ExecuteNonQuery();
    }

    /// <summary>Upsert a single meta row (INSERT OR REPLACE).</summary>
    public void SetMeta(string key, string value)
    {
        using var cmd = Conn.CreateCommand();
        cmd.CommandText = "INSERT OR REPLACE INTO usage_meta (key, value) VALUES (@k, @v)";
        cmd.Parameters.AddWithValue("@k", key);
        cmd.Parameters.AddWithValue("@v", value);
        cmd.ExecuteNonQuery();
    }

    /// <summary>Fetches a meta value, or <c>null</c> if the key is not present.</summary>
    public string? GetMeta(string key)
    {
        using var cmd = Conn.CreateCommand();
        cmd.CommandText = "SELECT value FROM usage_meta WHERE key = @k";
        cmd.Parameters.AddWithValue("@k", key);
        var raw = cmd.ExecuteScalar();
        return raw == null || raw is DBNull ? null : raw.ToString();
    }

    /// <summary>
    /// Closes the underlying connection AND clears the ADO.NET pool so the
    /// file lock is released. Caller may then <c>File.Delete</c> the DB path.
    /// Safe to call more than once.
    /// </summary>
    public void Close()
    {
        if (_conn == null) return;
        try { _conn.Close(); } catch (Exception ex) { _log.LogDebug(ex, "UsageStore connection close raised"); }
        try { _conn.Dispose(); } catch { }
        _conn = null;
        // Microsoft.Data.Sqlite pools connections by connection-string. Even
        // after Close(), a pooled sqlite3* may still hold the file handle,
        // which blocks File.Delete on Windows. ClearAllPools frees them.
        try { SqliteConnection.ClearAllPools(); } catch { }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        Close();
    }
}
