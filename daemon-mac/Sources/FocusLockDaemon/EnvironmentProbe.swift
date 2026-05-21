import Foundation

/// Reads a small snapshot of "is this host hardened?" facts for the parent
/// setup flow. Includes per-user admin enumeration so the parent UI can name
/// which accounts need to be demoted before pairing.
final class EnvironmentProbe {
    func probe() -> FamilyEnvironment {
        let user: String?
        var buf = [CChar](repeating: 0, count: 256)
        if getlogin_r(&buf, buf.count) == 0 {
            user = String(cString: buf)
        } else {
            user = nil
        }
        return FamilyEnvironment(
            platform: "macos",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            daemonElevated: getuid() == 0,
            uacEnabled: nil,  // No direct macOS analogue
            currentUser: user,
            localUsers: enumerateLocalUsers(currentUser: user)
        )
    }

    /// Walks `dscl . list /Users` for human accounts (UniqueID >= 500) and
    /// cross-references the admin group's GroupMembership. System accounts
    /// (UID < 500, names prefixed with _) are surfaced too but flagged as
    /// built-in so the UI can de-emphasise them.
    private func enumerateLocalUsers(currentUser: String?) -> [LocalUserAccount] {
        let adminMembers = runDscl(args: ["-read", "/Groups/admin", "GroupMembership"])
            .flatMap { parseGroupMembership($0) } ?? []
        let adminSet = Set(adminMembers)

        guard let listing = runDscl(args: ["-list", "/Users", "UniqueID"]) else { return [] }

        var out: [LocalUserAccount] = []
        for line in listing.components(separatedBy: "\n") {
            let parts = line.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
            guard parts.count >= 2, let uid = Int(parts.last!) else { continue }
            let name = parts[0]
            // Skip the "nobody" pseudo-user explicitly; mark others with UID<500
            // as built-in but still include them so the UI can show the full
            // picture if a user wants to audit.
            if name == "nobody" { continue }
            out.append(LocalUserAccount(
                name: name,
                isAdmin: adminSet.contains(name),
                isCurrent: currentUser != nil && currentUser! == name,
                isBuiltIn: uid < 500 || name.hasPrefix("_")
            ))
        }
        return out
    }

    private func parseGroupMembership(_ raw: String) -> [String] {
        // Output is `GroupMembership: alice bob carol`. Strip the prefix.
        guard let colon = raw.firstIndex(of: ":") else { return [] }
        let after = raw[raw.index(after: colon)...]
        return after.split(separator: " ", omittingEmptySubsequences: true).map(String.init)
    }

    private func runDscl(args: [String]) -> String? {
        let task = Process()
        task.launchPath = "/usr/bin/dscl"
        task.arguments = ["."] + args
        let pipe = Pipe()
        task.standardOutput = pipe
        task.standardError = Pipe()
        do { try task.run() } catch {
            fputs("[env-probe] dscl run failed: \(error)\n", stderr)
            return nil
        }
        task.waitUntilExit()
        if task.terminationStatus != 0 { return nil }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        return String(data: data, encoding: .utf8)
    }
}
