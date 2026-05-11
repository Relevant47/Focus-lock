using System.Data.SQLite;
using System.Text.Json;
using FocusLock.Daemon.Models;

namespace FocusLock.Daemon.Services;

/// <summary>
/// SQLite-backed persistence for focus profiles and scheduled sessions.
/// </summary>
public sealed class ProfileService
{
    private static readonly string DbPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "FocusLock", "profiles.db");

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private readonly string _connStr;
    private readonly ILogger<ProfileService> _log;

    public ProfileService(ILogger<ProfileService> log)
    {
        _log = log;
        Directory.CreateDirectory(Path.GetDirectoryName(DbPath)!);
        _connStr = $"Data Source={DbPath};Version=3;";
        Initialize();
    }

    private void Initialize()
    {
        using var conn = Open();
        Exec(conn, """
            CREATE TABLE IF NOT EXISTS profiles (
                id   TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS schedules (
                id   TEXT PRIMARY KEY,
                data TEXT NOT NULL
            );
            """);
    }

    // ── Profiles ──────────────────────────────────────────────────────────────

    public IReadOnlyList<FocusProfile> GetAll()
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT data FROM profiles";
        using var reader = cmd.ExecuteReader();
        var results = new List<FocusProfile>();
        while (reader.Read())
        {
            var p = JsonSerializer.Deserialize<FocusProfile>(reader.GetString(0), JsonOpts);
            if (p != null) results.Add(p);
        }
        return results;
    }

    public void SaveProfile(FocusProfile profile)
    {
        profile.UpdatedAt = DateTime.UtcNow;
        Upsert("profiles", profile.Id, JsonSerializer.Serialize(profile, JsonOpts));
    }

    public void DeleteProfile(string id)
    {
        Delete("profiles", id);
    }

    // ── Schedules ─────────────────────────────────────────────────────────────

    public IReadOnlyList<ScheduledSession> GetSchedules()
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = "SELECT data FROM schedules";
        using var reader = cmd.ExecuteReader();
        var results = new List<ScheduledSession>();
        while (reader.Read())
        {
            var s = JsonSerializer.Deserialize<ScheduledSession>(reader.GetString(0), JsonOpts);
            if (s != null) results.Add(s);
        }
        return results;
    }

    public void SaveSchedule(ScheduledSession schedule)
    {
        Upsert("schedules", schedule.Id, JsonSerializer.Serialize(schedule, JsonOpts));
    }

    public void DeleteSchedule(string id)
    {
        Delete("schedules", id);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void Upsert(string table, string id, string json)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"INSERT OR REPLACE INTO {table} (id, data) VALUES (@id, @data)";
        cmd.Parameters.AddWithValue("@id", id);
        cmd.Parameters.AddWithValue("@data", json);
        cmd.ExecuteNonQuery();
    }

    private void Delete(string table, string id)
    {
        using var conn = Open();
        using var cmd = conn.CreateCommand();
        cmd.CommandText = $"DELETE FROM {table} WHERE id = @id";
        cmd.Parameters.AddWithValue("@id", id);
        cmd.ExecuteNonQuery();
    }

    private static void Exec(SQLiteConnection conn, string sql)
    {
        using var cmd = conn.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    private SQLiteConnection Open()
    {
        var conn = new SQLiteConnection(_connStr);
        conn.Open();
        return conn;
    }
}
