import Foundation

/// macOS counterpart to the Windows FirewallLockdownService. Same trigger
/// condition: paired + opt-in flag set + WS offline > 5 min + cached
/// block_now/schedule rules exist. When engaged, writes a pfctl anchor at
/// `focuslock-family-offline` with packet-level `block drop out quick to <ip>`
/// rules for every IP the cached blocked domains resolve to.
///
/// Why pfctl-IPs instead of pfctl-per-process: macOS pf has no clean
/// per-process binding (Network Extensions and Content Filter Providers
/// require entitlements + provisioning profiles that are out of scope for
/// an OSS Tauri app). DNS-based /etc/hosts blocking already handles
/// process-agnostic rejection at the resolver layer, but apps that ship
/// their own DNS-over-HTTPS (DoH) clients or hard-code IPs bypass it.
/// Adding a pfctl IP block complements /etc/hosts at the packet layer:
/// even a hard-coded IP can't connect.
///
/// Limitations called out in the UI:
///   • Process-target rules from block_now are *not* enforced here —
///     domain targets only. Use /etc/hosts + ProcessKillService for those.
///   • IP set is resolved at lockdown-engage time. CDNs that rotate IPs
///     faster than the 10s evaluation tick may slip past on cold starts;
///     subsequent re-evaluations pick up new IPs because we re-resolve.
///   • Requires the daemon to run as root (already the case in production —
///     it's a launchd service). Dev runs without root will log + skip.
///
/// Fail-open semantics:
///   • Every pfctl invocation has a 10s timeout.
///   • `startUp()` flushes the anchor at process start so a crashed previous
///     run can't leave half-loaded blocks active.
///   • `tearDown()` is called from `stop()` and from main.swift's signal
///     handler so a graceful shutdown always wipes the anchor.
final class FirewallLockdownService {
    /// Stable anchor name. Matched on flush so we never touch other pfctl rules.
    static let anchorName = "focuslock-family-offline"
    private static let checkIntervalSeconds: TimeInterval = 10
    private static let offlineThresholdSeconds = 300

    private let family: FamilyService
    private let enforce: FamilyEnforcementService
    private let cloud: CloudSyncService

    private var timer: DispatchSourceTimer?
    private let queue = DispatchQueue(label: "app.focuslock.firewall-lockdown")
    private var currentlyLocked = false
    /// Domain set we've already resolved + applied. Tracked so we can detect
    /// when the cache changes and re-apply.
    private var lastAppliedDomains: Set<String> = []
    /// IP set we've already loaded into the pfctl anchor. Tracked separately
    /// from `lastAppliedDomains` so an unchanged domain set whose CDN IPs
    /// have rotated still triggers a reload.
    private var lastAppliedIPs: Set<String> = []

    var isLocked: Bool {
        queue.sync { currentlyLocked }
    }

    init(family: FamilyService, enforce: FamilyEnforcementService, cloud: CloudSyncService) {
        self.family = family
        self.enforce = enforce
        self.cloud = cloud
    }

