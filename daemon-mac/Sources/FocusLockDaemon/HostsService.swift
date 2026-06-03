import Foundation

/// Writes blocked domains into /etc/hosts and flushes DNS.
final class HostsService {
    private static let hostsPath = "/etc/hosts"

    // ASCII-clean markers (mirrors daemon-win after the v1.1.6 fix). Legacy
    // Unicode em-dashed markers (`# ── FocusLock START ──`) still exist on
    // users' hosts files from prior versions; the strip regex below is
    // permissive enough to clean them up on first Apply with this code.
    // See issue #62.
    private static let markerStart = "# FocusLock START"
    private static let markerEnd   = "# FocusLock END"

    // Permissive regex: matches the canonical ASCII markers, legacy
    // em-dashed markers, and any text decoration around the FocusLock START /
    // FocusLock END anchors. Strips ALL occurrences in one pass — Foundation's
    // String.range(of:) returns only the first match, which meant any
    // duplicate FocusLock section (from a race, a daemon restart edge case,
    // or simply old buggy versions) would survive forever. NSRegularExpression
    // replaces all matches in `stringByReplacingMatches`.
    private static let blockSectionRegex = try! NSRegularExpression(
        pattern: #"#[^\r\n]*FocusLock[^\r\n]*START[^\r\n]*\r?\n[\s\S]*?#[^\r\n]*FocusLock[^\r\n]*END[^\r\n]*\r?\n?"#,
        options: []
    )

    private static let blankRunRegex = try! NSRegularExpression(
        pattern: #"(\r?\n){3,}"#,
        options: []
    )

    func apply(_ session: SessionState) {
        apply(blocked: session.blockedDomains, allowed: session.allowlistedDomains)
    }

    /// Direct-list entry point used by the worker when blocks come from a
    /// union of sources (e.g. local session + cloud family rules).
    func apply(blocked: [String], allowed: [String]) {
        let domains = expandDomains(blocked: blocked, allowed: allowed)
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
            Self.commonSubdomains.forEach { result.insert("\($0).\(clean)") }
        }
    }

    private func writeBlock(_ domains: [String]) {
        let original = (try? String(contentsOfFile: Self.hostsPath, encoding: .utf8)) ?? ""
        let cleaned = Self.stripFocusLockBlocks(original)

        if domains.isEmpty {
            let body = cleaned.isEmpty ? "" : cleaned + "\n"
            try? body.write(toFile: Self.hostsPath, atomically: true, encoding: .utf8)
            return
        }

        var out = cleaned
        if !out.isEmpty { out += "\n\n" }
        out += Self.markerStart + "\n"
        out += "# Managed by FocusLock - do not edit manually\n"
        for d in domains {
            out += "127.0.0.1 \(d)\n"
        }
        out += Self.markerEnd + "\n"

        try? out.write(toFile: Self.hostsPath, atomically: true, encoding: .utf8)
    }

    /// Strip every FocusLock-tagged section from the input — current ASCII
    /// markers, legacy em-dashed markers, duplicates, the lot. Pure function
    /// so tests can verify the regex without touching /etc/hosts.
    static func stripFocusLockBlocks(_ input: String) -> String {
        var cleaned = replaceAll(in: input, regex: Self.blockSectionRegex, with: "")
        cleaned = replaceAll(in: cleaned, regex: Self.blankRunRegex, with: "\n\n")
        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func replaceAll(in input: String, regex: NSRegularExpression, with template: String) -> String {
        let range = NSRange(input.startIndex..., in: input)
        return regex.stringByReplacingMatches(in: input, options: [], range: range, withTemplate: template)
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
