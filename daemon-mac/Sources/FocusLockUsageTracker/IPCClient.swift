import Foundation
import Darwin

/// Newline-delimited-JSON client for the daemon socket at
/// `/var/run/focuslock.sock`. One instance owns one AF_UNIX file
/// descriptor; caller reconnects by dropping and re-creating.
///
/// Not thread-safe: the tracker's sample loop is single-threaded, so we
/// don't pay the mutex cost.
final class IPCClient {
    enum IPCError: Error, CustomStringConvertible {
        case socket(String)
        case connect(Int32)
        case write(Int32)
        case read(Int32)
        case timeout
        case badJson

        var description: String {
            switch self {
            case .socket(let m):  return "socket: \(m)"
            case .connect(let e): return "connect: errno=\(e)"
            case .write(let e):   return "write: errno=\(e)"
            case .read(let e):    return "read: errno=\(e) (0 = peer closed)"
            case .timeout:        return "read timeout"
            case .badJson:        return "bad JSON response"
            }
        }
    }

    private let socketPath: String
    private var fd: Int32 = -1
    /// Buffer for partial reads across `readLine` calls — the daemon may
    /// coalesce our request/response with the next tick's on a busy socket.
    private var readBuf = Data()
    /// Per-request read timeout. get_status is synchronous and small; if the
    /// daemon takes >3s to reply, something is very wrong.
    private let readTimeoutSec: Double = 3.0

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    deinit { close() }

    // MARK: - Lifecycle

    func connect() throws {
        let s = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        if s < 0 {
            throw IPCError.socket("socket() returned \(s), errno=\(errno)")
        }
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        _ = withUnsafeMutableBytes(of: &addr.sun_path) { dst in
            socketPath.utf8.withContiguousStorageIfAvailable { src in
                dst.copyMemory(from: UnsafeRawBufferPointer(src))
            }
        }
        let rc = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
                Darwin.connect(s, sptr, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        if rc != 0 {
            let e = errno
            Darwin.close(s)
            throw IPCError.connect(e)
        }
        // SO_NOSIGPIPE — never let a peer-closed socket kill our process
        // with SIGPIPE. We already surface EPIPE as an IPCError.write.
        var one: Int32 = 1
        _ = setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        self.fd = s
        self.readBuf.removeAll(keepingCapacity: true)
    }

    func close() {
        if fd >= 0 {
            Darwin.close(fd)
            fd = -1
        }
        readBuf.removeAll(keepingCapacity: true)
    }

    // MARK: - Request/response

    /// Send `json` and block for one response line. Returns the parsed JSON
    /// object (or nil if the response wasn't an object).
    func request(_ json: [String: Any]) throws -> [String: Any]? {
        try sendLine(json)
        let line = try readLine()
        guard let data = line.data(using: .utf8) else { throw IPCError.badJson }
        guard let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw IPCError.badJson
        }
        return obj
    }

    /// Send `json`, then drain one response line and discard it.
    ///
    /// Not truly fire-and-forget on the socket layer — every daemon request
    /// yields exactly one `{"type":"ok"}` reply, and if we don't consume it
    /// the next `request()` reads a stale line. Draining keeps the request
    /// pipeline in sync; the caller just doesn't act on the payload.
    func sendFireAndForget(_ json: [String: Any]) throws {
        try sendLine(json)
        _ = try readLine()
    }

    // MARK: - Internals

    private func sendLine(_ json: [String: Any]) throws {
        let data = try JSONSerialization.data(withJSONObject: json, options: [])
        var out = data
        out.append(0x0a)  // newline
        try out.withUnsafeBytes { raw in
            var offset = 0
            let base = raw.baseAddress!
            while offset < raw.count {
                let n = Darwin.write(fd, base.advanced(by: offset), raw.count - offset)
                if n < 0 { throw IPCError.write(errno) }
                if n == 0 { throw IPCError.write(0) }
                offset += n
            }
        }
    }

    /// Read up to and including the next '\n', return the line without it.
    private func readLine() throws -> String {
        let deadline = Date().addingTimeInterval(readTimeoutSec)
        while true {
            if let nl = readBuf.firstIndex(of: 0x0a) {
                let line = readBuf[readBuf.startIndex..<nl]
                readBuf.removeSubrange(readBuf.startIndex...nl)
                return String(data: line, encoding: .utf8) ?? ""
            }
            let remaining = deadline.timeIntervalSinceNow
            if remaining <= 0 { throw IPCError.timeout }

            // select() with a per-attempt timeout so we don't block forever
            // if the daemon vanishes mid-response.
            var rfds = fd_set()
            fdZero(&rfds)
            fdSet(fd, set: &rfds)
            var tv = timeval(
                tv_sec:  Int(remaining),
                tv_usec: Int32((remaining - Double(Int(remaining))) * 1_000_000)
            )
            let rc = Darwin.select(fd + 1, &rfds, nil, nil, &tv)
            if rc < 0 { throw IPCError.read(errno) }
            if rc == 0 { throw IPCError.timeout }

            var chunk = [UInt8](repeating: 0, count: 4096)
            let n = Darwin.read(fd, &chunk, chunk.count)
            if n < 0 { throw IPCError.read(errno) }
            if n == 0 { throw IPCError.read(0) }  // peer closed
            readBuf.append(chunk, count: n)
        }
    }
}

// MARK: - fd_set helpers (Darwin exposes fd_set as a fixed C bitset; Swift has no ergonomic API)

private func fdZero(_ set: inout fd_set) {
    set = fd_set()
}

private func fdSet(_ fd: Int32, set: inout fd_set) {
    // __DARWIN_FD_SETSIZE = 1024. fd_set is 128 UInt32 words. Bit `fd`
    // lives in word (fd / 32), position (fd % 32).
    let word = Int(fd) / 32
    let bit  = Int32(fd) % 32
    withUnsafeMutablePointer(to: &set.fds_bits) { raw in
        raw.withMemoryRebound(to: Int32.self, capacity: 32) { p in
            p[word] |= (Int32(1) << bit)
        }
    }
}
