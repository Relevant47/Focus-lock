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
/// exe's FileDescription (product-facing name like "Google Chrome" or
/// "Microsoft Word"), falling back to ProcessName. We deliberately never
/// touch <c>MainWindowTitle</c> — window titles contain document names,
/// chat participants, and browser tab titles (which is URL PII by another
/// name). Storing them would violate the "your data stays on-device" trust
/// story every bit as much as sending them off-device.
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
            string? fileDescription = null;
            try
            {
                var mainModule = proc.MainModule;
                exePath = mainModule?.FileName;
                fileDescription = mainModule?.FileVersionInfo?.FileDescription;
            }
            catch { /* access denied */ }

            // NEVER read MainWindowTitle — it contains document names, chat
            // participants, browser tab titles. Product-facing FileDescription
            // (e.g. "Google Chrome") only, falling back to the exe base name.
            var appName = !string.IsNullOrWhiteSpace(fileDescription)
                ? fileDescription!
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
