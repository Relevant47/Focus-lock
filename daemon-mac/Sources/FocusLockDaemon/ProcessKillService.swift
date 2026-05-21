import Foundation

/// Polls running processes every 2 seconds and terminates any matching the
/// active session's blocked process list.
final class ProcessKillService {
    private let session: SessionService
    private let family: FamilyEnforcementService

    init(session: SessionService, family: FamilyEnforcementService) {
        self.session = session
        self.family = family
    }

    func poll() {
        let sessionProcs = (session.active?.isActive == true)
            ? (session.active?.blockedProcesses ?? [])
            : []
        let (_, familyProcs) = family.union()

        if sessionProcs.isEmpty && familyProcs.isEmpty { return }

        let unionProcs = sessionProcs + familyProcs

        let blockedNames = Set(
            unionProcs.map {
                URL(fileURLWithPath: $0).deletingPathExtension().lastPathComponent.lowercased()
            }
        )
        let blockedPaths = Set(
            unionProcs
                .filter { $0.contains("/") }
                .map { $0.lowercased() }
        )

        // Use `ps` to get running process list (name + path)
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-ax", "-o", "pid,comm"]
        let pipe = Pipe()
        task.standardOutput = pipe
        try? task.run(); task.waitUntilExit()

        let output = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        for line in output.components(separatedBy: "\n").dropFirst() {
            let parts = line.trimmingCharacters(in: .whitespaces)
                            .components(separatedBy: .whitespaces)
            guard parts.count >= 2,
                  let pid = Int32(parts[0]) else { continue }

            let comm = parts[1]
            let name = URL(fileURLWithPath: comm).deletingPathExtension().lastPathComponent.lowercased()

            if blockedNames.contains(name) || blockedPaths.contains(comm.lowercased()) {
                kill(pid, SIGKILL)
                session.incrementBlockAttempt()
            }
        }
    }
}
