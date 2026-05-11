using System.Net;
using System.Text;
using FocusLock.Daemon.Models;
using FocusLock.Daemon.Services;

namespace FocusLock.Daemon;

public sealed class InterceptHttpService : BackgroundService
{
    private static readonly string[] Quotes =
    [
        "You said you'd finish. Honour that promise.",
        "Every minute you hold is a vote for the person you're becoming.",
        "The obstacle is the way. — Marcus Aurelius",
        "Discipline is choosing between what you want now and what you want most.",
        "You don't have to be great to start, but you have to start to be great.",
        "Focus is the art of knowing what to ignore.",
        "He who cannot obey himself will be commanded. — Nietzsche",
        "Small disciplines repeated with consistency every day lead to great achievements.",
        "The successful warrior is the average man with laser-like focus. — Bruce Lee",
        "You have power over your mind, not outside events. — Marcus Aurelius",
        "Do the hard thing first. Everything else gets easier.",
        "Deep work is the superpower of the 21st century.",
        "Distraction is the enemy of vision.",
        "One hour of focused work beats three hours of half-attention.",
        "Winning is not a sometime thing; it's an all the time thing. — Vince Lombardi",
        "The cost of distraction is paid in the currency of your dreams.",
        "Suffer the pain of discipline or suffer the pain of regret.",
        "Clarity comes from engagement, not thought.",
        "What you do right now is what matters most.",
        "Be so good they can't ignore you. — Cal Newport",
    ];

    private readonly SessionService _session;
    private readonly ILogger<InterceptHttpService> _log;
    private static readonly Random Rng = new();

    public InterceptHttpService(SessionService session, ILogger<InterceptHttpService> log)
    {
        _session = session;
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
                _ = Task.Run(() => Respond(ctx, _session.GetStatus()), CancellationToken.None);
            }
            catch (OperationCanceledException) { break; }
            catch (HttpListenerException) { break; }
            catch (Exception ex) { _log.LogDebug(ex, "Intercept request error"); }
        }
        listener.Stop();
    }

    private static void Respond(HttpListenerContext ctx, DaemonStatus status)
    {
        try
        {
            var remaining = status.SecondsRemaining ?? 0;
            var mins = (int)(remaining / 60);
            var secs = (int)(remaining % 60);
            var timeStr = $"{mins:D2}:{secs:D2}";
            var attempts = status.BlockAttempts;
            var attemptsLabel = attempts == 1 ? "1 block intercepted" : $"{attempts} blocks intercepted";
            var message = !string.IsNullOrWhiteSpace(status.Session?.MotivationalMessage)
                ? System.Web.HttpUtility.HtmlEncode(status.Session.MotivationalMessage)
                : Quotes[Rng.Next(Quotes.Length)];

            var html = $$$"""
                <!DOCTYPE html>
                <html lang="en">
                <head>
                  <meta charset="UTF-8"/>
                  <meta http-equiv="refresh" content="10"/>
                  <meta name="viewport" content="width=device-width,initial-scale=1"/>
                  <title>Blocked — FocusLock</title>
                  <style>
                    *{box-sizing:border-box;margin:0;padding:0}
                    body{
                      background:#030712;color:#f9fafb;
                      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
                      min-height:100vh;display:flex;align-items:center;
                      justify-content:center;padding:2rem;
                    }
                    .card{max-width:480px;width:100%;text-align:center}
                    .icon{font-size:3rem;margin-bottom:1.5rem;display:block;
                      filter:drop-shadow(0 0 32px rgba(99,102,241,.6));animation:float 3s ease-in-out infinite}
                    @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-8px)}}
                    h1{font-size:1.5rem;font-weight:700;margin-bottom:.4rem}
                    .sub{color:#6b7280;font-size:.875rem;margin-bottom:2rem}
                    .timer{
                      font-size:4.5rem;font-family:ui-monospace,monospace;font-weight:700;
                      color:#6366f1;letter-spacing:.05em;margin-bottom:.25rem;
                      text-shadow:0 0 48px rgba(99,102,241,.5)
                    }
                    .timer-label{font-size:.7rem;color:#4b5563;text-transform:uppercase;
                      letter-spacing:.1em;margin-bottom:2rem}
                    .track{height:4px;background:#1f2937;border-radius:999px;overflow:hidden;margin-bottom:2rem}
                    .bar{height:100%;background:linear-gradient(90deg,#4f46e5,#818cf8);
                      border-radius:999px;animation:pulse 2s ease-in-out infinite alternate}
                    @keyframes pulse{to{opacity:.5}}
                    .message{
                      font-size:1.15rem;color:#e2e8f0;line-height:1.7;font-style:italic;
                      padding:1.5rem;background:#0f172a;border:1px solid #1e293b;
                      border-radius:.75rem;margin-bottom:1.5rem;
                      box-shadow:0 0 0 1px rgba(99,102,241,.1) inset
                    }
                    .attempts{font-size:.75rem;color:#374151}
                    .brand{margin-top:2.5rem;font-size:.65rem;color:#1e2433;
                      letter-spacing:.3em;text-transform:uppercase;font-weight:700}
                  </style>
                </head>
                <body>
                  <div class="card">
                    <span class="icon">🔒</span>
                    <h1>This site is blocked</h1>
                    <p class="sub">FocusLock is keeping you on track</p>
                    <div class="timer">{{{timeStr}}}</div>
                    <div class="timer-label">remaining in your session</div>
                    <div class="track"><div class="bar"></div></div>
                    <div class="message">{{{message}}}</div>
                    <p class="attempts">{{{attemptsLabel}}} this session</p>
                    <p class="brand">FocusLock</p>
                  </div>
                </body>
                </html>
                """;

            var bytes = Encoding.UTF8.GetBytes(html);
            ctx.Response.ContentType = "text/html; charset=utf-8";
            ctx.Response.ContentLength64 = bytes.Length;
            ctx.Response.OutputStream.Write(bytes);
        }
        catch { }
        finally { try { ctx.Response.Close(); } catch { } }
    }
}
