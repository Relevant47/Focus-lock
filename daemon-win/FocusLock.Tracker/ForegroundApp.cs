using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace FocusLock.Tracker;

/// <summary>
/// Thin P/Invoke wrapper around <c>GetForegroundWindow</c> +
/// <c>GetWindowThreadProcessId</c>. Returns the executable path of the
/// foreground window's owning process along with a human app name.
///
/// <para>
/// Per docs/usage-analytics-schema.md §1: on Windows the <c>bundle_id</c> is
/// the exe path (there is no bundle id concept). <c>app_name</c> is the
/// exe's FileDescription (product-facing name like "Google Chrome" or
/// "Microsoft Word"), falling back to ProcessName. We deliberately never
/// touch <c>MainWindowTitle</c> — window titles contain document names,
/// chat participants, and browser tab titles (which is URL PII by another
/// name). Storing them would violate the "your data stays on-device" trust
/// story every bit as much as sending them off-device.
/// </para>
///
/// <para>
/// The tracker runs as a Scheduled Task at LIMITED integrity (Standard
/// User). <c>Process.MainModule</c> requires PROCESS_QUERY_INFORMATION |
/// PROCESS_VM_READ, which a LIMITED token can't open against a High- or
/// System-integrity target — games that auto-elevate via UAC, anti-cheat
/// titles, and most launchers. To avoid silently dropping those samples
/// (issue #595) we resolve the exe path via <c>QueryFullProcessImageNameW</c>
/// opened with PROCESS_QUERY_LIMITED_INFORMATION, which a LIMITED token
/// is allowed to open against any process it isn't explicitly denied.
/// </para>
/// </summary>
internal static class ForegroundApp
{
    internal readonly record struct Sample(string ExePath, string AppName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(
        IntPtr hProcess, uint dwFlags, StringBuilder lpExeName, ref uint lpdwSize);

    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    /// <summary>
    /// Returns the currently-focused app, or null when we can't identify
    /// anything (no foreground window, process gone, access denied).
    /// </summary>
    internal static Sample? TryGet()
    {
        var hWnd = GetForegroundWindow();
        if (hWnd == IntPtr.Zero) return null;

        _ = GetWindowThreadProcessId(hWnd, out var pid);
        if (pid == 0) return null;

        // Resolve exe path with PROCESS_QUERY_LIMITED_INFORMATION so this
        // works against elevated targets from a LIMITED-token tracker.
        string? exePath = null;
        var handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle != IntPtr.Zero)
        {
            try
            {
                // 4096 safely holds a Windows extended-path exe location
                // (MAX_PATH is 260, but long-path apps can exceed it).
                var sb = new StringBuilder(4096);
                uint size = (uint)sb.Capacity;
                if (QueryFullProcessImageNameW(handle, 0, sb, ref size))
                {
                    exePath = sb.ToString();
                }
            }
            finally
            {
                CloseHandle(handle);
            }
        }

        // Prefer FileDescription read straight off disk (doesn't need any
        // process handle, so it keeps working for elevated targets). Fall
        // back to Process.ProcessName when the exe has no version resource.
        string? fileDescription = null;
        string? processName = null;
        if (!string.IsNullOrEmpty(exePath))
        {
            try
            {
                fileDescription = FileVersionInfo.GetVersionInfo(exePath).FileDescription;
            }
            catch { /* file read denied or missing version resource */ }
        }
        if (string.IsNullOrWhiteSpace(fileDescription))
        {
            try
            {
                using var proc = Process.GetProcessById((int)pid);
                processName = proc.ProcessName;
            }
            catch { /* process gone */ }
        }

        if (string.IsNullOrEmpty(exePath)) return null;   // spec: skip if either null

        // NEVER read MainWindowTitle — it contains document names, chat
        // participants, browser tab titles. Product-facing FileDescription
        // (e.g. "Google Chrome") only, falling back to the exe base name.
        var appName = !string.IsNullOrWhiteSpace(fileDescription)
            ? fileDescription!
            : processName;

        if (string.IsNullOrEmpty(appName)) return null;

        return new Sample(exePath, appName);
    }
}
