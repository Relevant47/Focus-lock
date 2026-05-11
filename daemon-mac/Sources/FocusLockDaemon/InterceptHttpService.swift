import Foundation

private let quotes = [
    "You said you'd finish. Honour that promise.",
    "Every minute you hold is a vote for the person you're becoming.",
    "The obstacle is the way. — Marcus Aurelius",
    "Discipline is choosing between what you want now and what you want most.",
    "Focus is the art of knowing what to ignore.",
    "He who cannot obey himself will be commanded. — Nietzsche",
    "The successful warrior is the average man with laser-like focus. — Bruce Lee",
    "You have power over your mind, not outside events. — Marcus Aurelius",
    "Do the hard thing first. Everything else gets easier.",
    "Deep work is the superpower of the 21st century.",
    "What you do right now is what matters most.",
    "Suffer the pain of discipline or suffer the pain of regret.",
    "Be so good they can't ignore you. — Cal Newport",
    "Clarity comes from engagement, not thought.",
    "One hour of focused work beats three hours of half-attention.",
]

/// Serves a branded block page on port 80 so browsers see a meaningful
/// intercept screen instead of a connection-refused error.
final class InterceptHttpService {
    private let session: SessionService
    private var serverSocket: Int32 = -1
    private var isRunning = false

    init(session: SessionService) {
        self.session = session
    }

    func start() {
        let sock = socket(AF_INET, SOCK_STREAM, 0)
        guard sock >= 0 else {
            fputs("[intercept] Failed to create socket\n", stderr)
            return
        }

        var yes: Int32 = 1
        setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout<Int32>.size))

        var addr = sockaddr_in()
        addr.sin_family = sa_family_t(AF_INET)
        addr.sin_port = UInt16(80).bigEndian
        addr.sin_addr.s_addr = INADDR_ANY

        let bindResult = withUnsafePointer(to: &addr) { ptr in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
                bind(sock, sptr, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }

        guard bindResult == 0 else {
            fputs("[intercept] Failed to bind to port 80 — intercept page disabled\n", stderr)
            close(sock)
            return
        }

        listen(sock, 10)
        serverSocket = sock
        isRunning = true
        fputs("[intercept] Listening on port 80\n", stderr)

        Thread.detachNewThread { [weak self] in
            self?.acceptLoop()
        }
    }

    func stop() {
        isRunning = false
        if serverSocket >= 0 { close(serverSocket) }
    }

    private func acceptLoop() {
        while isRunning {
            var clientAddr = sockaddr_in()
            var addrLen = socklen_t(MemoryLayout<sockaddr_in>.size)
            let client = withUnsafeMutablePointer(to: &clientAddr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sptr in
                    accept(serverSocket, sptr, &addrLen)
                }
            }
            guard client >= 0 else { continue }
            let status = session.getStatus()
            Thread.detachNewThread {
                self.handleClient(client, status: status)
            }
        }
    }

    private func handleClient(_ fd: Int32, status: DaemonStatus) {
        defer { close(fd) }

        // Drain the request (we don't need to parse it)
        var buf = [UInt8](repeating: 0, count: 4096)
        _ = read(fd, &buf, buf.count)

        let remaining = status.secondsRemaining ?? 0
        let mins = Int(remaining) / 60
        let secs = Int(remaining) % 60
        let timeStr = String(format: "%02d:%02d", mins, secs)
        let attempts = status.blockAttempts
        let attemptsLabel = attempts == 1 ? "1 block intercepted" : "\(attempts) blocks intercepted"

        let message = status.session?.motivationalMessage?.isEmpty == false
            ? (status.session!.motivationalMessage!)
            : quotes[Int.random(in: 0..<quotes.count)]

        let html = """
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8"/>
          <meta http-equiv="refresh" content="10"/>
          <meta name="viewport" content="width=device-width,initial-scale=1"/>
          <title>Blocked — FocusLock</title>
          <style>
            *{box-sizing:border-box;margin:0;padding:0}
            body{background:#030712;color:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
            .card{max-width:460px;width:100%;text-align:center}
            .icon{font-size:3rem;margin-bottom:1.5rem;display:block;filter:drop-shadow(0 0 24px rgba(99,102,241,.5))}
            h1{font-size:1.5rem;font-weight:700;margin-bottom:.4rem}
            .sub{color:#6b7280;font-size:.875rem;margin-bottom:2rem}
            .timer{font-size:4rem;font-family:ui-monospace,monospace;font-weight:700;color:#6366f1;letter-spacing:.05em;margin-bottom:.25rem;text-shadow:0 0 40px rgba(99,102,241,.4)}
            .timer-label{font-size:.7rem;color:#4b5563;text-transform:uppercase;letter-spacing:.1em;margin-bottom:2rem}
            .track{height:4px;background:#1f2937;border-radius:999px;overflow:hidden;margin-bottom:2rem}
            .bar{height:100%;background:linear-gradient(90deg,#4f46e5,#818cf8);border-radius:999px;animation:pulse 2s ease-in-out infinite alternate}
            @keyframes pulse{to{opacity:.6}}
            .message{font-size:1.1rem;color:#d1d5db;line-height:1.65;font-style:italic;padding:1.25rem 1.5rem;background:#0f172a;border:1px solid #1e293b;border-radius:.75rem;margin-bottom:1.5rem}
            .attempts{font-size:.75rem;color:#374151}
            .brand{margin-top:2.5rem;font-size:.65rem;color:#1f2937;letter-spacing:.2em;text-transform:uppercase;font-weight:600}
          </style>
        </head>
        <body>
          <div class="card">
            <span class="icon">🔒</span>
            <h1>This site is blocked</h1>
            <p class="sub">FocusLock is keeping you on track</p>
            <div class="timer">\(timeStr)</div>
            <div class="timer-label">remaining in session</div>
            <div class="track"><div class="bar"></div></div>
            <div class="message">\(message)</div>
            <p class="attempts">\(attemptsLabel) this session</p>
            <p class="brand">FocusLock</p>
          </div>
        </body>
        </html>
        """

        let body = html.data(using: .utf8) ?? Data()
        let header = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        let response = header.data(using: .utf8)! + body

        response.withUnsafeBytes { ptr in
            _ = write(fd, ptr.baseAddress, ptr.count)
        }
    }
}
