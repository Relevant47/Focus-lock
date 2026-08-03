using System.Diagnostics;
using System.Runtime.InteropServices;

namespace FocusLock.Tracker;

/// <summary>
/// Thin P/Invoke wrapper around <c>GetForegroundWindow</c> +
/// <c>GetWindowThreadProcessId</c>. Returns the executable path of the
/// foreground window's owning process along with a human app name.
///
/// <para>
/// Per docs/usage-analytics-schema.md §1: on Windows the <c>bundle_id</c> is
/// the exe path (there is no bundle id concept). <c>app_name</c> is the
/// window title when available, else the process name — same convention as
/// the mac tracker (localized name).
/// </para>
///
/// <para>
/// <c>Process.GetProcessById(...).MainModule</c> throws <see cref="Win32Exception"/>
/// when we don't have PROCESS_QUERY_INFORMATION | PROCESS_VM_READ on the
/// target (system processes, elevated apps when tracker runs at LIMITED
/// integrity). Caller treats a null return as "nothing to sample this tick".
/// </para>
/// </summary>
internal static class ForegroundApp
{
    internal readonly record struct Sample(string ExePath, string AppName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

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

        Process? proc = null;
        try
        {
            proc = Process.GetProcessById((int)pid);
        }
        catch { return null; }

        try
        {
            // MainModule.FileName requires PROCESS_QUERY_INFORMATION | PROCESS_VM_READ.
            // For processes we can't inspect (kernel/protected), fall through
            // and use ProcessName below to at least record *something*.
            string? exePath = null;
            try { exePath = proc.MainModule?.FileName; } catch { /* access denied */ }

            var appName = !string.IsNullOrEmpty(proc.MainWindowTitle)
                ? proc.MainWindowTitle
                : proc.ProcessName;

            if (string.IsNullOrEmpty(exePath)) return null;   // spec: skip if either null
            if (string.IsNullOrEmpty(appName)) return null;

            return new Sample(exePath, appName);
        }
        finally
        {
            proc.Dispose();
        }
    }
}
