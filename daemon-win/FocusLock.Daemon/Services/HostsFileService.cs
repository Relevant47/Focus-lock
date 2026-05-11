using System.Diagnostics;
using System.Text;
using FocusLock.Daemon.Models;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Writes blocked domains into the Windows hosts file and re-enforces the
/// block every 30 seconds so manual edits are overwritten.
/// </summary>
public sealed class HostsFileService
{
    private static readonly string HostsPath =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),
            @"drivers\etc\hosts");

    private const string BlockMarkerStart = "# ── FocusLock START ──";
    private const string BlockMarkerEnd   = "# ── FocusLock END ──";

    private readonly ILogger<HostsFileService> _log;

    public HostsFileService(ILogger<HostsFileService> log) => _log = log;

    public void Apply(SessionState session)
    {
        try
        {
            var domains = ExpandDomains(session.BlockedDomains, session.AllowlistedDomains);
            WriteBlock(domains);
            FlushDns();
            _log.LogDebug("Hosts file updated ({Count} domains)", domains.Count);
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to write hosts file");
        }
    }

    public void Remove()
    {
        try
        {
            WriteBlock(new List<string>());
            FlushDns();
            _log.LogInformation("Hosts file block removed");
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Failed to remove hosts file block");
        }
    }

    // ── Internals ─────────────────────────────────────────────────────────────

    // Common subdomains to expand when blocking a root domain
    private static readonly string[] CommonSubdomains =
        ["www", "m", "mobile", "app", "api", "cdn", "static", "media", "img", "assets"];

    private List<string> ExpandDomains(List<string> blocked, List<string> allowed)
    {
        var result = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var d in blocked)
        {
            ExpandPattern(d, result);
        }
        foreach (var a in allowed)
        {
            // Remove all variants of an allowlisted domain
            var clean = a.TrimStart('*', '.').ToLowerInvariant();
            result.Remove(clean);
            foreach (var sub in CommonSubdomains)
                result.Remove($"{sub}.{clean}");
        }
        return result.ToList();
    }

    private static void ExpandPattern(string pattern, HashSet<string> result)
    {
        pattern = pattern.Trim().ToLowerInvariant();

        // *.example.com — block all subdomains; also block the root
        if (pattern.StartsWith("*."))
        {
            var root = pattern[2..];
            result.Add(root);
            foreach (var sub in CommonSubdomains)
                result.Add($"{sub}.{root}");
            return;
        }

        // Plain domain: add root + common subdomains
        var clean = pattern.TrimStart('*', '.');
        result.Add(clean);
        result.Add("www." + clean);
        result.Add("m." + clean);
    }

    private void WriteBlock(List<string> domains)
    {
        // Read current file, strip our old block
        var original = File.Exists(HostsPath)
            ? File.ReadAllText(HostsPath)
            : string.Empty;

        var sb = new StringBuilder();

        // Preserve everything outside our markers
        var startIdx = original.IndexOf(BlockMarkerStart, StringComparison.Ordinal);
        var endIdx   = original.IndexOf(BlockMarkerEnd, StringComparison.Ordinal);

        if (startIdx >= 0 && endIdx > startIdx)
        {
            sb.Append(original[..startIdx].TrimEnd());
            var after = original[(endIdx + BlockMarkerEnd.Length)..].TrimStart('\r', '\n');
            if (after.Length > 0) sb.AppendLine().Append(after);
        }
        else
        {
            sb.Append(original.TrimEnd());
        }

        if (domains.Count == 0)
        {
            // Nothing to add — just clean up
            File.WriteAllText(HostsPath, sb.ToString(), Encoding.ASCII);
            return;
        }

        sb.AppendLine().AppendLine();
        sb.AppendLine(BlockMarkerStart);
        sb.AppendLine("# Managed by FocusLock — do not edit manually");
        foreach (var d in domains.OrderBy(x => x))
            sb.AppendLine($"127.0.0.1 {d}");
        sb.Append(BlockMarkerEnd);

        File.WriteAllText(HostsPath, sb.ToString(), Encoding.ASCII);
    }

    private void FlushDns()
    {
        try
        {
            using var p = Process.Start(new ProcessStartInfo
            {
                FileName = "ipconfig.exe",
                Arguments = "/flushdns",
                CreateNoWindow = true,
                UseShellExecute = false,
            });
            p?.WaitForExit(3000);
        }
        catch { /* non-fatal */ }
    }
}
