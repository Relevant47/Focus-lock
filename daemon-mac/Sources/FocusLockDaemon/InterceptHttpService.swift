import Foundation

private let quotes: [(String, String?)] = [
    ("You have power over your mind — not outside events. Realize this, and you will find strength.", "Marcus Aurelius"),
    ("He who cannot obey himself will be commanded.", "Friedrich Nietzsche"),
    ("The successful warrior is the average man with laser-like focus.", "Bruce Lee"),
    ("Discipline is choosing between what you want now and what you want most.", "Abraham Lincoln"),
    ("Be so good they can't ignore you.", "Steve Martin"),
    ("Deep work is the superpower of the 21st century.", "Cal Newport"),
    ("Suffer the pain of discipline or suffer the pain of regret.", "Jim Rohn"),
    ("The obstacle is the way.", "Marcus Aurelius"),
    ("What we fear doing most is usually what we most need to do.", "Tim Ferriss"),
    ("Winning is not a sometime thing — it's an all the time thing.", "Vince Lombardi"),
    ("You said you'd finish the chapter first. Honour that promise to yourself.", nil),
    ("Every minute you hold is a vote for the person you're becoming.", nil),
    ("Small disciplines repeated with consistency every day lead to great achievements.", "John C. Maxwell"),
    ("Clarity comes from engagement, not thought.", "Marie Forleo"),
    ("Concentration is the secret of strength.", "Ralph Waldo Emerson"),
    ("The cost of distraction is paid in the currency of your dreams.", nil),
    ("Do the hard thing first. Everything after gets easier.", nil),
    ("One hour of focused work beats three of half-attention.", nil),
    ("Where focus goes, energy flows.", "Tony Robbins"),
    ("Champions keep playing until they get it right.", "Billie Jean King"),
]

/// Serves a branded block page on port 80 so browsers see a meaningful
/// intercept screen instead of a connection-refused error. Also accepts
/// POST /record-attempt for the "what were you trying to do?" input.
final class InterceptHttpService {
    private let session: SessionService
    private let profiles: ProfileService
    private var serverSocket: Int32 = -1
    private var isRunning = false

