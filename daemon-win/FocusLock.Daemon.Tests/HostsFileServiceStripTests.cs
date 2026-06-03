using FocusLock.Daemon.Services;
using Xunit;

namespace FocusLock.Daemon.Tests;

/// <summary>
/// Verifies the new permissive-strip behaviour in <see cref="HostsFileService.StripFocusLockBlocks"/>
/// that fixes issue #62 (113 duplicate FocusLock block sections observed on a
/// real dev box). Pure-string tests — no /etc/hosts I/O.
/// </summary>
public sealed class HostsFileServiceStripTests
{
    [Fact]
    public void StripsCanonicalAsciiBlock()
    {
        var input =
            "127.0.0.1 localhost\r\n" +
            "\r\n" +
            "# FocusLock START\r\n" +
            "# Managed by FocusLock - do not edit manually\r\n" +
            "127.0.0.1 youtube.com\r\n" +
            "# FocusLock END\r\n";

        var cleaned = HostsFileService.StripFocusLockBlocks(input);

        Assert.Equal("127.0.0.1 localhost", cleaned);
    }

    [Fact]
    public void StripsLegacyEmDashBlock()
    {
        // Pre-v1.1.6 markers used U+2500 box-drawings — survived UTF-8 reads
        // on macOS, mojibaked under Windows Encoding.ASCII. Either way the new
        // regex must clean them up.
        var input =
            "127.0.0.1 localhost\r\n" +
            "\r\n" +
            "# ── FocusLock START ──\r\n" +
            "# Managed by FocusLock — do not edit manually\r\n" +
            "127.0.0.1 youtube.com\r\n" +
            "# ── FocusLock END ──\r\n";

        var cleaned = HostsFileService.StripFocusLockBlocks(input);

        Assert.Equal("127.0.0.1 localhost", cleaned);
    }

    [Fact]
    public void StripsAsciiMojibakedMarkers()
    {
        // Encoding.ASCII writes of em-dashed markers persist on disk as
        // literal `?` characters. Reproducing the corrupted form exactly —
        // this is what the user's dev box had 113 copies of.
        var input =
            "127.0.0.1 localhost\r\n" +
            "\r\n" +
            "# ?? FocusLock START ??\r\n" +
            "# Managed by FocusLock ? do not edit manually\r\n" +
            "127.0.0.1 youtube.com\r\n" +
            "# ?? FocusLock END ??\r\n";

        var cleaned = HostsFileService.StripFocusLockBlocks(input);

        Assert.Equal("127.0.0.1 localhost", cleaned);
    }

    [Fact]
    public void StripsAllDuplicatesInOnePass()
    {
        // The bug from issue #62 — many blocks accumulated. One Apply with
        // the new code must collapse the lot.
        var middle =
            "# ?? FocusLock START ??\r\n" +
            "# Managed by FocusLock ? do not edit manually\r\n" +
            "127.0.0.1 youtube.com\r\n" +
            "# ?? FocusLock END ??\r\n";

        var input = "127.0.0.1 localhost\r\n\r\n" + string.Concat(Enumerable.Repeat(middle, 113));

        var cleaned = HostsFileService.StripFocusLockBlocks(input);

        Assert.Equal("127.0.0.1 localhost", cleaned);
        Assert.DoesNotContain("FocusLock", cleaned);
    }

    [Fact]
    public void StripsMixOfCanonicalAndLegacyMarkers()
    {
        // A box could have an old em-dash block (UTF-8 origin) plus a fresh
        // ASCII one written by the new code — the regex anchors on
        // "FocusLock START" / "FocusLock END" and matches both.
        var input =
            "127.0.0.1 localhost\r\n\r\n" +
            "# ── FocusLock START ──\r\n127.0.0.1 a.com\r\n# ── FocusLock END ──\r\n" +
            "# FocusLock START\r\n127.0.0.1 b.com\r\n# FocusLock END\r\n";

        var cleaned = HostsFileService.StripFocusLockBlocks(input);

        Assert.Equal("127.0.0.1 localhost", cleaned);
    }

    [Fact]
    public void LeavesNonFocusLockContentIntact()
    {
        var input =
            "# Some user comment\r\n" +
            "127.0.0.1 localhost\r\n" +
            "::1 localhost\r\n" +
            "192.168.1.1 my-router.local\r\n";

        var cleaned = HostsFileService.StripFocusLockBlocks(input);

        Assert.Equal(input.TrimEnd(), cleaned);
    }

    [Fact]
    public void EmptyInputReturnsEmpty()
    {
        Assert.Equal(string.Empty, HostsFileService.StripFocusLockBlocks(string.Empty));
    }

    [Fact]
    public void CollapsesExcessBlankLinesLeftByStrip()
    {
        // Removing a block could leave 3+ consecutive newlines (one before
        // the block, the block itself, one after). Verify the blank-run
        // regex collapses them to a single blank line.
        var input =
            "127.0.0.1 localhost\r\n" +
            "\r\n\r\n" +
            "# FocusLock START\r\n127.0.0.1 youtube.com\r\n# FocusLock END\r\n" +
            "\r\n\r\n" +
            "127.0.0.1 some-other-host\r\n";

        var cleaned = HostsFileService.StripFocusLockBlocks(input);

        Assert.DoesNotContain("\r\n\r\n\r\n", cleaned);
        Assert.Contains("127.0.0.1 localhost", cleaned);
        Assert.Contains("127.0.0.1 some-other-host", cleaned);
    }
}
