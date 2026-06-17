using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Wraps the same <c>daemon.key</c> that <see cref="SessionService"/> uses
/// and lets other services (currently family-controls caches) HMAC-sign and
/// verify arbitrary file bytes against it.
///
/// The key file is owned by SessionService's constructor in normal operation
/// (it runs first thanks to DI parameter-resolution order). This service can
/// safely run before or after — if the file is missing it creates one with
/// the same ACL pattern; if it exists it just reads the bytes.
/// </summary>
public sealed class IntegritySigner
{
    private static readonly string KeyPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
        "FocusLock", "daemon.key");

    private readonly byte[] _key;
    private readonly ILogger<IntegritySigner> _log;

    public IntegritySigner(ILogger<IntegritySigner> log)
    {
        _log = log;
        Directory.CreateDirectory(Path.GetDirectoryName(KeyPath)!);

        if (File.Exists(KeyPath) && new FileInfo(KeyPath).Length == 32)
        {
            _key = File.ReadAllBytes(KeyPath);
            return;
        }

        _key = RandomNumberGenerator.GetBytes(32);
        File.WriteAllBytes(KeyPath, _key);
        try { RestrictAcl(KeyPath); }
        catch (Exception ex) { _log.LogDebug(ex, "Could not restrict daemon.key ACL"); }
    }

    public string Hex(byte[] data)
    {
        using var hmac = new HMACSHA256(_key);
        return Convert.ToHexString(hmac.ComputeHash(data)).ToLowerInvariant();
    }

    public bool Verify(byte[] data, string signatureHex)
    {
        var expected = Hex(data);
        var a = Encoding.ASCII.GetBytes(expected);
        var b = Encoding.ASCII.GetBytes(signatureHex);
        if (a.Length != b.Length) return false;
        return CryptographicOperations.FixedTimeEquals(a, b);
    }

    /// <summary>
    /// Writes <paramref name="data"/> to <paramref name="path"/> and a hex HMAC
    /// to <paramref name="path"/>.sig as a sidecar. Atomic across both files
    /// is not guaranteed; readers detect partial writes via the verify step
    /// and treat them as missing.
    ///
    /// Both files are ACL-restricted to SYSTEM + Administrators unconditionally,
    /// mirroring the macOS daemon's unconditional chmod 0o600 on both files.
    /// This removes the "every caller must remember to restrict the sidecar"
    /// foot-gun: without it, a non-admin user with write access to the
    /// containing directory could overwrite both files together with a forged
    /// (data, sig) pair and defeat the integrity check.
    /// </summary>
    public void WriteSigned(string path, byte[] data)
    {
        File.WriteAllBytes(path, data);
        File.WriteAllText(path + ".sig", Hex(data));
        try { RestrictAcl(path); }
        catch (Exception ex) { _log.LogDebug(ex, "Could not restrict ACL on {Path}", path); }
        try { RestrictAcl(path + ".sig"); }
        catch (Exception ex) { _log.LogDebug(ex, "Could not restrict ACL on {Path}.sig", path); }
    }

    /// <summary>
    /// Returns the raw bytes if the .sig sidecar verifies, else null. Stale
    /// or missing sidecars are treated as "no value" — callers should fall
    /// back to their empty / unpaired state.
    /// </summary>
    public byte[]? ReadVerified(string path)
    {
        if (!File.Exists(path) || !File.Exists(path + ".sig")) return null;
        try
        {
            var data = File.ReadAllBytes(path);
            var sig  = File.ReadAllText(path + ".sig").Trim();
            return Verify(data, sig) ? data : null;
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Integrity read failed for {Path}", path);
            return null;
        }
    }

    public void DeleteSigned(string path)
    {
        try { if (File.Exists(path))         File.Delete(path); }            catch { /* ignore */ }
        try { if (File.Exists(path + ".sig")) File.Delete(path + ".sig"); } catch { /* ignore */ }
    }

    private static void RestrictAcl(string path)
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
}