    init(session: SessionService, profiles: ProfileService) {
        self.session = session
        self.profiles = profiles
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
            Thread.detachNewThread { [weak self] in
                self?.handleClient(client)
            }
        }
    }

    private func handleClient(_ fd: Int32) {
        defer { close(fd) }

        // Read at most 16KB — enough for a typical request line + headers + small form body.
        var raw = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        for _ in 0..<4 {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            raw.append(contentsOf: buf[..<n])
            // If we have the end of headers and any body the Content-Length implies, we can stop.
            if let s = String(data: raw, encoding: .utf8),
               let headerEnd = s.range(of: "\r\n\r\n") {
                let headers = String(s[..<headerEnd.lowerBound])
                let body = String(s[headerEnd.upperBound...])
                let contentLength = parseContentLength(headers)
                if contentLength == nil || body.utf8.count >= contentLength! {
                    break
                }
            }
        }

        guard let request = String(data: raw, encoding: .utf8) else {
            sendBlockPage(fd)
            return
        }

        let (method, path) = parseRequestLine(request)

        if method == "POST" && path == "/record-attempt" {
            let body: String = {
                if let r = request.range(of: "\r\n\r\n") {
                    return String(request[r.upperBound...])
                }
                return ""
            }()
            let label = formField(body, "label")?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            if !label.isEmpty {
                fputs("[intercept] Label logged: \(label)\n", stderr)
            }
            session.incrementBlockAttempt()
            sendRedirect(fd, to: "/")
            return
        }

        sendBlockPage(fd)
    }

    private func parseRequestLine(_ request: String) -> (method: String, path: String) {
        guard let firstLine = request.components(separatedBy: "\r\n").first else { return ("GET", "/") }
        let parts = firstLine.split(separator: " ")
        guard parts.count >= 2 else { return ("GET", "/") }
        return (String(parts[0]), String(parts[1]))
    }

    private func parseContentLength(_ headers: String) -> Int? {
        for line in headers.components(separatedBy: "\r\n") {
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { continue }
            if parts[0].lowercased().trimmingCharacters(in: .whitespaces) == "content-length" {
                return Int(parts[1].trimmingCharacters(in: .whitespaces))
            }
        }
        return nil
    }

    private func formField(_ body: String, _ name: String) -> String? {
        for pair in body.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            guard kv.count == 2 else { continue }
            if String(kv[0]) == name {
                return String(kv[1]).removingPercentEncoding?.replacingOccurrences(of: "+", with: " ")
            }
        }
        return nil
    }

    private func sendRedirect(_ fd: Int32, to location: String) {
        let header = "HTTP/1.1 303 See Other\r\nLocation: \(location)\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        if let data = header.data(using: .utf8) {
            data.withUnsafeBytes { _ = write(fd, $0.baseAddress, $0.count) }
        }
    }

    private func sendBlockPage(_ fd: Int32) {
        let status = session.getStatus()
        let remaining = status.secondsRemaining ?? 0
        let mins = Int(remaining) / 60
        let secs = Int(remaining) % 60
        let timeStr = String(format: "%02d:%02d", mins, secs)
        let attempts = status.blockAttempts
        let attemptsLabel = attempts == 1 ? "1 block intercepted" : "\(attempts) blocks intercepted"
        let streak = status.currentStreak

        // Session name from profile lookup.
        var sessionName = "Custom session"
        if let pid = status.session?.profileId,
           let profile = profiles.getProfiles().first(where: { $0.id == pid }) {
            sessionName = profile.name
        }

        // Quote: user message overrides; else rotate every 14s for variety on auto-refresh.
        let quote: String
        let author: String?
        if let m = status.session?.motivationalMessage, !m.isEmpty {
            quote = m; author = nil
        } else {
            let slot = Int(Date().timeIntervalSince1970 / 14)
            let pick = quotes[abs(slot) % quotes.count]
            quote = pick.0; author = pick.1
        }

        let html = renderHtml(
            time: timeStr, attempts: attempts, attemptsLabel: attemptsLabel,
            streak: streak, sessionName: sessionName, quote: quote, author: author
        )

        let body = html.data(using: .utf8) ?? Data()
        let header = "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: \(body.count)\r\nConnection: close\r\n\r\n"
        let response = header.data(using: .utf8)! + body
        response.withUnsafeBytes { _ = write(fd, $0.baseAddress, $0.count) }
    }

    private func htmlEscape(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
         .replacingOccurrences(of: "<", with: "&lt;")
         .replacingOccurrences(of: ">", with: "&gt;")
         .replacingOccurrences(of: "\"", with: "&quot;")
         .replacingOccurrences(of: "'", with: "&#39;")
    }

    private func renderHtml(
        time: String, attempts: Int, attemptsLabel: String,
        streak: Int, sessionName: String, quote: String, author: String?
    ) -> String {
        let q = htmlEscape(quote)
        let s = htmlEscape(sessionName)
        let authorRow = author.map { "<p class=\"quote-author\">— \(htmlEscape($0))</p>" } ?? ""
        return """
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8"/>
          <meta http-equiv="refresh" content="14"/>
          <meta name="viewport" content="width=device-width,initial-scale=1"/>
          <title>Blocked — FocusLock</title>
          <link rel="preconnect" href="https://rsms.me/"/>
          <link rel="stylesheet" href="https://rsms.me/inter/inter.css"/>
          <style>
            *{box-sizing:border-box;margin:0;padding:0}
            :root{--bg:#0a0a0f;--surface:#13131a;--border:#1e1e2e;--text:#f8fafc;
              --muted:#94a3b8;--dim:#64748b;--faint:#475569;--accent:#6366f1;--warn:#f59e0b}
            body{background:var(--bg);color:var(--text);
              font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
              font-feature-settings:'cv11','ss01';letter-spacing:-0.01em;
              min-height:100vh;display:flex;align-items:center;justify-content:center;
              padding:2rem;-webkit-font-smoothing:antialiased}
            .ambient{position:fixed;inset:0;z-index:0;pointer-events:none;
              background:radial-gradient(800px 400px at 50% 0%,rgba(99,102,241,.18),transparent 70%),
              radial-gradient(600px 300px at 50% 100%,rgba(139,92,246,.12),transparent 70%)}
            .card{position:relative;z-index:1;width:100%;max-width:560px;text-align:center}
            .brand{display:inline-flex;align-items:center;gap:.4rem;
              font-size:.7rem;letter-spacing:.3em;text-transform:uppercase;
              color:var(--dim);font-weight:700;padding:.4rem .75rem;
              border:1px solid var(--border);border-radius:999px;margin-bottom:2rem}
            .brand-dot{width:6px;height:6px;border-radius:999px;background:var(--accent);
              box-shadow:0 0 12px rgba(99,102,241,.7);animation:pulse 2s ease-in-out infinite}
            @keyframes pulse{0%,100%{opacity:1}50%{opacity:.5}}
            .session-name{font-size:.875rem;color:var(--muted);margin-bottom:.5rem;font-weight:500}
            h1{font-size:2.25rem;font-weight:700;letter-spacing:-0.02em;margin-bottom:.5rem}
            .sub{color:var(--muted);font-size:.95rem;margin-bottom:2.5rem}
            .timer{font-family:'Inter',monospace;font-variant-numeric:tabular-nums;
              font-size:6rem;font-weight:700;letter-spacing:-0.04em;line-height:1;
              background:linear-gradient(180deg,#a5b4fc 0%,#6366f1 100%);
              -webkit-background-clip:text;-webkit-text-fill-color:transparent;
              background-clip:text;text-shadow:0 0 64px rgba(99,102,241,.4);margin-bottom:.4rem}
            .timer-label{font-size:.7rem;color:var(--faint);text-transform:uppercase;
              letter-spacing:.18em;font-weight:700;margin-bottom:2.5rem}
            .quote{background:linear-gradient(180deg,#15151e 0%,#121219 100%);
              border:1px solid var(--border);border-radius:16px;padding:1.75rem 1.5rem;
              box-shadow:inset 0 1px 0 rgba(255,255,255,.03),0 8px 32px -8px rgba(0,0,0,.6);
              margin-bottom:2rem}
            .quote-text{font-size:1.05rem;line-height:1.6;color:#e2e8f0;font-style:italic}
            .quote-author{margin-top:.75rem;font-size:.8rem;color:var(--dim);letter-spacing:.04em}
            .input-row{display:flex;gap:.5rem;background:#0f0f17;border:1px solid var(--border);
              border-radius:12px;padding:.4rem;margin-bottom:1.5rem;transition:border-color 160ms ease-out}
            .input-row:focus-within{border-color:var(--accent)}
            .input-row input{flex:1;background:transparent;border:none;outline:none;
              color:var(--text);font:inherit;font-size:.875rem;padding:.5rem .75rem}
            .input-row input::placeholder{color:var(--faint)}
            .input-row button{background:linear-gradient(180deg,#6366f1 0%,#5558e3 100%);
              color:#fff;border:none;border-radius:8px;padding:.5rem 1rem;
              font:inherit;font-size:.8rem;font-weight:600;cursor:pointer;transition:filter 160ms;
              box-shadow:inset 0 1px 0 rgba(255,255,255,.15)}
            .input-row button:hover{filter:brightness(1.1)}
            .meta{display:flex;align-items:center;justify-content:center;gap:1.5rem;
              padding-top:1.5rem;border-top:1px solid var(--border);
              color:var(--dim);font-size:.75rem}
            .meta-cell{display:flex;flex-direction:column;align-items:center;gap:.15rem}
            .meta-val{font-size:1.125rem;font-weight:700;
              font-variant-numeric:tabular-nums;color:var(--text)}
            .streak .meta-val{color:var(--warn)}
            .blocks .meta-val{color:#ef4444}
            .footer{margin-top:2rem;font-size:.65rem;color:#1e2433;
              letter-spacing:.35em;text-transform:uppercase;font-weight:700}
          </style>
        </head>
        <body>
          <div class="ambient"></div>
          <div class="card">
            <span class="brand"><span class="brand-dot"></span>FocusLock</span>
            <p class="session-name">\(s)</p>
            <h1>This site is blocked</h1>
            <p class="sub">Stay with what matters. It's all downhill from here.</p>
            <div class="timer">\(time)</div>
            <p class="timer-label">remaining in your session</p>
            <div class="quote">
              <p class="quote-text">"\(q)"</p>
              \(authorRow)
            </div>
            <form class="input-row" method="POST" action="/record-attempt">
              <input type="text" name="label" placeholder="What were you trying to do? (logged to daemon)" maxlength="120"/>
              <button type="submit">Log</button>
            </form>
            <div class="meta">
              <div class="meta-cell blocks">
                <span class="meta-val">\(attempts)</span>
                <span>\(attemptsLabel)</span>
              </div>
              <div class="meta-cell streak">
                <span class="meta-val">\(streak)d</span>
                <span>current streak</span>
              </div>
            </div>
            <p class="footer">Free · Open Source · GPL-3.0</p>
          </div>
        </body>
        </html>
        """
    }
}
