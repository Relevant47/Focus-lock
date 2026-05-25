using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using FocusLock.Daemon.Models;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Parental controls: a PIN gates sensitive mutations (profile/schedule edits,
/// Hardcore disable, stopping a parent-locked session). Verifying the PIN issues
/// a short-lived HMAC grace token. The UI caches that token in memory and supplies
/// it as <c>parentToken</c> on subsequent gated requests until it expires.
///
/// PINs are stored as PBKDF2-SHA256 (200k iters, 16-byte salt). ACL on the cred
/// file mirrors daemon.key (SYSTEM + Administrators full control).
/// </summary>
public sealed class ParentService
{
    private static readonly string StateDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "FocusLock");

    private static readonly string CredPath = Path.Combine(StateDir, "parent.cred");

    public static readonly TimeSpan GraceWindow = TimeSpan.FromMinutes(5);

    private const int Pbkdf2Iterations = 200_000;
    private const int SaltBytes = 16;
    private const int HashBytes = 32;

    private readonly ILogger<ParentService> _log;
    private readonly ParentAuditService _audit;
    private readonly object _lock = new();
    private readonly byte[] _tokenKey;
    private ParentCred? _cred;

    // Rate limiting for failed verify attempts.
    private int _failedAttempts;
    private DateTime _nextAttemptAllowed = DateTime.MinValue;

    public ParentService(ILogger<ParentService> log, ParentAuditService audit)
    {
        _log = log;
        _audit = audit;
        Directory.CreateDirectory(StateDir);
        _tokenKey = LoadOrCreateTokenKey();
        _cred = LoadCred();
    }

    public bool IsEnabled
    {
        get { lock (_lock) return _cred != null; }
    }

    public int GraceMinutes => (int)GraceWindow.TotalMinutes;

    public bool IsRateLimited
    {
        get { lock (_lock) return DateTime.UtcNow < _nextAttemptAllowed; }
    }

    public double? RetryAfterSeconds
    {
        get
        {
            lock (_lock)
            {
                return _nextAttemptAllowed > DateTime.UtcNow
                    ? (_nextAttemptAllowed - DateTime.UtcNow).TotalSeconds
                    : (double?)null;
            }
        }
    }

    /// <summary>
    /// Sets the parent PIN. Requires the existing PIN if one is already set.
    /// Generates a fresh recovery key on first setup; preserves the existing key hash on change.
    /// Returns the plaintext recovery key only on first setup — caller MUST display it once;
    /// it is never returned again. On change, returns null (existing key is preserved).
    /// </summary>
    public (string Error, ErrorCode? Code, bool Success, string? RecoveryKey) SetPin(string newPin, string? oldPin)
    {
        if (string.IsNullOrWhiteSpace(newPin))
            return ("PIN cannot be empty", null, false, null);

        bool isChange;
        string? newRecoveryKey = null;
        lock (_lock)
        {
            isChange = _cred != null;
            if (_cred != null)
            {
                if (string.IsNullOrEmpty(oldPin))
                    return ("Existing PIN required to change it", ErrorCode.ParentPinInvalid, false, null);
                if (!VerifyAgainstCred(oldPin, _cred))
                {
                    RecordFailedAttempt();
                    return ("Existing PIN incorrect", ErrorCode.ParentPinInvalid, false, null);
                }
            }

            var salt = RandomNumberGenerator.GetBytes(SaltBytes);
            var hash = Pbkdf2(newPin, salt);

            byte[] keySalt;
            byte[] keyHash;
            if (isChange && _cred != null && _cred.RecoveryKeySalt.Length > 0)
            {
                // Preserve existing recovery key on change — changing the PIN does NOT
                // invalidate the recovery key the user has already written down.
                keySalt = _cred.RecoveryKeySalt;
                keyHash = _cred.RecoveryKeyHash;
            }
            else
            {
                newRecoveryKey = GenerateRecoveryKey();
                keySalt = RandomNumberGenerator.GetBytes(SaltBytes);
                keyHash = Pbkdf2(NormalizeRecoveryKey(newRecoveryKey), keySalt);
            }

            _cred = new ParentCred {
                Salt = salt, Hash = hash, CreatedAt = DateTime.UtcNow,
                RecoveryKeySalt = keySalt, RecoveryKeyHash = keyHash,
            };
            SaveCred(_cred);
            ResetRateLimit();
            _log.LogInformation("Parent PIN configured");
        }
        _audit.Record(isChange ? ParentAuditEvents.PinChanged : ParentAuditEvents.PinSet);
        return (string.Empty, null, true, newRecoveryKey);
    }

    /// <summary>Regenerates the recovery key. Requires the current PIN. Invalidates any previously-displayed key.</summary>
    public (string Error, ErrorCode? Code, bool Success, string? RecoveryKey) RegenerateRecoveryKey(string pin)
    {
        lock (_lock)
        {
            if (_cred == null) return ("Parent controls are not configured", null, false, null);
            if (DateTime.UtcNow < _nextAttemptAllowed)
                return (
                    $"Too many failed attempts — wait {(int)Math.Ceiling((_nextAttemptAllowed - DateTime.UtcNow).TotalSeconds)}s",
                    ErrorCode.ParentRateLimited, false, null);
            if (!VerifyAgainstCred(pin, _cred))
            {
                RecordFailedAttempt();
                return ("Incorrect PIN", ErrorCode.ParentPinInvalid, false, null);
            }

            var newKey = GenerateRecoveryKey();
            var keySalt = RandomNumberGenerator.GetBytes(SaltBytes);
            var keyHash = Pbkdf2(NormalizeRecoveryKey(newKey), keySalt);
            _cred = new ParentCred {
                Salt = _cred.Salt, Hash = _cred.Hash, CreatedAt = _cred.CreatedAt,
                RecoveryKeySalt = keySalt, RecoveryKeyHash = keyHash,
            };
            SaveCred(_cred);
            ResetRateLimit();
            _log.LogInformation("Recovery key regenerated");
            return (string.Empty, null, true, newKey);
        }
    }

    /// <summary>Verifies a recovery key and, on success, clears the PIN. Same rate-limit ladder as PIN verify.</summary>
    public (string Error, ErrorCode? Code, bool Success) VerifyRecoveryKey(string providedKey)
    {
        if (string.IsNullOrWhiteSpace(providedKey)) return ("Recovery key required", null, false);
        string? auditEvent = null;
        (string, ErrorCode?, bool) result;

        lock (_lock)
        {
            if (_cred == null) { result = ("Parent controls are not configured", null, false); }
            else if (_cred.RecoveryKeySalt.Length == 0)
            {
                // Legacy cred with no recovery key (shouldn't happen for new setups).
                result = ("No recovery key is set for this PIN", null, false);
            }
            else if (DateTime.UtcNow < _nextAttemptAllowed)
            {
                auditEvent = ParentAuditEvents.PinVerifyRateLimit;
                result = (
                    $"Too many failed attempts — wait {(int)Math.Ceiling((_nextAttemptAllowed - DateTime.UtcNow).TotalSeconds)}s",
                    ErrorCode.ParentRateLimited, false);
            }
            else
            {
                var normalized = NormalizeRecoveryKey(providedKey);
                var derived = Pbkdf2(normalized, _cred.RecoveryKeySalt);
                if (!CryptographicOperations.FixedTimeEquals(derived, _cred.RecoveryKeyHash))
                {
                    RecordFailedAttempt();
                    auditEvent = ParentAuditEvents.PinVerifyFail;
                    result = ("Incorrect recovery key", ErrorCode.RecoveryKeyInvalid, false);
                }
                else
                {
                    // Match: clear the PIN locally.
                    _cred = null;
                    try { if (File.Exists(CredPath)) File.Delete(CredPath); } catch { /* best-effort */ }
                    ResetRateLimit();
                    _log.LogInformation("Parent PIN cleared via recovery key");
                    result = (string.Empty, null, true);
                }
            }
        }
        if (auditEvent != null) _audit.Record(auditEvent, detail: "recovery_key");
        if (result.Item3) _audit.Record(ParentAuditEvents.PinCleared, detail: "recovery_key");
        return result;
    }

    // 16-character recovery key in 4 groups of 4 from an unambiguous alphabet.
    // Display format includes hyphens; matching is whitespace/hyphen/case-insensitive.
    // 32^16 ≈ 1.2 × 10^24 combinations — completely impractical to brute-force,
    // and the rate-limit ladder closes the door further.
    private const string RecoveryAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

    private static string GenerateRecoveryKey()
    {
        var bytes = RandomNumberGenerator.GetBytes(16);
        var chars = new char[16];
        for (int i = 0; i < 16; i++) chars[i] = RecoveryAlphabet[bytes[i] % RecoveryAlphabet.Length];
        return $"{new string(chars, 0, 4)}-{new string(chars, 4, 4)}-{new string(chars, 8, 4)}-{new string(chars, 12, 4)}";
    }

    private static string NormalizeRecoveryKey(string key)
    {
        // Strip whitespace and hyphens, uppercase. Lets users paste with or without formatting.
        var buf = new System.Text.StringBuilder(20);
        foreach (var c in key)
        {
            if (c == '-' || char.IsWhiteSpace(c)) continue;
            buf.Append(char.ToUpperInvariant(c));
        }
        return buf.ToString();
    }

    /// <summary>Verifies a PIN and returns a signed grace token on success.</summary>
    public (string Error, ErrorCode? Code, string? Token, DateTime ExpiresAt) VerifyPin(string pin)
    {
        string? auditEvent = null;
        var result = ((string Error, ErrorCode? Code, string? Token, DateTime ExpiresAt))default;

        lock (_lock)
        {
            if (_cred == null)
            {
                return ("Parent controls are not configured", null, null, default);
            }

            if (DateTime.UtcNow < _nextAttemptAllowed)
            {
                auditEvent = ParentAuditEvents.PinVerifyRateLimit;
                result = (
                    $"Too many failed attempts — wait {(int)Math.Ceiling((_nextAttemptAllowed - DateTime.UtcNow).TotalSeconds)}s",
                    ErrorCode.ParentRateLimited, null, default);
            }
            else if (!VerifyAgainstCred(pin, _cred))
            {
                RecordFailedAttempt();
                auditEvent = ParentAuditEvents.PinVerifyFail;
                result = ("Incorrect PIN", ErrorCode.ParentPinInvalid, null, default);
            }
            else
            {
                ResetRateLimit();
                var expiresAt = DateTime.UtcNow + GraceWindow;
                var token = IssueToken(expiresAt);
                auditEvent = ParentAuditEvents.PinVerifySuccess;
                result = (string.Empty, null, token, expiresAt);
            }
        }
        if (auditEvent != null) _audit.Record(auditEvent);
        return result;
    }

    /// <summary>Clears the parent PIN. Requires the current PIN.</summary>
    public (string Error, ErrorCode? Code, bool Success) ClearPin(string pin)
    {
        lock (_lock)
        {
            if (_cred == null) return (string.Empty, null, true);

            if (DateTime.UtcNow < _nextAttemptAllowed)
                return (
                    $"Too many failed attempts — wait {(int)Math.Ceiling((_nextAttemptAllowed - DateTime.UtcNow).TotalSeconds)}s",
                    ErrorCode.ParentRateLimited, false);

            if (!VerifyAgainstCred(pin, _cred))
            {
                RecordFailedAttempt();
                return ("Incorrect PIN", ErrorCode.ParentPinInvalid, false);
            }

            _cred = null;
            try { if (File.Exists(CredPath)) File.Delete(CredPath); } catch { /* best-effort */ }
            ResetRateLimit();
            _log.LogInformation("Parent PIN cleared");
        }
        _audit.Record(ParentAuditEvents.PinCleared);
        return (string.Empty, null, true);
    }

    /// <summary>True when no PIN is configured, or the supplied token is valid and unexpired.</summary>
    public bool IsAuthorized(string? token)
    {
        lock (_lock)
        {
            if (_cred == null) return true;
            if (string.IsNullOrWhiteSpace(token)) return false;
            return ValidateToken(token);
        }
    }

    // ── Token issuance ──────────────────────────────────────────────────────

    private string IssueToken(DateTime expiresAt)
    {
        // Format: base64url(expiryUnixSeconds.signature)
        // signature = HMAC-SHA256(tokenKey, expiryUnixSeconds)
        var expiry = new DateTimeOffset(expiresAt, TimeSpan.Zero).ToUnixTimeSeconds();
        var expiryStr = expiry.ToString();
        using var hmac = new HMACSHA256(_tokenKey);
        var sig = hmac.ComputeHash(Encoding.UTF8.GetBytes(expiryStr));
        var payload = $"{expiryStr}.{Convert.ToHexString(sig).ToLowerInvariant()}";
        return Convert.ToBase64String(Encoding.UTF8.GetBytes(payload))
            .Replace('+', '-').Replace('/', '_').TrimEnd('=');
    }

    private bool ValidateToken(string token)
    {
        try
        {
            // Reverse base64url
            var pad = (4 - token.Length % 4) % 4;
            var b64 = token.Replace('-', '+').Replace('_', '/') + new string('=', pad);
            var raw = Encoding.UTF8.GetString(Convert.FromBase64String(b64));
            var parts = raw.Split('.', 2);
            if (parts.Length != 2) return false;
            if (!long.TryParse(parts[0], out var expiry)) return false;

            using var hmac = new HMACSHA256(_tokenKey);
            var expectedSig = hmac.ComputeHash(Encoding.UTF8.GetBytes(parts[0]));
            var expectedHex = Convert.ToHexString(expectedSig).ToLowerInvariant();
            var providedHex = parts[1];

            if (!CryptographicOperations.FixedTimeEquals(
                Encoding.UTF8.GetBytes(expectedHex),
                Encoding.UTF8.GetBytes(providedHex))) return false;

            return DateTimeOffset.FromUnixTimeSeconds(expiry) > DateTimeOffset.UtcNow;
        }
        catch
        {
            return false;
        }
    }

    // ── PIN hashing ────────────────────────────────────────────────────────

    private static byte[] Pbkdf2(string pin, byte[] salt)
    {
        using var kdf = new Rfc2898DeriveBytes(pin, salt, Pbkdf2Iterations, HashAlgorithmName.SHA256);
        return kdf.GetBytes(HashBytes);
    }

    private static bool VerifyAgainstCred(string pin, ParentCred cred)
    {
        var derived = Pbkdf2(pin, cred.Salt);
        return CryptographicOperations.FixedTimeEquals(derived, cred.Hash);
    }

    // ── Rate limiting ──────────────────────────────────────────────────────

    private void RecordFailedAttempt()
    {
        _failedAttempts++;
        var backoff = BackoffSeconds(_failedAttempts);
        _nextAttemptAllowed = DateTime.UtcNow.AddSeconds(backoff);
        _log.LogWarning("Failed parent PIN attempt #{N} — backoff {S}s", _failedAttempts, backoff);
    }

    private void ResetRateLimit()
    {
        _failedAttempts = 0;
        _nextAttemptAllowed = DateTime.MinValue;
    }

    private static int BackoffSeconds(int attempts) => attempts switch
    {
        1 => 10,
        2 => 30,
        3 => 60,
        _ => 300,
    };

    // ── Persistence ────────────────────────────────────────────────────────

    private ParentCred? LoadCred()
    {
        if (!File.Exists(CredPath)) return null;
        try
        {
            var json = File.ReadAllText(CredPath);
            var dto = JsonSerializer.Deserialize<ParentCredDto>(json);
            if (dto == null || string.IsNullOrEmpty(dto.Salt) || string.IsNullOrEmpty(dto.Hash))
                return null;
            return new ParentCred
            {
                Salt = Convert.FromBase64String(dto.Salt),
                Hash = Convert.FromBase64String(dto.Hash),
                CreatedAt = dto.CreatedAt,
                RecoveryKeySalt = string.IsNullOrEmpty(dto.RecoveryKeySalt) ? Array.Empty<byte>() : Convert.FromBase64String(dto.RecoveryKeySalt),
                RecoveryKeyHash = string.IsNullOrEmpty(dto.RecoveryKeyHash) ? Array.Empty<byte>() : Convert.FromBase64String(dto.RecoveryKeyHash),
            };
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to load parent.cred — treating as not configured");
            return null;
        }
    }

    private void SaveCred(ParentCred cred)
    {
        var dto = new ParentCredDto
        {
            Salt = Convert.ToBase64String(cred.Salt),
            Hash = Convert.ToBase64String(cred.Hash),
            CreatedAt = cred.CreatedAt,
            RecoveryKeySalt = cred.RecoveryKeySalt.Length > 0 ? Convert.ToBase64String(cred.RecoveryKeySalt) : null,
            RecoveryKeyHash = cred.RecoveryKeyHash.Length > 0 ? Convert.ToBase64String(cred.RecoveryKeyHash) : null,
        };
        File.WriteAllText(CredPath, JsonSerializer.Serialize(dto, new JsonSerializerOptions { WriteIndented = true }));
        RestrictAcl(CredPath);
    }

    private static readonly string TokenKeyPath = Path.Combine(StateDir, "parent.tokenkey");

    private byte[] LoadOrCreateTokenKey()
    {
        if (File.Exists(TokenKeyPath))
        {
            try { return File.ReadAllBytes(TokenKeyPath); }
            catch (Exception ex) { _log.LogWarning(ex, "Could not read parent.tokenkey — regenerating"); }
        }
        var key = RandomNumberGenerator.GetBytes(32);
        try
        {
            File.WriteAllBytes(TokenKeyPath, key);
            RestrictAcl(TokenKeyPath);
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not persist parent.tokenkey — tokens will be ephemeral");
        }
        return key;
    }

    private void RestrictAcl(string path)
    {
        // Mirror daemon.key: SYSTEM + Administrators full control; nothing else.
        // Don't block diagnostic runs of the daemon as an elevated user.
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
            _log.LogWarning(ex, "Could not restrict ACL on {Path}", path);
        }
    }

    private sealed class ParentCred
    {
        public byte[] Salt { get; init; } = Array.Empty<byte>();
        public byte[] Hash { get; init; } = Array.Empty<byte>();
        public DateTime CreatedAt { get; init; }
        public byte[] RecoveryKeySalt { get; init; } = Array.Empty<byte>();
        public byte[] RecoveryKeyHash { get; init; } = Array.Empty<byte>();
    }

    private sealed class ParentCredDto
    {
        public string Salt { get; set; } = string.Empty;
        public string Hash { get; set; } = string.Empty;
        public DateTime CreatedAt { get; set; }
        public string? RecoveryKeySalt { get; set; }
        public string? RecoveryKeyHash { get; set; }
    }
}

public enum ErrorCode
{
    ParentLockRequired,
    ParentPinInvalid,
    ParentRateLimited,
    RecoveryKeyInvalid,
}

public static class ErrorCodeExtensions
{
    public static string ToWireString(this ErrorCode code) => code switch
    {
        ErrorCode.ParentLockRequired => "parent_lock_required",
        ErrorCode.ParentPinInvalid   => "parent_pin_invalid",
        ErrorCode.ParentRateLimited  => "parent_rate_limited",
        ErrorCode.RecoveryKeyInvalid => "recovery_key_invalid",
        _ => "unknown",
    };
}
