using System.Net.Http.Json;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using FocusLock.Daemon.Models;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Manages the parent-account binding for this device: pair-code redemption,
/// persisted device token, and unpair. Token lives in ProgramData under the
/// same DACL pattern as daemon.key — readable by SYSTEM + local Administrators
/// only so a non-admin child OS account can't lift it.
///
/// Wire-side network calls go through <see cref="HttpClient"/> directly here
/// (one-shot REST); the long-lived WebSocket lives in <see cref="CloudSyncService"/>.
/// </summary>
public sealed class FamilyService
{
    private static readonly string StateDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "FocusLock");

    private static readonly string ConfigPath = Path.Combine(StateDir, "family.json");

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private readonly ILogger<FamilyService> _log;
    private readonly IntegritySigner _signer;
    private readonly ParentAuditService _audit;
    private readonly object _lock = new();
    private FamilyConfig? _config;

    public event Action<FamilyConfig?>? ConfigChanged;

    public FamilyService(ILogger<FamilyService> log, IntegritySigner signer, ParentAuditService audit)
    {
        _log = log;
        _signer = signer;
        _audit = audit;
        Directory.CreateDirectory(StateDir);
        _config = LoadConfig();
    }

    public FamilyConfig? Current
    {
        get { lock (_lock) return _config; }
    }

    public bool IsPaired
    {
        get { lock (_lock) return _config != null && !string.IsNullOrEmpty(_config.DeviceToken); }
    }

    public async Task<(string? Error, FamilyRedeemResult? Result)> RedeemAsync(
        string code, string serverUrl, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(code)) return ("Pairing code required", null);
        if (string.IsNullOrWhiteSpace(serverUrl)) return ("Server URL required", null);

        var trimmedUrl = serverUrl.TrimEnd('/');
        var trimmedCode = code.Trim();

        if (IsPaired) return ("Device is already paired — unpair first", null);

        var os      = "windows";
        var version = Environment.OSVersion.Version.ToString();
        string? host = null;
        try { host = Environment.MachineName; } catch { /* best-effort */ }

        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        HttpResponseMessage resp;
        try
        {
            resp = await http.PostAsJsonAsync(
                $"{trimmedUrl}/api/v1/family/pair/redeem",
                new { code = trimmedCode, hostname = host, os, osVersion = version },
                JsonOpts, ct).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Pair redeem network error");
            return ($"Could not reach pairing server: {ex.Message}", null);
        }

        if (!resp.IsSuccessStatusCode)
        {
            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            return ($"Pairing failed ({(int)resp.StatusCode}): {body}", null);
        }

        var payload = await resp.Content.ReadFromJsonAsync<RedeemResponse>(JsonOpts, ct).ConfigureAwait(false);
        if (payload == null || string.IsNullOrEmpty(payload.DeviceToken))
            return ("Pairing server returned an invalid response", null);

        var pairedAt = DateTime.UtcNow.ToString("O");
        var cfg = new FamilyConfig
        {
            ServerUrl   = trimmedUrl,
            AccountId   = payload.AccountId,
            DeviceId    = payload.DeviceId,
            DeviceToken = payload.DeviceToken,
            PairedAt    = pairedAt,
            Hostname    = host,
        };

        SaveConfig(cfg);
        lock (_lock) _config = cfg;
        ConfigChanged?.Invoke(cfg);
        _audit.Record(ParentAuditEvents.FamilyPaired, detail: $"deviceId={cfg.DeviceId}");
        _log.LogInformation("Family device paired (deviceId={DeviceId})", cfg.DeviceId);

        return (null, new FamilyRedeemResult
        {
            AccountId = cfg.AccountId,
            DeviceId  = cfg.DeviceId,
            PairedAt  = cfg.PairedAt,
        });
    }

    /// <summary>
    /// Local unpair — drops the token + config without notifying the server.
    /// Called from the daemon when the server signals an unpair via WS, or
    /// from the UI when the parent removes this device.
    /// </summary>
    public void ClearLocal()
    {
        string? deviceId;
        lock (_lock)
        {
            deviceId = _config?.DeviceId;
            _config = null;
            _signer.DeleteSigned(ConfigPath);
        }
        ConfigChanged?.Invoke(null);
        if (deviceId != null)
            _audit.Record(ParentAuditEvents.FamilyUnpaired, detail: $"deviceId={deviceId}");
        _log.LogInformation("Family device unpaired locally");
    }

    // ── Persistence ────────────────────────────────────────────────────────

    private FamilyConfig? LoadConfig()
    {
        var bytes = _signer.ReadVerified(ConfigPath);
        if (bytes == null)
        {
            // A legacy 2.3 unsigned config may exist if the user upgraded
            // mid-pairing — treat it as untrusted and force a re-pair. The
            // user only loses the device token, which is cheap to refresh
            // by entering a new pairing code on the parent dashboard.
            if (File.Exists(ConfigPath))
            {
                _log.LogWarning("Family config has no valid signature — re-pair required");
                _audit.Record(ParentAuditEvents.FamilyCacheTampered, detail: "family.json");
            }
            return null;
        }
        try
        {
            var cfg = JsonSerializer.Deserialize<FamilyConfig>(bytes, JsonOpts);
            if (cfg == null || string.IsNullOrEmpty(cfg.DeviceToken)) return null;
            return cfg;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Family config unreadable — treating as unpaired");
            return null;
        }
    }

    private void SaveConfig(FamilyConfig cfg)
    {
        var bytes = JsonSerializer.SerializeToUtf8Bytes(cfg,
            new JsonSerializerOptions(JsonOpts) { WriteIndented = true });
        _signer.WriteSigned(ConfigPath, bytes);
        RestrictAcl(ConfigPath);
    }

    private void RestrictAcl(string path)
    {
        try
        {
            var info = new FileSecurity();
            info.SetAccessRuleProtection(true, false);
            info.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            info.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(path).SetAccessControl(info);
        }
        catch (Exception ex)
        {
            // Same fall-through reasoning as daemon.key — when running outside
            // SYSTEM the ACL set may fail without SeSecurityPrivilege. The
            // token still survives, just with the default DACL.
            _log.LogDebug(ex, "Could not restrict ACL on {Path}", path);
        }
    }

    private sealed class RedeemResponse
    {
        public string AccountId   { get; set; } = string.Empty;
        public string DeviceId    { get; set; } = string.Empty;
        public string DeviceToken { get; set; } = string.Empty;
        public long   ExpiresInSeconds { get; set; }
    }
}
