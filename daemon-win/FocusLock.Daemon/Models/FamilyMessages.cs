using System.Text.Json.Serialization;

namespace FocusLock.Daemon.Models;

// ── On-disk + IPC family state ─────────────────────────────────────────────

/// <summary>
/// Persisted under ProgramData\FocusLock\family.json. Holds the parent-account
/// binding for this child device. Empty/missing file means not paired.
/// </summary>
public sealed class FamilyConfig
{
    public string ServerUrl   { get; set; } = string.Empty;   // e.g. https://family.focus-lock.app
    public string AccountId   { get; set; } = string.Empty;
    public string DeviceId    { get; set; } = string.Empty;
    public string DeviceToken { get; set; } = string.Empty;   // long-lived (1y) JWT
    public string PairedAt    { get; set; } = string.Empty;   // ISO 8601
    public string? Hostname   { get; set; }
    /// <summary>
    /// Opt-in Windows-only "kid pulled the network cable" mitigation. When set,
    /// the daemon applies per-app Windows Firewall outbound-block rules for
    /// cached block_now process targets after the WebSocket has been offline
    /// for > 5 minutes, on top of the existing process-kill loop. Rules
    /// auto-clear on reconnect. See FirewallLockdownService.
    /// </summary>
    public bool FirewallLockdownEnabled { get; set; }
}

public sealed class FamilyStatus
{
    public bool   Paired               { get; set; }
    public bool   Connected            { get; set; }
    public string? AccountId           { get; set; }
    public string? DeviceId            { get; set; }
    public string? ServerUrl           { get; set; }
    public string? LastConnectedAt     { get; set; }
    public string? LastDisconnectedAt  { get; set; }
    public string? LastError           { get; set; }
    public int    ActiveRuleCount     { get; set; }
    /// <summary>Seconds since the last successful connection. 0 when currently connected.</summary>
    public int    OfflineSeconds      { get; set; }
    public List<FamilyRuleSummary> ActiveRules { get; set; } = new();
    public bool   FirewallLockdownEnabled { get; set; }
    public bool   FirewallLockdownActive  { get; set; }
}

public sealed class FamilyRuleSummary
{
    public string Id            { get; set; } = string.Empty;
    public string Kind          { get; set; } = string.Empty; // block_now | schedule | unblock_all | unblock_specific
    public List<string> TargetApps    { get; set; } = new();
    public List<string> TargetDomains { get; set; } = new();
    public string? ScheduleCron       { get; set; }
    public string CreatedAt           { get; set; } = string.Empty;
    public string? ExpiresAt          { get; set; }
}

// ── IPC payloads (UI → daemon) ─────────────────────────────────────────────

public sealed class FamilyRedeemPayload
{
    public string Code      { get; set; } = string.Empty;
    public string ServerUrl { get; set; } = string.Empty;
}

public sealed class FamilyRedeemResult
{
    public string AccountId { get; set; } = string.Empty;
    public string DeviceId  { get; set; } = string.Empty;
    public string PairedAt  { get; set; } = string.Empty;
}

/// <summary>
/// Snapshot of the host environment as seen by the daemon. Used by the parent
/// setup flow to gate pairing on a non-admin child account being available
/// and to surface UAC/elevation warnings.
/// </summary>
public sealed class FamilyEnvironment
{
    public string Platform        { get; set; } = string.Empty; // "windows" | "macos"
    public string OsVersion       { get; set; } = string.Empty;
    public bool   DaemonElevated  { get; set; }                 // SYSTEM (Win) or root (mac)
    public bool?  UacEnabled      { get; set; }                 // Windows only; null elsewhere
    public string? CurrentUser    { get; set; }                 // Daemon's own identity (informational)
    public List<LocalUserAccount> LocalUsers { get; set; } = new(); // Per-user admin enumeration; empty if unavailable
}

/// <summary>
/// One local account on the host. Surfaced so the parent setup flow can name
/// which accounts need to be demoted from administrator before pairing.
/// </summary>
public sealed class LocalUserAccount
{
    public string Name       { get; set; } = string.Empty;
    public bool   IsAdmin    { get; set; }
    /// <summary>True if this account is currently logged in (best-effort).</summary>
    public bool   IsCurrent  { get; set; }
    /// <summary>True for accounts the OS marks as built-in (Administrator, Guest, DefaultAccount, WDAGUtilityAccount, etc.).</summary>
    public bool   IsBuiltIn  { get; set; }
}

// ── Cloud wire shapes (snake_case in transit handled by JSON opts) ─────────

/// <summary>
/// Server-side LockRule shape (camelCase JSON over the wire).
/// </summary>
public sealed class CloudRule
{
    public string Id   { get; set; } = string.Empty;
    public string DeviceId { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;
    public List<string> TargetApps    { get; set; } = new();
    public List<string> TargetDomains { get; set; } = new();
    public string? ScheduleCron       { get; set; }
    public bool   Active              { get; set; } = true;
    public string CreatedAt           { get; set; } = string.Empty;
    public string? ExpiresAt          { get; set; }
}

/// <summary>
/// Discriminated WS message envelope from server. Only the fields we read are
/// modelled; unknown fields are ignored.
/// </summary>
public sealed class CloudMessage
{
    [JsonPropertyName("type")]   public string Type   { get; set; } = string.Empty;
    [JsonPropertyName("rule")]   public CloudRule? Rule { get; set; }
    [JsonPropertyName("ruleId")] public string? RuleId { get; set; }
    [JsonPropertyName("t")]      public long?   T      { get; set; }
}

// ── Family approval requests (Phase 3.2) ─────────────────────────────────────

public sealed class RequestUnblockPayload
{
    public string Target     { get; set; } = string.Empty;
    public string TargetKind { get; set; } = string.Empty;   // "app" | "domain"
    public int    Minutes    { get; set; }                   // 15 | 30 | 60
}

public sealed class RequestUnblockResult
{
    // Success case: requestId + expiresAt are populated, ConflictCode is null.
    public string  RequestId { get; set; } = string.Empty;
    public string  ExpiresAt { get; set; } = string.Empty;

    // v1.4.1 — Anti-spam conflict case: ConflictCode is "pending_exists" or
    // "deny_cooldown". Exactly one of PendingRequestId / RetryAfter is set
    // per code. UI branches on ConflictCode.
    public string? ConflictCode      { get; set; }
    public string? PendingRequestId  { get; set; }
    public string? RetryAfter        { get; set; }
}

public sealed class RequestStatusPayload
{
    public string RequestId { get; set; } = string.Empty;
}

public sealed class RequestStatusResult
{
    public string Status { get; set; } = string.Empty;       // pending | approved | denied | expired
    public string? ResolutionRuleExpiresAt { get; set; }
}
