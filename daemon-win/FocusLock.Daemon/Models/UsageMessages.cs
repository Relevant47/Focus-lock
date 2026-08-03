using System.Text.Json.Serialization;

namespace FocusLock.Daemon.Models;

// ── Usage analytics (Phase 1) ────────────────────────────────────────────────
//
// Mirrors shared/protocol.ts. Device-local, opt-in. NOT parent-gated. NOT
// synced to the family server.
//
// Naming note: field names use snake_case via [JsonPropertyName] to match the
// shared/protocol.ts contract. This differs from the rest of the C# models,
// which rely on the default camelCase policy — because those TS interfaces
// already use camelCase. The usage-analytics contract chose snake_case so the
// JSON reads naturally next to the SQLite column names.

public sealed class UsageReportSamplePayload
{
    [JsonPropertyName("bundle_id")] public string BundleId { get; set; } = string.Empty;
    [JsonPropertyName("app_name")]  public string AppName  { get; set; } = string.Empty;
    [JsonPropertyName("seconds")]   public int    Seconds  { get; set; }
    [JsonPropertyName("in_focus")]  public bool   InFocus  { get; set; }
    [JsonPropertyName("timestamp")] public string Timestamp { get; set; } = string.Empty;
}

public sealed class UsageQueryPayload
{
    [JsonPropertyName("start_date")]     public string        StartDate     { get; set; } = string.Empty;
    [JsonPropertyName("end_date")]       public string        EndDate       { get; set; } = string.Empty;
    [JsonPropertyName("top_n")]          public int?          TopN          { get; set; }
    [JsonPropertyName("include_apps")]   public List<string>? IncludeApps   { get; set; }
    [JsonPropertyName("split_by_focus")] public bool          SplitByFocus  { get; set; }
}

public sealed class UsageQueryRow
{
    [JsonPropertyName("day")]              public string Day             { get; set; } = string.Empty;
    [JsonPropertyName("bundle_id")]        public string BundleId        { get; set; } = string.Empty;
    [JsonPropertyName("app_name")]         public string AppName         { get; set; } = string.Empty;
    [JsonPropertyName("seconds")]          public int    Seconds         { get; set; }
    [JsonPropertyName("in_focus_seconds")] public int    InFocusSeconds  { get; set; }
    [JsonPropertyName("out_focus_seconds")]public int    OutFocusSeconds { get; set; }
}

public sealed class UsageQueryResult
{
    [JsonPropertyName("rows")]                     public List<UsageQueryRow> Rows                  { get; set; } = new();
    [JsonPropertyName("other_apps_total_seconds")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? OtherAppsTotalSeconds { get; set; }
}

public sealed class UsageSetSettingsPayload
{
    /// <summary>
    /// One of "30", "90", "180", "365", or "forever". Encoded as string so the
    /// 'forever' sentinel round-trips cleanly through JSON.
    /// </summary>
    [JsonPropertyName("retention_days")]      public string? RetentionDays     { get; set; }
    [JsonPropertyName("sample_rate_seconds")] public int?    SampleRateSeconds { get; set; }
}

public sealed class UsageGetSettingsResult
{
    [JsonPropertyName("enabled")]             public bool    Enabled           { get; set; }
    [JsonPropertyName("retention_days")]      public string  RetentionDays     { get; set; } = "90";
    [JsonPropertyName("sample_rate_seconds")] public int     SampleRateSeconds { get; set; } = 5;
    [JsonPropertyName("enabled_at_utc")]      public string? EnabledAtUtc      { get; set; }
}