    /// Wire up the periodic evaluation. main.swift should call this once at
    /// boot, after all dependencies have been constructed.
    func start() {
        // Clean up any anchor entries left over from a previous run before we
        // start evaluating fresh — we must not honour blocks the user can't
        // currently see in the UI.
        flushAnchor()

        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1.0, repeating: Self.checkIntervalSeconds)
        t.setEventHandler { [weak self] in self?.evaluate() }
        t.resume()
        timer = t
        fputs("[firewall-lockdown] mac service started\n", stderr)
    }

    /// Cancel the timer and flush the anchor. main.swift should call this
    /// on the shutdown path (signal handler / process exit).
    func stop() {
        timer?.cancel()
        timer = nil
        flushAnchor()
        currentlyLocked = false
        lastAppliedDomains = []
        lastAppliedIPs = []
    }

    private func evaluate() {
        let cfg = family.current
        let shouldLock = cfg != nil
            && (cfg?.firewallLockdownEnabled ?? false)
            && cloud.offlineSeconds >= Self.offlineThresholdSeconds
            && enforce.hasActiveBlocks

        if shouldLock {
            applyRules()
            currentlyLocked = true
            return
        }
        if currentlyLocked {
            flushAnchor()
            currentlyLocked = false
            lastAppliedDomains = []
            lastAppliedIPs = []
        }
    }

    private func applyRules() {
        let (domains, _) = enforce.union()
        // Skip process targets: pfctl can't match by process. ProcessKillService
        // is the layer that handles those, and it stays running through offline.

        // Normalize + filter. We accept either "example.com" or "https://example.com"
        // shapes that the cloud might emit; strip protocol + path.
        let cleaned = Set(domains.compactMap { sanitize($0) })
        if cleaned.isEmpty {
            // No domain targets to block — clear the anchor so we don't leave
            // stale rules from a previous engagement.
            if !lastAppliedDomains.isEmpty {
                flushAnchor()
                lastAppliedDomains = []
                lastAppliedIPs = []
            }
            return
        }

        // Re-resolve every tick (decoupled from the domain-set early-return),
        // so CDN-backed targets that rotate IPs mid-session don't slip past.
        // The expensive pfctl reload is still gated by the IP set actually
        // changing.
        let ips = resolveAll(domains: cleaned)
        if ips.isEmpty {
            fputs("[firewall-lockdown] no IPs resolved for \(cleaned.count) domains; skipping apply\n", stderr)
            return
        }
        let ipSet = Set(ips)
        if cleaned == lastAppliedDomains && ipSet == lastAppliedIPs { return }

        guard let conf = writeAnchorFile(ips: ips) else { return }
        // Make sure pf is enabled (no-op if already running).
        _ = runPfctl(["-E"])
        if runPfctl(["-a", Self.anchorName, "-f", conf]) {
            lastAppliedDomains = cleaned
            lastAppliedIPs = ipSet
            fputs("[firewall-lockdown] applied \(ips.count) IP block(s) for \(cleaned.count) domain(s)\n", stderr)
        }
        try? FileManager.default.removeItem(atPath: conf)
    }

    private func flushAnchor() {
        // -F all flushes the specific anchor only, not other pfctl state.
        _ = runPfctl(["-a", Self.anchorName, "-F", "all"])
    }

    private func sanitize(_ raw: String) -> String? {
        var d = raw.lowercased()
        if let r = d.range(of: "://") { d = String(d[r.upperBound...]) }
        if let slash = d.firstIndex(of: "/") { d = String(d[..<slash]) }
        d = d.trimmingCharacters(in: .whitespaces)
        return d.isEmpty ? nil : d
    }

    /// Resolves each domain to all A/AAAA IPs we get back. Uses CFHost so we
    /// pick up the system resolver's configured DNS (matches what apps see).
    private func resolveAll(domains: Set<String>) -> [String] {
        var out = Set<String>()
        for d in domains {
            for ip in resolve(d) { out.insert(ip) }
        }
        return Array(out).sorted()
    }

    private func resolve(_ domain: String) -> [String] {
        var hints = addrinfo(
            ai_flags: AI_ADDRCONFIG,
            ai_family: AF_UNSPEC,
            ai_socktype: SOCK_STREAM,
            ai_protocol: 0,
            ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil
        )
        var result: UnsafeMutablePointer<addrinfo>?
        let status = getaddrinfo(domain, nil, &hints, &result)
        guard status == 0, let head = result else { return [] }
        defer { freeaddrinfo(head) }

        var ips: [String] = []
        var ptr: UnsafeMutablePointer<addrinfo>? = head
        while let info = ptr {
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if let addr = info.pointee.ai_addr {
                let rc = getnameinfo(
                    addr, info.pointee.ai_addrlen,
                    &host, socklen_t(host.count),
                    nil, 0, NI_NUMERICHOST
                )
                if rc == 0 {
                    let ip = String(cString: host)
                    if !ip.isEmpty { ips.append(ip) }
                }
            }
            ptr = info.pointee.ai_next
        }
        return ips
    }

    /// Writes the pfctl rule file to a temp path and returns its path. Caller
    /// is responsible for cleanup. Returns nil if the write fails.
    private func writeAnchorFile(ips: [String]) -> String? {
        var lines = ["# FocusLock family-offline anchor — written \(Date())"]
        for ip in ips {
            // `quick` short-circuits matching so other rules don't override us.
            lines.append("block drop out quick to \(ip)")
        }
        let body = lines.joined(separator: "\n") + "\n"
        let path = NSTemporaryDirectory() + "focuslock-family-offline.conf"
        do {
            try body.write(toFile: path, atomically: true, encoding: .utf8)
            return path
        } catch {
            fputs("[firewall-lockdown] could not write anchor file: \(error)\n", stderr)
            return nil
        }
    }

    @discardableResult
    private func runPfctl(_ args: [String]) -> Bool {
        let task = Process()
        task.launchPath = "/sbin/pfctl"
        task.arguments = args
        let outPipe = Pipe(); let errPipe = Pipe()
        task.standardOutput = outPipe
        task.standardError = errPipe
        do { try task.run() } catch {
            fputs("[firewall-lockdown] pfctl run failed: \(error)\n", stderr)
            return false
        }
        // 10-second budget per call so a hung pfctl can't stall the timer.
        let deadline = Date().addingTimeInterval(10)
        while task.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if task.isRunning {
            task.terminate()
            fputs("[firewall-lockdown] pfctl timed out args=\(args.joined(separator: " "))\n", stderr)
            return false
        }
        if task.terminationStatus != 0 {
            let errData = errPipe.fileHandleForReading.readDataToEndOfFile()
            let err = String(data: errData, encoding: .utf8) ?? ""
            fputs("[firewall-lockdown] pfctl exit=\(task.terminationStatus) args=\(args.joined(separator: " ")) err=\(err)\n", stderr)
            return false
        }
        return true
    }
}
