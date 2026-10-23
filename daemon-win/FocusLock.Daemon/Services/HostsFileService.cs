using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
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

    // ASCII-only markers. Pre-v1.1.6 these had Unicode em-dashes (──) but the
    // file is written with `Encoding.ASCII`, which silently turns them into `?`
    // on disk. The next Apply's `IndexOf(...)` searched for the (still-Unicode)
    // in-memory marker, never matched the corrupted on-disk form, and appended
    // a fresh block instead of replacing — one new block per 30s re-enforce
    // tick. Issue #62 (113 duplicates observed on a real dev box).
    private const string BlockMarkerStart = "# FocusLock START";
    private const string BlockMarkerEnd   = "# FocusLock END";

    // Permissive regex: matches the canonical ASCII markers AND the legacy
    // em-dashed AND ASCII-corrupted (`# ?? FocusLock START ??`) forms, so
    // boxes that accumulated duplicates pre-v1.1.6 self-heal on the first
    // Apply with this code. Strips ALL occurrences in one pass — also fixes
    // the first-match-only limitation the Swift side had via `range(of:)`.
    private static readonly Regex BlockSectionRegex = new(
        @"#[^\r\n]*FocusLock[^\r\n]*START[^\r\n]*\r?\n.*?#[^\r\n]*FocusLock[^\r\n]*END[^\r\n]*\r?\n?",
        RegexOptions.Singleline | RegexOptions.Compiled);

    private static readonly Regex BlankRunRegex = new(
        @"(\r?\n){3,}", RegexOptions.Compiled);

    private readonly ILogger<HostsFileService> _log;

    public HostsFileService(ILogger<HostsFileService> log) => _log = log;

    public void Apply(SessionState session) =>
        Apply(session.BlockedDomains, session.AllowlistedDomains);

    /// <summary>
    /// Direct-list entry point used by the worker when blocks come from a
    /// union of sources (e.g. local session + cloud family rules).
    /// </summary>
    public void Apply(IReadOnlyCollection<string> blocked, IReadOnlyCollection<string> allowed)
    {
        try
        {
            var domains = ExpandDomains(blocked, allowed);
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

    private List<string> ExpandDomains(IReadOnlyCollection<string> blocked, IReadOnlyCollection<string> allowed)
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
        foreach (var sub in CommonSubdomains)
            result.Add($"{sub}.{clean}");
    }

    private void WriteBlock(List<string> domains)
    {
        var original = File.Exists(HostsPath)
            ? File.ReadAllText(HostsPath)
            : string.Empty;

        var cleaned = StripFocusLockBlocks(original);

        if (domains.Count == 0)
        {
            WriteAtomic(HostsPath, cleaned.Length > 0 ? cleaned + "\r\n" : string.Empty);
            return;
        }

        var sb = new StringBuilder();
        if (cleaned.Length > 0)
        {
            sb.Append(cleaned);
            sb.AppendLine();
            sb.AppendLine();
        }
        sb.AppendLine(BlockMarkerStart);
        sb.AppendLine("# Managed by FocusLock - do not edit manually");
        foreach (var d in domains.OrderBy(x => x))
            sb.AppendLine($"127.0.0.1 {d}");
        sb.AppendLine(BlockMarkerEnd);

        WriteAtomic(HostsPath, sb.ToString());
    }

    // Write to a sibling temp file, then rename over the target. `File.Move`
    // with `overwrite: true` is an atomic rename on NTFS on the same volume,
    // so a crash / power loss before the rename leaves the original file
    // intact — the failure mode `File.WriteAllText` had was truncating the
    // hosts file to zero bytes and leaving it that way. Mirrors macOS's
    // `write(atomically: true)` in HostsService.swift.
    private static void WriteAtomic(string path, string contents)
    {
        var tmp = path + ".focuslock.tmp";
        File.WriteAllText(tmp, contents, Encoding.ASCII);
        File.Move(tmp, path, overwrite: true);
    }

    /// <summary>
    /// Strip every FocusLock-tagged section from the input — current ASCII
    /// markers, legacy em-dashed markers, ASCII-mojibaked leftovers,
    /// duplicates, the lot. Pure function; exposed internal so unit tests can
    /// verify the regex without going through the file system.
    /// </summary>
    internal static string StripFocusLockBlocks(string input)
    {
        var cleaned = BlockSectionRegex.Replace(input, string.Empty);
        cleaned = BlankRunRegex.Replace(cleaned, "\r\n\r\n");
        return cleaned.TrimEnd();
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
