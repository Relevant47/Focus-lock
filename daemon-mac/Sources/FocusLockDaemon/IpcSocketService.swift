import Foundation

/// Unix domain socket IPC server. Accepts newline-delimited JSON requests
/// on /var/run/focuslock.sock and writes JSON responses back.
final class IpcSocketService {
    static let socketPath = "/var/run/focuslock.sock"

    private let sessionSvc: SessionService
    private let profileSvc: ProfileService
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

    init(session: SessionService, profiles: ProfileService) {
        self.sessionSvc = session
        self.profileSvc = profiles
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
        case "ping":        return .pong()
        case "get_status":  return .status(sessionSvc.getStatus())
        case "start_session": return handleStart(req)
        case "stop_session":  return handleStop(req)
        case "skip_break":
            let (err, ok) = sessionSvc.skipBreak()
            return ok ? .ok() : .error(err)
        case "request_disable_hardcore":
            let (err, ok) = sessionSvc.requestDisableHardcore()
            return ok ? .ok() : .error(err)
        case "get_profiles":  return .profiles(profileSvc.getProfiles())
        case "save_profile":  return handleSaveProfile(req)
        case "delete_profile": return handleDeleteProfile(req)
        case "get_logs":      return handleGetLogs(req)
        case "get_schedules": return .schedules(profileSvc.getSchedules())
        case "save_schedule": return handleSaveSchedule(req)
        case "delete_schedule": return handleDeleteSchedule(req)
        case "record_block_attempt":
            if let payload: RecordBlockAttemptPayload = decode(req.payload),
               let label = payload.label?.trimmingCharacters(in: .whitespacesAndNewlines),
               !label.isEmpty {
                fputs("[intercept] Block attempt label: \(label)\n", stderr)
            }
            sessionSvc.incrementBlockAttempt()
            return .ok()
        default:
            return .error("Unknown request type: \(req.type)")
        }
    }

    private func handleStart(_ req: IpcRequest) -> IpcResponse {
        guard let payload: StartSessionPayload = decode(req.payload) else {
            return .error("Invalid payload")
        }
        let (err, ok) = sessionSvc.startSession(payload)
        return ok ? .ok() : .error(err)
    }

    private func handleStop(_ req: IpcRequest) -> IpcResponse {
        let payload: StopSessionPayload? = decode(req.payload)
        let (err, ok) = sessionSvc.stopSession(unlockToken: payload?.unlockToken)
        return ok ? .ok() : .error(err)
    }

    private func handleSaveProfile(_ req: IpcRequest) -> IpcResponse {
        guard let profile: FocusProfile = decode(req.payload) else {
            return .error("Invalid payload")
        }
        profileSvc.saveProfile(profile)
        return .ok()
    }

    private func handleDeleteProfile(_ req: IpcRequest) -> IpcResponse {
        guard let id = extractId(req.payload) else { return .error("Missing id") }
        profileSvc.deleteProfile(id: id)
        return .ok()
    }

    private func handleGetLogs(_ req: IpcRequest) -> IpcResponse {
        // Extract limit from payload if present
        let limit = 50
        return .logs(sessionSvc.getLogs(limit: limit))
    }

    private func handleSaveSchedule(_ req: IpcRequest) -> IpcResponse {
        guard let schedule: ScheduledSession = decode(req.payload) else {
            return .error("Invalid payload")
        }
        profileSvc.saveSchedule(schedule)
        return .ok()
    }

    private func handleDeleteSchedule(_ req: IpcRequest) -> IpcResponse {
        guard let id = extractId(req.payload) else { return .error("Missing id") }
        profileSvc.deleteSchedule(id: id)
        return .ok()
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
