import Foundation

/// Manages the parent-account binding for this device. Persists the device
/// token under /Library/Application Support/FocusLock/family.json with mode
/// 0600 so a non-admin user account can't lift it.
///
/// REST-only — the long-lived WebSocket lives in CloudSyncService.
final class FamilyService {
    private static let stateDir = "/Library/Application Support/FocusLock"
    private static let configPath = "/Library/Application Support/FocusLock/family.json"

    private let lock = NSLock()
    private var config: FamilyConfig?
    private let signer: IntegritySigner
    private let audit: ParentAuditService

    /// Listeners notified on pair/unpair. CloudSyncService subscribes to drive
    /// reconnects without polling the service.
    private var listeners: [(FamilyConfig?) -> Void] = []

    private let encoder: JSONEncoder = {
        let e = JSONEncoder()
        e.outputFormatting = [.prettyPrinted, .sortedKeys]
        return e
    }()
    private let decoder = JSONDecoder()

    init(signer: IntegritySigner, audit: ParentAuditService) {
        self.signer = signer
        self.audit = audit
        try? FileManager.default.createDirectory(
            atPath: Self.stateDir, withIntermediateDirectories: true,
            attributes: [.posixPermissions: NSNumber(value: 0o700)])
        self.config = loadConfig()
    }

    var current: FamilyConfig? {
        lock.lock(); defer { lock.unlock() }
        return config
    }

    var isPaired: Bool {
        lock.lock(); defer { lock.unlock() }
        return config != nil && !(config?.deviceToken.isEmpty ?? true)
    }

    func onConfigChanged(_ cb: @escaping (FamilyConfig?) -> Void) {
        lock.lock(); listeners.append(cb); lock.unlock()
    }

    private func notify(_ cfg: FamilyConfig?) {
        lock.lock()
        let listenersCopy = listeners
        lock.unlock()
        for l in listenersCopy { l(cfg) }
    }

    /// Synchronous wrapper around the redeem POST — IpcSocketService dispatches
    /// each client on its own thread, so blocking here is fine and keeps the
    /// IPC reply on the same connection.
    func redeem(code: String, serverUrl: String) -> (error: String?, result: FamilyRedeemResult?) {
        let trimmedUrl = serverUrl.trimmingCharacters(in: CharacterSet(charactersIn: " /"))
        let trimmedCode = code.trimmingCharacters(in: .whitespaces)
        if trimmedCode.isEmpty { return ("Pairing code required", nil) }
        if trimmedUrl.isEmpty  { return ("Server URL required",  nil) }
        if isPaired { return ("Device is already paired — unpair first", nil) }

        guard let url = URL(string: "\(trimmedUrl)/api/v1/family/pair/redeem") else {
            return ("Invalid server URL", nil)
        }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("FocusLock-Daemon/1.2.1", forHTTPHeaderField: "User-Agent")

        let host = Host.current().localizedName ?? "macOS"
        let body: [String: Any] = [
            "code":      trimmedCode,
            "hostname":  host,
            "os":        "macos",
            "osVersion": ProcessInfo.processInfo.operatingSystemVersionString,
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        let sem = DispatchSemaphore(value: 0)
        var resultErr: String?
        var resultPayload: RedeemResponse?
        URLSession.shared.dataTask(with: req) { data, resp, err in
            defer { sem.signal() }
            if let err = err {
                resultErr = "Could not reach pairing server: \(err.localizedDescription)"
                return
            }
            guard let http = resp as? HTTPURLResponse else {
                resultErr = "No HTTP response"
                return
            }
            guard (200..<300).contains(http.statusCode) else {
                let bodyStr = (data.flatMap { String(data: $0, encoding: .utf8) }) ?? ""
                resultErr = "Pairing failed (\(http.statusCode)): \(bodyStr)"
                return
            }
            guard let data = data else {
                resultErr = "Empty pairing response"
                return
            }
            do {
                let dec = JSONDecoder()
                resultPayload = try dec.decode(RedeemResponse.self, from: data)
            } catch {
                resultErr = "Invalid pairing response: \(error.localizedDescription)"
            }
        }.resume()
        sem.wait()

        if let resultErr = resultErr { return (resultErr, nil) }
        guard let payload = resultPayload, !payload.deviceToken.isEmpty else {
            return ("Pairing server returned an invalid response", nil)
        }

        let pairedAt = ISO8601DateFormatter().string(from: Date())
        let cfg = FamilyConfig(
            serverUrl: trimmedUrl,
            accountId: payload.accountId,
            deviceId: payload.deviceId,
            deviceToken: payload.deviceToken,
            pairedAt: pairedAt,
            hostname: host
        )
        save(cfg)
        lock.lock(); self.config = cfg; lock.unlock()
        notify(cfg)
        audit.record(ParentAuditEvents.familyPaired, detail: "deviceId=\(cfg.deviceId)")
        fputs("[family] paired deviceId=\(cfg.deviceId)\n", stderr)

        return (nil, FamilyRedeemResult(
            accountId: cfg.accountId, deviceId: cfg.deviceId, pairedAt: cfg.pairedAt))
    }

    /// Toggle the opt-in firewall-lockdown flag on the persisted config.
    /// Returns false if the device isn't paired. This method only stores the
    /// flag — actual pfctl enforcement is driven by `FirewallLockdownService`,
    /// which reads `cfg.firewallLockdownEnabled` on its own evaluation tick.
    func setFirewallLockdownEnabled(_ enabled: Bool) -> Bool {
        lock.lock()
        guard var cfg = config else { lock.unlock(); return false }
        if (cfg.firewallLockdownEnabled ?? false) == enabled {
            lock.unlock(); return true
        }
        cfg.firewallLockdownEnabled = enabled
        config = cfg
        save(cfg)
        lock.unlock()
        notify(cfg)
        fputs("[family] firewall_lockdown_enabled=\(enabled)\n", stderr)
        return true
    }

    /// Drops local pairing. Called from the IPC handler, and from the WS read
    /// loop when the server sends an `unpair` push (e.g. parent removed this
    /// device from their dashboard).
    func clearLocal() {
        lock.lock()
        let deviceId = config?.deviceId
        self.config = nil
        lock.unlock()
        signer.deleteSigned(path: Self.configPath)
        notify(nil)
        if let did = deviceId {
            audit.record(ParentAuditEvents.familyUnpaired, detail: "deviceId=\(did)")
        }
        fputs("[family] unpaired locally\n", stderr)
    }

    // ── Persistence ────────────────────────────────────────────────────────

    private func loadConfig() -> FamilyConfig? {
        guard let data = signer.readVerified(path: Self.configPath) else {
            // Legacy 2.3 unsigned config is treated as untrusted — re-pair required.
            if FileManager.default.fileExists(atPath: Self.configPath) {
                fputs("[family] config has no valid signature — re-pair required\n", stderr)
                audit.record(ParentAuditEvents.familyCacheTampered, detail: "family.json")
            }
            return nil
        }
        do {
            let cfg = try decoder.decode(FamilyConfig.self, from: data)
            return cfg.deviceToken.isEmpty ? nil : cfg
        } catch {
            fputs("[family] config unreadable: \(error)\n", stderr)
            return nil
        }
    }

    private func save(_ cfg: FamilyConfig) {
        do {
            let data = try encoder.encode(cfg)
            signer.writeSigned(path: Self.configPath, data: data)
        } catch {
            fputs("[family] save failed: \(error)\n", stderr)
        }
    }
}
