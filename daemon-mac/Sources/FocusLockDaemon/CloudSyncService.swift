import Foundation

/// Holds the long-lived WebSocket to the family server, applies push messages
/// to FamilyEnforcementService, and emits 60-second heartbeats. Reconnects
/// with exponential backoff (2s → 30s) on transport failures.
///
/// On every reconnect the daemon pulls the current rule set via the REST
/// snapshot endpoint before re-opening the WS, so any missed push window
/// can't leave the cache stale.
///
/// Heartbeats carry both wall and monotonic timestamps. The wall clock is the
/// child's local time; the monotonic value comes from mach_continuous_time()
/// and is immune to clock jumps. Phase 2.4 will use the divergence between
/// the two server-side to flag clock-tampered devices.
final class CloudSyncService: NSObject, URLSessionWebSocketDelegate {
    private static let heartbeatInterval: TimeInterval = 60
    private static let reconnectMin: TimeInterval = 2
    private static let reconnectMax: TimeInterval = 30
    private static let offlineAuditThreshold: TimeInterval = 300  // 5 minutes
    private static let userAgent = "FocusLock-Daemon/1.2.1"
    /// Written on every connect / disconnect / successful heartbeat so
    /// `offlineSeconds` can measure outages that span a daemon restart or a
    /// cold boot during a network outage. Root-owned; only the daemon reads.
    private static let heartbeatPath = "/Library/Application Support/FocusLock/cloudsync-lastseen.json"

    private let family: FamilyService
    private let enforce: FamilyEnforcementService
    private let audit: ParentAuditService

    private let lock = NSLock()
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?
    private var runThread: Thread?
    private var shouldStop = false
    private var currentDelay: TimeInterval = reconnectMin
    private var bootMonotonic: UInt64 = 0

    private(set) var connected: Bool = false
    private(set) var lastConnectedAt: Date?
    private(set) var lastDisconnectedAt: Date?
    private(set) var lastError: String?
    /// Fires the family_offline_5min audit at most once per outage.
    private var outageAudited: Bool = false

    /// Seconds since the most recent successful WS connection. 0 while connected.
    var offlineSeconds: Int {
        lock.lock(); defer { lock.unlock() }
        if connected { return 0 }
        let anchor = lastDisconnectedAt ?? lastConnectedAt
        guard let a = anchor else { return 0 }
        let delta = Date().timeIntervalSince(a)
        return delta > 0 ? Int(delta) : 0
    }

