import Foundation
import AppKit

/// Polls running processes every 2 seconds and terminates any matching the
/// active session's blocked process list.
final class ProcessKillService {
    private let session: SessionService
    private let family: FamilyEnforcementService

    /// System processes we must never touch. Killing any of these would
    /// destabilize the OS or kick the user out of their session. The daemon
    /// also refuses to kill itself.
    private static let protectedNames: Set<String> = [
        "launchd",
        "kernel_task",
        "windowserver",
        "loginwindow",
        "finder",
        "dock",
        "systemuiserver",
        "coreaudiod",
        "focuslockdaemon",
        "focuslock",
    ]

    init(session: SessionService, family: FamilyEnforcementService) {
        self.session = session
        self.family = family
    }

    func poll() {
        // Session app-blocks are lifted during a non-strict Pomodoro break, mirroring
        // how the hosts-file path drops session domains during the break. Family rules
        // still apply — a parent-side block isn't lifted by the user's own break.
        let liftBreak = session.shouldLiftBlocksDuringBreak
        let sessionProcs = (session.active?.isActive == true && !liftBreak)
            ? (session.active?.blockedProcesses ?? [])
            : []
        let (_, familyProcs) = family.union()

        if sessionProcs.isEmpty && familyProcs.isEmpty { return }

        let unionProcs = sessionProcs + familyProcs

        // Split inputs into three buckets based on shape:
        //   - "/Applications/Foo.app/Contents/MacOS/Foo" → full path match
        //   - "com.foo.bar"                              → NSWorkspace bundle-id match
        //   - "Steam"                                    → ps-name match
        var blockedNames = Set<String>()
        var blockedPaths = Set<String>()
        var blockedBundleIds = Set<String>()
        for entry in unionProcs {
            let trimmed = entry.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { continue }
            if trimmed.hasPrefix("/") {
                blockedPaths.insert(trimmed.lowercased())
            } else if trimmed.contains(".") && !trimmed.hasSuffix(".exe") {
                // Looks like a bundle identifier (e.g. com.spotify.client).
                // .exe is a Windows-only convention so we route those through
                // the name matcher for cross-platform blocklists.
                blockedBundleIds.insert(trimmed.lowercased())
            } else {
                let name = URL(fileURLWithPath: trimmed)
                    .deletingPathExtension()
                    .lastPathComponent
                    .lowercased()
                if !name.isEmpty { blockedNames.insert(name) }
            }
        }

        // ── Bundle-ID matching via NSWorkspace ───────────────────────────
        // This is the only way to reliably target .app bundles whose process
        // name on disk is something obscure (e.g. Discord ships as "Discord"
        // but Slack ships as "Slack Helper" subprocesses). NSWorkspace does
        // not require accessibility permissions.
        if !blockedBundleIds.isEmpty {
            for app in NSWorkspace.shared.runningApplications {
                guard let bid = app.bundleIdentifier?.lowercased() else { continue }
                if blockedBundleIds.contains(bid) {
                    let pid = app.processIdentifier
                    if pid > 0 && isSafeToKill(pid: pid, name: app.localizedName?.lowercased() ?? "") {
                        kill(pid, SIGKILL)
                        session.incrementBlockAttempt()
                    }
                }
            }
        }

        if blockedNames.isEmpty && blockedPaths.isEmpty { return }

        // ── Name / path matching via ps ──────────────────────────────────
        // Adding `uid` lets us filter out root and other system service users
        // before we ever send a signal.
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-ax", "-o", "pid,uid,comm"]
        let pipe = Pipe()
        task.standardOutput = pipe
        try? task.run(); task.waitUntilExit()

        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        for line in output.components(separatedBy: "\n").dropFirst() {
            let parts = line.trimmingCharacters(in: .whitespaces)
                            .components(separatedBy: .whitespaces)
                            .filter { !$0.isEmpty }
            guard parts.count >= 3,
                  let pid = Int32(parts[0]),
                  let uid = Int32(parts[1]) else { continue }

            let comm = parts[2...].joined(separator: " ")
            let name = URL(fileURLWithPath: comm)
                .deletingPathExtension()
                .lastPathComponent
                .lowercased()

            let matched = blockedNames.contains(name) || blockedPaths.contains(comm.lowercased())
            if !matched { continue }

            // Bail before signalling if the target looks like a system process.
            // uid 0 is root; uid < 100 is reserved for built-in service users
            // on macOS (e.g. _windowserver, _coreaudiod, _hidd).
            if uid < 100 { continue }
            if !isSafeToKill(pid: pid, name: name) { continue }

            kill(pid, SIGKILL)
            session.incrementBlockAttempt()
        }
    }

    /// Last-line guard against killing protected processes regardless of how
    /// they were matched. Compared case-insensitively against the localized
    /// app name (for NSWorkspace matches) or the ps `comm` (for ps matches).
    private func isSafeToKill(pid: Int32, name: String) -> Bool {
        if pid <= 1 { return false }
        let lowered = name.lowercased()
        if Self.protectedNames.contains(lowered) { return false }
        // Also block obvious substrings — NSWorkspace may report "Finder" as
        // the localized name but the user could disguise input. Match in either
        // direction so e.g. "WindowServer_helper" or a short alias of a
        // protected name is also refused.
        for protected in Self.protectedNames {
            if lowered.contains(protected) || protected.contains(lowered) { return false }
        }
        return true
    }
}
