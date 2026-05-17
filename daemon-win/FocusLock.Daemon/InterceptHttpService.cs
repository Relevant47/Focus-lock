using System.Net;
using System.Text;
using System.Web;
using FocusLock.Daemon.Models;
using FocusLock.Daemon.Services;

namespace FocusLock.Daemon;

public sealed class InterceptHttpService : BackgroundService
{
    private static readonly (string Text, string? Author)[] Quotes =
    [
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
        ("You said you'd finish the chapter first. Honour that promise to yourself.", null),
        ("Every minute you hold is a vote for the person you're becoming.", null),
        ("Small disciplines repeated with consistency every day lead to great achievements.", "John C. Maxwell"),
        ("Clarity comes from engagement, not thought.", "Marie Forleo"),
        ("Concentration is the secret of strength.", "Ralph Waldo Emerson"),
        ("The cost of distraction is paid in the currency of your dreams.", null),
        ("Do the hard thing first. Everything after gets easier.", null),
        ("One hour of focused work beats three of half-attention.", null),
        ("Where focus goes, energy flows.", "Tony Robbins"),
        ("Champions keep playing until they get it right.", "Billie Jean King"),
    ];

    private readonly SessionService _session;
    private readonly ProfileService _profiles;
    private readonly ILogger<InterceptHttpService> _log;

    public InterceptHttpService(SessionService session, ProfileService profiles, ILogger<InterceptHttpService> log)
    {
        _session = session;
        _profiles = profiles;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        var listener = new HttpListener();
        listener.Prefixes.Add("http://+:80/");
        try
        {
            listener.Start();
            _log.LogInformation("Intercept HTTP server listening on port 80");
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Could not bind to port 80 — intercept page disabled");
            return;
        }

        while (!ct.IsCancellationRequested)
        {
            HttpListenerContext? ctx = null;
            try
            {
                ctx = await Task.Run(listener.GetContext, ct);
                _ = Task.Run(() => Handle(ctx), CancellationToken.None);
            }
            catch (OperationCanceledException) { break; }
            catch (HttpListenerException) { break; }
            catch (Exception ex) { _log.LogDebug(ex, "Intercept request error"); }
        }
        listener.Stop();
    }

    private void Handle(HttpListenerContext ctx)
    {
        try
        {
            // POST /record-attempt — log the user's "what were you trying to do?" label.
            if (ctx.Request.HttpMethod == "POST" &&
                ctx.Request.Url is { AbsolutePath: "/record-attempt" })
            {
                HandleRecordAttempt(ctx);
                return;
            }
            // Default: serve the block page.
            RespondBlockPage(ctx);
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Intercept handler error");
        }
        finally
        {
            try { ctx.Response.Close(); } catch { /* ignore */ }
        }
    }

    private void HandleRecordAttempt(HttpListenerContext ctx)
    {
        try
        {
            string? label = null;
            if (ctx.Request.HasEntityBody)
            {
                using var reader = new StreamReader(ctx.Request.InputStream, ctx.Request.ContentEncoding);
                var body = reader.ReadToEnd();
                // Body is application/x-www-form-urlencoded: label=...
                var parsed = HttpUtility.ParseQueryString(body);
                label = parsed["label"]?.Trim();
            }
            if (!string.IsNullOrWhiteSpace(label))
            {
                _log.LogInformation("Intercept label logged: {Label}", label);
            }
            _session.IncrementBlockAttempt();
        }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Failed to record attempt");
        }
        // Redirect back to the block page so the browser refreshes with the latest state.
        ctx.Response.StatusCode = 303;
        ctx.Response.Headers["Location"] = "/";
    }

    private void RespondBlockPage(HttpListenerContext ctx)
    {
        var status = _session.GetStatus();
        var remaining = status.SecondsRemaining ?? 0;
        var mins = (int)(remaining / 60);
        var secs = (int)(remaining % 60);
        var timeStr = $"{mins:D2}:{secs:D2}";

        var attempts = status.BlockAttempts;
        var streak = status.CurrentStreak;

        // Session name: from profile lookup, or "Custom session".
        var sessionName = "Custom session";
        if (status.Session?.ProfileId is { } pid)
        {
            var profile = _profiles.GetAll().FirstOrDefault(p => p.Id == pid);
            if (profile != null) sessionName = profile.Name;
        }

        // Pick the quote: user message overrides, else rotate from pool.
        string quote;
        string? author;
        if (!string.IsNullOrWhiteSpace(status.Session?.MotivationalMessage))
        {
            quote = status.Session.MotivationalMessage;
            author = null;
        }
        else
        {
            // Rotate every ~14 seconds so the auto-refresh shows a fresh one.
            var slot = (int)(DateTimeOffset.UtcNow.ToUnixTimeSeconds() / 14);
            var pick = Quotes[Math.Abs(slot) % Quotes.Length];
            quote = pick.Text;
            author = pick.Author;
        }

        var html = RenderHtml(timeStr, attempts, streak, sessionName, quote, author);

        var bytes = Encoding.UTF8.GetBytes(html);
        ctx.Response.ContentType = "text/html; charset=utf-8";
        ctx.Response.ContentLength64 = bytes.Length;
        ctx.Response.OutputStream.Write(bytes);
    }

    private static string RenderHtml(string timeStr, int attempts, int streak, string sessionName, string quote, string? author)
    {
        var qEnc = HttpUtility.HtmlEncode(quote);
        var aEnc = HttpUtility.HtmlEncode(author ?? string.Empty);
        var sEnc = HttpUtility.HtmlEncode(sessionName);
        var attemptsLabel = attempts == 1 ? "1 block intercepted" : $"{attempts} blocks intercepted";
        var authorRow = string.IsNullOrEmpty(author) ? string.Empty : $"<p class=\"quote-author\">— {aEnc}</p>";

        return $$$"""
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
                <p class="session-name">{{{sEnc}}}</p>
                <h1>This site is blocked</h1>
                <p class="sub">Stay with what matters. It's all downhill from here.</p>
                <div class="timer">{{{timeStr}}}</div>
                <p class="timer-label">remaining in your session</p>
                <div class="quote">
                  <p class="quote-text">"{{{qEnc}}}"</p>
                  {{{authorRow}}}
                </div>
                <form class="input-row" method="POST" action="/record-attempt">
                  <input type="text" name="label" placeholder="What were you trying to do? (logged to daemon)" maxlength="120"/>
                  <button type="submit">Log</button>
                </form>
                <div class="meta">
                  <div class="meta-cell blocks">
                    <span class="meta-val">{{{attempts}}}</span>
                    <span>{{{attemptsLabel}}}</span>
                  </div>
                  <div class="meta-cell streak">
                    <span class="meta-val">{{{streak}}}d</span>
                    <span>current streak</span>
                  </div>
                </div>
                <p class="footer">Free · Open Source · GPL-3.0</p>
              </div>
            </body>
            </html>
            """;
    }
}
