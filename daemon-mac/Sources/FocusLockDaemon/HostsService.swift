import Foundation

/// Writes blocked domains into /etc/hosts and flushes DNS.
final class HostsService {
    private static let hostsPath = "/etc/hosts"
    private static let markerStart = "# ── FocusLock START ──"
    private static let markerEnd   = "# ── FocusLock END ──"

    func apply(_ session: SessionState) {
        let domains = expandDomains(blocked: session.blockedDomains, allowed: session.allowlistedDomains)
        writeBlock(domains)
        flushDns()
    }

    func remove() {
        writeBlock([])
        flushDns()
    }

    // ── Private ───────────────────────────────────────────────────────────────

    private static let commonSubdomains = ["www","m","mobile","app","api","cdn","static","media","img","assets"]

    private func expandDomains(blocked: [String], allowed: [String]) -> [String] {
        var result = Set<String>()
        for d in blocked { expandPattern(d, into: &result) }
        for a in allowed {
            let clean = a.trimmingCharacters(in: CharacterSet(charactersIn: "*.")).lowercased()
            result.remove(clean)
            Self.commonSubdomains.forEach { result.remove("\($0).\(clean)") }
        }
        return result.sorted()
    }

    private func expandPattern(_ pattern: String, into result: inout Set<String>) {
        let p = pattern.trimmingCharacters(in: .whitespaces).lowercased()
        if p.hasPrefix("*.") {
            let root = String(p.dropFirst(2))
            result.insert(root)
            Self.commonSubdomains.forEach { result.insert("\($0).\(root)") }
        } else {
            let clean = p.trimmingCharacters(in: CharacterSet(charactersIn: "*."))
            result.insert(clean)
            result.insert("www.\(clean)")
            result.insert("m.\(clean)")
        }
    }

    private func writeBlock(_ domains: [String]) {
        let original = (try? String(contentsOfFile: Self.hostsPath, encoding: .utf8)) ?? ""
        var out = ""

        // Strip existing FocusLock block
        if let startRange = original.range(of: Self.markerStart),
           let endRange   = original.range(of: Self.markerEnd) {
            out = String(original[original.startIndex..<startRange.lowerBound])
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let afterEnd = original[endRange.upperBound...]
            let afterTrimmed = afterEnd.drop(while: { $0.isNewline })
            if !afterTrimmed.isEmpty {
                out += "\n" + afterTrimmed
            }
        } else {
            out = original.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        if domains.isEmpty {
            try? (out + "\n").write(toFile: Self.hostsPath, atomically: true, encoding: .utf8)
            return
        }

        out += "\n\n"
        out += Self.markerStart + "\n"
        out += "# Managed by FocusLock — do not edit manually\n"
        for d in domains {
            out += "127.0.0.1 \(d)\n"
        }
        out += Self.markerEnd

        try? out.write(toFile: Self.hostsPath, atomically: true, encoding: .utf8)
    }

    private func flushDns() {
        // Flush macOS DNS cache
        run("/usr/bin/dscacheutil", ["-flushcache"])
        run("/bin/kill", ["-HUP", mDNSResponderPid()])
    }

    private func mDNSResponderPid() -> String {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/ps")
        task.arguments = ["-ax", "-o", "pid,comm"]
        let pipe = Pipe()
        task.standardOutput = pipe
        try? task.run(); task.waitUntilExit()
        let out = String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        for line in out.components(separatedBy: "\n") {
            if line.contains("mDNSResponder") && !line.contains("Helper") {
                return line.trimmingCharacters(in: .whitespaces).components(separatedBy: " ").first ?? "1"
            }
        }
        return "1"
    }

    @discardableResult
    private func run(_ path: String, _ args: [String]) -> Int32 {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: path)
        task.arguments = args
        task.standardOutput = FileHandle.nullDevice
        task.standardError  = FileHandle.nullDevice
        try? task.run(); task.waitUntilExit()
        return task.terminationStatus
    }
}