    init(family: FamilyService, enforce: FamilyEnforcementService, audit: ParentAuditService) {
        self.family = family
        self.enforce = enforce
        self.audit = audit
        super.init()
        // mach_continuous_time isn't bridged; fall back to clock_gettime_nsec_np.
        self.bootMonotonic = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW)
        // Seed lastConnectedAt from the on-disk heartbeat so a cold-boot outage
        // arms the firewall lockdown as soon as offlineSeconds crosses the
        // threshold, rather than waiting for a first-in-this-process WS connect.
        if let persisted = Self.loadHeartbeatFromDisk() {
            self.lastConnectedAt = persisted
        }
    }

    // MARK: - Persisted heartbeat

    private static func loadHeartbeatFromDisk() -> Date? {
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: heartbeatPath)),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let t = obj["lastSeenUnix"] as? Double else {
            return nil
        }
        // Reject implausible values (clock skew, tampering, corruption). A
        // negative or future timestamp would poison offlineSeconds.
        let d = Date(timeIntervalSince1970: t)
        if d > Date().addingTimeInterval(60) { return nil }
        if d.timeIntervalSince1970 <= 0 { return nil }
        return d
    }

    private func persistHeartbeat(_ date: Date) {
        let body: [String: Any] = ["lastSeenUnix": date.timeIntervalSince1970]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return }
        // Best-effort — a write failure here shouldn't take down the sync loop.
        // /Library/Application Support/FocusLock is created by other services
        // during boot, so we don't try to mkdir it here.
        try? data.write(to: URL(fileURLWithPath: Self.heartbeatPath), options: .atomic)
    }

    func start() {
        family.onConfigChanged { [weak self] cfg in
            guard let self = self else { return }
            if cfg != nil {
                self.kickReconnect()
            } else {
                self.enforce.clearAll()
                self.cancelTask()
            }
        }
        if family.isPaired { kickReconnect() }
    }

    private func kickReconnect() {
        cancelTask()
        startRunThread()
    }

    private func cancelTask() {
        lock.lock()
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connected = false
        lock.unlock()
    }

    private func startRunThread() {
        let thread = Thread { [weak self] in self?.runLoop() }
        thread.name = "focuslock.cloudsync"
        lock.lock()
        shouldStop = false
        currentDelay = Self.reconnectMin
        runThread = thread
        lock.unlock()
        thread.start()
    }

    private func runLoop() {
        while !shouldStop {
            guard let cfg = family.current else { return }

            do {
                try pullSnapshot(cfg)
                try runSession(cfg)
                lock.lock(); currentDelay = Self.reconnectMin; lock.unlock()
            } catch CloudError.unauthorized {
                fputs("[cloudsync] device unauthorized — clearing pairing\n", stderr)
                family.clearLocal()
                return
            } catch {
                lock.lock(); lastError = "\(error)"; lock.unlock()
                fputs("[cloudsync] session ended: \(error)\n", stderr)
            }

            lock.lock()
            if lastDisconnectedAt == nil { lastDisconnectedAt = Date() }
            connected = false
            let delay = currentDelay
            currentDelay = min(delay * 2, Self.reconnectMax)
            lock.unlock()

            // Fire a one-shot audit when an outage crosses the 5-minute mark.
            // Re-evaluated on every reconnect attempt — sleeps cap at 30s so
            // the alert lands within roughly half a minute of the threshold.
            maybeAuditOutage()

            Thread.sleep(forTimeInterval: delay)
            if shouldStop { return }
        }
    }

    private func maybeAuditOutage() {
        lock.lock()
        let alreadyAudited = outageAudited
        let anchor = lastDisconnectedAt
        lock.unlock()
        if alreadyAudited { return }
        guard let a = anchor else { return }
        if Date().timeIntervalSince(a) < Self.offlineAuditThreshold { return }
        lock.lock(); outageAudited = true; lock.unlock()
        audit.record(ParentAuditEvents.familyOffline5Min,
                     detail: "offlineSince=\(ISO8601DateFormatter().string(from: a))")
        fputs("[cloudsync] device offline > 5min since \(a)\n", stderr)
    }

    // ── Snapshot pull (REST) ───────────────────────────────────────────────

    private func pullSnapshot(_ cfg: FamilyConfig) throws {
        guard let url = URL(string: "\(cfg.serverUrl)/api/v1/device/rules") else {
            throw CloudError.invalidUrl
        }
        var req = URLRequest(url: url, timeoutInterval: 15)
        req.setValue("Bearer \(cfg.deviceToken)", forHTTPHeaderField: "Authorization")
        req.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")

        let sem = DispatchSemaphore(value: 0)
        var outErr: Error?
        var outData: Data?
        var outStatus: Int = 0
        URLSession.shared.dataTask(with: req) { data, resp, err in
            defer { sem.signal() }
            if let err = err { outErr = err; return }
            outStatus = (resp as? HTTPURLResponse)?.statusCode ?? 0
            outData = data
        }.resume()
        sem.wait()

        if let err = outErr { throw err }
        if outStatus == 401 || outStatus == 403 { throw CloudError.unauthorized }
        guard (200..<300).contains(outStatus), let data = outData else {
            throw CloudError.snapshotFailed(outStatus)
        }
        let env = try JSONDecoder().decode(CloudRulesEnvelope.self, from: data)
        enforce.replace(env.rules)
    }

    // ── WebSocket session ──────────────────────────────────────────────────

    private func runSession(_ cfg: FamilyConfig) throws {
        guard let wsUrl = makeWsUrl(cfg.serverUrl) else { throw CloudError.invalidUrl }

        var req = URLRequest(url: wsUrl, timeoutInterval: 30)
        req.setValue("Bearer \(cfg.deviceToken)", forHTTPHeaderField: "Authorization")
        req.setValue(Self.userAgent, forHTTPHeaderField: "User-Agent")

        let cfgURL = URLSessionConfiguration.default
        cfgURL.timeoutIntervalForRequest = 30
        let session = URLSession(configuration: cfgURL, delegate: self, delegateQueue: nil)
        let task = session.webSocketTask(with: req)

        lock.lock()
        self.session = session
        self.task = task
        lock.unlock()

        fputs("[cloudsync] connecting to \(wsUrl)\n", stderr)
        task.resume()

        // Block this thread until either heartbeat or read loop signals end.
        let sessionEnded = DispatchSemaphore(value: 0)
        var sessionError: Error?

        readLoop(task: task) { err in
            sessionError = err
            sessionEnded.signal()
        }
        startHeartbeat(task: task) { err in
            if sessionError == nil { sessionError = err }
            sessionEnded.signal()
        }

        sessionEnded.wait()
        task.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()

        if let err = sessionError { throw err }
    }

    private func readLoop(task: URLSessionWebSocketTask, onEnd: @escaping (Error?) -> Void) {
        task.receive { [weak self] result in
            guard let self = self else { onEnd(nil); return }
            switch result {
            case .failure(let err):
                onEnd(err)
            case .success(let msg):
                self.handleIncoming(msg)
                self.readLoop(task: task, onEnd: onEnd)
            }
        }
    }

    private func handleIncoming(_ msg: URLSessionWebSocketTask.Message) {
        let text: String
        switch msg {
        case .string(let s): text = s
        case .data(let d):   text = String(data: d, encoding: .utf8) ?? ""
        @unknown default:    return
        }
        guard let data = text.data(using: .utf8),
              let cm = try? JSONDecoder().decode(CloudMessage.self, from: data) else {
            fputs("[cloudsync] ignoring malformed message\n", stderr)
            return
        }
        switch cm.type {
        case "ack":
            break
        case "rule_change":
            if let rule = cm.rule { enforce.upsert(rule) }
        case "rule_delete":
            if let id = cm.ruleId { enforce.remove(ruleId: id) }
        case "unpair":
            fputs("[cloudsync] server requested unpair\n", stderr)
            family.clearLocal()
        default:
            fputs("[cloudsync] unknown message type: \(cm.type)\n", stderr)
        }
    }

    private func startHeartbeat(task: URLSessionWebSocketTask, onEnd: @escaping (Error?) -> Void) {
        Thread.detachNewThread { [weak self] in
            guard let self = self else { onEnd(nil); return }
            while !self.shouldStop, task.state == .running {
                let monoNs = clock_gettime_nsec_np(CLOCK_MONOTONIC_RAW) &- self.bootMonotonic
                let wall = ISO8601DateFormatter().string(from: Date())
                let payload: [String: Any] = [
                    "type": "heartbeat",
                    "wall": wall,
                    "mono": monoNs / 1_000_000,  // ms
                ]
                guard let body = try? JSONSerialization.data(withJSONObject: payload),
                      let str = String(data: body, encoding: .utf8) else { break }

                let sem = DispatchSemaphore(value: 0)
                var sendErr: Error?
                task.send(.string(str)) { err in
                    sendErr = err; sem.signal()
                }
                sem.wait()
                if let sendErr = sendErr {
                    onEnd(sendErr)
                    return
                }
                // Refresh the persisted heartbeat so a hard crash between
                // connect and disconnect doesn't rewind the offline anchor.
                self.persistHeartbeat(Date())
                Thread.sleep(forTimeInterval: Self.heartbeatInterval)
            }
            onEnd(nil)
        }
    }

    private func makeWsUrl(_ httpUrl: String) -> URL? {
        let lower = httpUrl.lowercased()
        var path = httpUrl
        if lower.hasPrefix("https://") {
            path = "wss://" + String(httpUrl.dropFirst("https://".count))
        } else if lower.hasPrefix("http://") {
            path = "ws://" + String(httpUrl.dropFirst("http://".count))
        }
        return URL(string: "\(path)/api/v1/device/ws")
    }

    // ── URLSessionWebSocketDelegate ────────────────────────────────────────

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol `protocol`: String?) {
        let now = Date()
        lock.lock()
        let wasOffline = outageAudited
        connected = true
        lastConnectedAt = now
        lastDisconnectedAt = nil
        lastError = nil
        outageAudited = false
        lock.unlock()
        persistHeartbeat(now)
        if wasOffline {
            audit.record(ParentAuditEvents.familyReconnected)
            fputs("[cloudsync] reconnected after extended outage\n", stderr)
        }
        fputs("[cloudsync] connected\n", stderr)
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
                    reason: Data?) {
        let now = Date()
        lock.lock()
        connected = false
        lastDisconnectedAt = now
        lock.unlock()
        persistHeartbeat(now)
        fputs("[cloudsync] closed code=\(closeCode.rawValue)\n", stderr)
    }
}

private enum CloudError: Error, CustomStringConvertible {
    case invalidUrl
    case unauthorized
    case snapshotFailed(Int)

    var description: String {
        switch self {
        case .invalidUrl:               return "invalid server URL"
        case .unauthorized:             return "unauthorized"
        case .snapshotFailed(let code): return "snapshot HTTP \(code)"
        }
    }
}
