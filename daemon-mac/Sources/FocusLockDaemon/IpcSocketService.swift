import Foundation

/// Unix domain socket IPC server. Accepts newline-delimited JSON requests
/// on /var/run/focuslock.sock and writes JSON responses back.
final class IpcSocketService {
    static let socketPath = "/var/run/focuslock.sock"

    private let sessionSvc: SessionService
    private let profileSvc: ProfileService
    private let parentSvc: ParentService
    private let auditSvc: ParentAuditService
    private let familySvc: FamilyService
    private let familyEnforce: FamilyEnforcementService
    private let cloudSync: CloudSyncService
    private let envProbe: EnvironmentProbe
    private let firewallLockdown: FirewallLockdownService
    private var serverFd: Int32 = -1
    private var isRunning = false

    private let jsonEnc: JSONEncoder = {
        let e = JSONEncoder()
        e.keyEncodingStrategy = .convertToSnakeCase
        e.dateEncodingStrategy = .iso8601
        return e
    }()
    private let jsonDec: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        d.dateDecodingStrategy = .iso8601
        return d
    }()

    init(session: SessionService, profiles: ProfileService, parent: ParentService,
         audit: ParentAuditService, family: FamilyService,
         familyEnforce: FamilyEnforcementService, cloudSync: CloudSyncService,
         envProbe: EnvironmentProbe, firewallLockdown: FirewallLockdownService) {
        self.sessionSvc = session
        self.profileSvc = profiles
        self.parentSvc = parent
        self.auditSvc = audit
        self.familySvc = family
        self.familyEnforce = familyEnforce
        self.cloudSync = cloudSync
        self.envProbe = envProbe
        self.firewallLockdown = firewallLockdown
    }

    func start() {
        unlink(Self.socketPath)

        serverFd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard serverFd >= 0 else { return }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        withUnsafeMutableBytes(of: &addr.sun_path) { ptr in
            let bytes = Self.socketPath.utf8
            bytes.withContiguousStorageIfAvailable { src in
                ptr.copyMemory(from: UnsafeRawBufferPointer(src))
            }
        }

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
                bind(serverFd, sptr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard bindResult == 0 else {
            fputs("[ipc] Failed to bind socket\n", stderr)
            return
        }

        // Allow any local user to connect (daemon runs as root)
        chmod(Self.socketPath, 0o666)
        listen(serverFd, 10)
        isRunning = true
        fputs("[ipc] Listening on \(Self.socketPath)\n", stderr)

        Thread.detachNewThread { [weak self] in
            self?.acceptLoop()
        }
    }

    func stop() {
        isRunning = false
        if serverFd >= 0 { close(serverFd) }
        unlink(Self.socketPath)
    }

    private func acceptLoop() {
        while isRunning {
            var clientAddr = sockaddr_un()
            var addrLen = socklen_t(MemoryLayout<sockaddr_un>.size)
            let client = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
                    accept(serverFd, sptr, &addrLen)
                }
            }
            guard client >= 0 else { continue }
            Thread.detachNewThread {
                self.handleClient(client)
            }
        }
    }

    private func handleClient(_ fd: Int32) {
        defer { close(fd) }
        var buffer = Data()
        var buf = [UInt8](repeating: 0, count: 4096)

        while true {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            buffer.append(contentsOf: buf[..<n])

            // Process all complete lines
            while let newline = buffer.firstIndex(of: UInt8(ascii: "\n")) {
                let line = buffer[buffer.startIndex..<newline]
                buffer = buffer[buffer.index(after: newline)...]

                guard let req = try? jsonDec.decode(IpcRequest.self, from: line) else { continue }
                let resp = handle(req)
                if let data = try? jsonEnc.encode(resp),
                   let line = String(data: data, encoding: .utf8) {
                    let out = (line + "\n").data(using: .utf8)!
                    out.withUnsafeBytes { _ = write(fd, $0.baseAddress, $0.count) }
                }
            }
        }
    }

    // ── Request dispatch ──────────────────────────────────────────────────────

    private func handle(_ req: IpcRequest) -> IpcResponse {
        switch req.type {
        case "ping":          return .pong()
        case "get_status":    return .status(buildStatus())
        case "start_session": return handleStart(req)
        case "stop_session":  return handleStop(req)
        case "skip_break":
            let (err, ok) = sessionSvc.skipBreak()
            return ok ? .ok() : .error(err)
        case "request_disable_hardcore":
            if let gate = gateOrNil(req) { return gate }
            let (err, ok) = sessionSvc.requestDisableHardcore()
            return ok ? .ok() : .error(err)
        case "get_profiles":     return .profiles(profileSvc.getProfiles())
        case "save_profile":     return handleSaveProfile(req)
        case "delete_profile":   return handleDeleteProfile(req)
        case "get_logs":         return handleGetLogs(req)
        case "get_schedules":    return .schedules(profileSvc.getSchedules())
        case "save_schedule":    return handleSaveSchedule(req)
        case "delete_schedule":  return handleDeleteSchedule(req)
        case "record_block_attempt":
            if let payload: RecordBlockAttemptPayload = decode(req.payload),
               let label = payload.label?.trimmingCharacters(in: .whitespacesAndNewlines),
               !label.isEmpty {
                fputs("[intercept] Block attempt label: \(label)\n", stderr)
            }
            sessionSvc.incrementBlockAttempt()
            return .ok()
        case "set_parent_pin":    return handleSetParentPin(req)
        case "verify_parent_pin": return handleVerifyParentPin(req)
        case "change_parent_pin": return handleChangeParentPin(req)
        case "clear_parent_pin":  return handleClearParentPin(req)
        case "verify_recovery_key":      return handleVerifyRecoveryKey(req)
        case "regenerate_recovery_key":  return handleRegenerateRecoveryKey(req)
        case "get_parent_audit":  return handleGetParentAudit(req)
        case "family_redeem_code":         return handleFamilyRedeem(req)
        case "family_unpair":              return handleFamilyUnpair(req)
        case "family_get_status":          return .familyStatus(buildFamilyStatus())
        case "family_check_environment":   return .familyEnvironment(envProbe.probe())
        case "family_authorize_uninstall": return handleFamilyAuthorizeUninstall(req)
        case "family_set_firewall_lockdown": return handleFamilySetFirewallLockdown(req)
        default:
            return .error("Unknown request type: \(req.type)")
        }
    }

    // ── Family controls (Phase 2.3) ──────────────────────────────────────────

    private func buildFamilyStatus() -> FamilyStatus {
        let cfg = familySvc.current
        let snap = familyEnforce.snapshot()
        let iso = ISO8601DateFormatter()
        return FamilyStatus(
            paired:             cfg != nil,
            connected:          cloudSync.connected,
            accountId:          cfg?.accountId,
            deviceId:           cfg?.deviceId,
            serverUrl:          cfg?.serverUrl,
            lastConnectedAt:    cloudSync.lastConnectedAt.map { iso.string(from: $0) },
            lastDisconnectedAt: cloudSync.lastDisconnectedAt.map { iso.string(from: $0) },
            lastError:          cloudSync.lastError,
            activeRuleCount:    snap.count,
            offlineSeconds:     cloudSync.offlineSeconds,
            activeRules:        snap,
            firewallLockdownEnabled: cfg?.firewallLockdownEnabled ?? false,
            firewallLockdownActive:  firewallLockdown.isLocked
        )
    }

    private func handleFamilyAuthorizeUninstall(_ req: IpcRequest) -> IpcResponse {
        // Mac uninstall is "drag to Trash" — no NSIS gate to honour. Still
        // accept the IPC for protocol parity so the UI can call it cross-
        // platform without conditionals. Write the audit event so a parent
        // can see uninstall was attempted.
        if let gate = gateOrNil(req) { return gate }
        auditSvc.record(ParentAuditEvents.uninstallAuthorized,
                        detail: "platform=macos noop=true")
        return .ok()
    }

    private func handleFamilySetFirewallLockdown(_ req: IpcRequest) -> IpcResponse {
        if let gate = gateOrNil(req) { return gate }
        guard let dict = req.payload?.value as? [String: AnyCodable],
              let enabled = dict["enabled"]?.value as? Bool else {
            return .error("Missing 'enabled' boolean")
        }
        if !familySvc.setFirewallLockdownEnabled(enabled) {
            return .error("Device is not paired")
        }
        return .ok()
    }

    private func handleFamilyRedeem(_ req: IpcRequest) -> IpcResponse {
        // Pairing is gated behind the settings PIN when one is configured —
        // a child shouldn't be able to re-pair their own device to a different
        // parent account to escape an existing lock.
        if let gate = gateOrNil(req) { return gate }
        guard let payload: FamilyRedeemPayload = decode(req.payload),
              !payload.code.isEmpty, !payload.serverUrl.isEmpty else {
            return .error("code and serverUrl required")
        }
        let (err, result) = familySvc.redeem(code: payload.code, serverUrl: payload.serverUrl)
        if let err = err { return .error(err) }
        guard let result = result else { return .error("Pairing failed") }
        return .familyPaired(result)
    }

    private func handleFamilyUnpair(_ req: IpcRequest) -> IpcResponse {
        if let gate = gateOrNil(req) { return gate }
        familySvc.clearLocal()
        return .ok()
    }

    // ── Status overlay ───────────────────────────────────────────────────────

    private func buildStatus() -> DaemonStatus {
        var status = sessionSvc.getStatus()
        status.parentControls = ParentControlsState(
            enabled: parentSvc.isEnabled,
            rateLimited: parentSvc.isRateLimited,
            retryAfterSeconds: parentSvc.retryAfterSeconds,
            graceMinutes: parentSvc.graceMinutes
        )
        status.family = buildFamilyStatus()
        return status
    }

    // ── Parental gate ────────────────────────────────────────────────────────

    /// Returns nil when the request is allowed, or an error response when blocked.
    private func gateOrNil(_ req: IpcRequest) -> IpcResponse? {
        guard parentSvc.isEnabled else { return nil }
        let token = extractParentToken(req.payload)
        if parentSvc.isAuthorized(token) {
            // Token-authorized passage through the gate: audit it. (Implicit
            // pass when no PIN is configured is not audited — there is no gate.)
            auditSvc.record(ParentAuditEvents.gateAllowed, command: req.type)
            return nil
        }
        auditSvc.record(ParentAuditEvents.gateBlocked, command: req.type)
        return .error("Parent PIN required to perform this action", code: ParentErrorCode.lockRequired)
    }

    private func extractParentToken(_ value: AnyCodable?) -> String? {
        guard let dict = value?.value as? [String: AnyCodable] else { return nil }
        return dict["parentToken"]?.value as? String
    }

    private func handleStart(_ req: IpcRequest) -> IpcResponse {
        guard let payload: StartSessionPayload = decode(req.payload) else {
            return .error("Invalid payload")
        }
        let (err, ok) = sessionSvc.startSession(payload)
        return ok ? .ok() : .error(err)
    }

    private func handleStop(_ req: IpcRequest) -> IpcResponse {
        // Parental gate: when a parent PIN is set, stopping early requires the parent token,
        // in addition to any friend-lock token the session already enforces.
        if let gate = gateOrNil(req) { return gate }
        let payload: StopSessionPayload? = decode(req.payload)
        let (err, ok) = sessionSvc.stopSession(unlockToken: payload?.unlockToken)
        return ok ? .ok() : .error(err)
    }

    private func handleSaveProfile(_ req: IpcRequest) -> IpcResponse {
        if let gate = gateOrNil(req) { return gate }
        guard let profile: FocusProfile = decode(req.payload) else {
            return .error("Invalid payload")
        }
        profileSvc.saveProfile(profile)
        return .ok()
    }

    private func handleDeleteProfile(_ req: IpcRequest) -> IpcResponse {
        if let gate = gateOrNil(req) { return gate }
        guard let id = extractId(req.payload) else { return .error("Missing id") }
        profileSvc.deleteProfile(id: id)
        return .ok()
    }

    private func handleGetLogs(_ req: IpcRequest) -> IpcResponse {
        var limit = 50
        if let dict = req.payload?.value as? [String: AnyCodable],
           let l = dict["limit"]?.value as? Int {
            limit = l
        }
        return .logs(sessionSvc.getLogs(limit: limit))
    }

    private func handleSaveSchedule(_ req: IpcRequest) -> IpcResponse {
        if let gate = gateOrNil(req) { return gate }
        guard let schedule: ScheduledSession = decode(req.payload) else {
            return .error("Invalid payload")
        }
        profileSvc.saveSchedule(schedule)
        return .ok()
    }

    private func handleDeleteSchedule(_ req: IpcRequest) -> IpcResponse {
        if let gate = gateOrNil(req) { return gate }
        guard let id = extractId(req.payload) else { return .error("Missing id") }
        profileSvc.deleteSchedule(id: id)
        return .ok()
    }

    // ── Parental control handlers ────────────────────────────────────────────

    private func handleSetParentPin(_ req: IpcRequest) -> IpcResponse {
        guard let payload: SetParentPinPayload = decode(req.payload), !payload.pin.isEmpty else {
            return .error("Invalid payload")
        }
        let out = parentSvc.setPin(payload.pin, oldPin: payload.oldPin)
        if !out.success {
            return out.code.map { .error(out.error, code: $0) } ?? .error(out.error)
        }
        // On first setup, return the freshly-generated recovery key one time.
        // On change, the existing key is preserved and the response is a plain Ok.
        if let key = out.recoveryKey { return .okWithRecoveryKey(key) }
        return .ok()
    }

    private func handleVerifyRecoveryKey(_ req: IpcRequest) -> IpcResponse {
        // Intentionally ungated — recovery exists precisely for when the parent can't unlock.
        guard let payload: VerifyRecoveryKeyPayload = decode(req.payload), !payload.key.isEmpty else {
            return .error("Recovery key required")
        }
        let out = parentSvc.verifyRecoveryKey(payload.key)
        if out.success { return .ok() }
        return out.code.map { .error(out.error, code: $0) } ?? .error(out.error)
    }

    private func handleRegenerateRecoveryKey(_ req: IpcRequest) -> IpcResponse {
        // Requires the current PIN (not a grace token) — the user has to re-prove they know it.
        guard let payload: RegenerateRecoveryKeyPayload = decode(req.payload), !payload.pin.isEmpty else {
            return .error("Current PIN required")
        }
        let out = parentSvc.regenerateRecoveryKey(pin: payload.pin)
        if !out.success {
            return out.code.map { .error(out.error, code: $0) } ?? .error(out.error)
        }
        return .recoveryKey(out.recoveryKey ?? "")
    }

    private func handleVerifyParentPin(_ req: IpcRequest) -> IpcResponse {
        guard let payload: VerifyParentPinPayload = decode(req.payload), !payload.pin.isEmpty else {
            return .error("Invalid payload")
        }
        let out = parentSvc.verifyPin(payload.pin)
        if let token = out.token, let expiresAt = out.expiresAt {
            return .parentToken(ParentTokenResponsePayload(
                token: token,
                expiresAt: ISO8601DateFormatter().string(from: expiresAt)
            ))
        }
        return out.code.map { .error(out.error, code: $0) } ?? .error(out.error)
    }

    private func handleChangeParentPin(_ req: IpcRequest) -> IpcResponse {
        guard let payload: ChangeParentPinPayload = decode(req.payload), !payload.newPin.isEmpty else {
            return .error("Invalid payload")
        }
        let out = parentSvc.setPin(payload.newPin, oldPin: payload.oldPin)
        if out.success { return .ok() }
        return out.code.map { .error(out.error, code: $0) } ?? .error(out.error)
    }

    private func handleClearParentPin(_ req: IpcRequest) -> IpcResponse {
        guard let payload: ClearParentPinPayload = decode(req.payload), !payload.pin.isEmpty else {
            return .error("Invalid payload")
        }
        let out = parentSvc.clearPin(payload.pin)
        if out.success { return .ok() }
        return out.code.map { .error(out.error, code: $0) } ?? .error(out.error)
    }

    private func handleGetParentAudit(_ req: IpcRequest) -> IpcResponse {
        // Gate the audit read when a PIN is configured — otherwise a child could
        // read their own attempt history without authorization. When no PIN is set
        // there is nothing privileged to protect, so allow open reads.
        if let gate = gateOrNil(req) { return gate }

        var limit = 100
        if let dict = req.payload?.value as? [String: AnyCodable],
           let l = dict["limit"]?.value as? Int {
            limit = l
        }
        return .parentAudit(auditSvc.recent(limit: limit))
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private func decode<T: Decodable>(_ value: AnyCodable?) -> T? {
        guard let v = value,
              let data = try? jsonEnc.encode(v) else { return nil }
        return try? jsonDec.decode(T.self, from: data)
    }

    private func extractId(_ value: AnyCodable?) -> String? {
        guard let v = value,
              let dict = v.value as? [String: AnyCodable] else { return nil }
        return dict["id"]?.value as? String
    }
}
