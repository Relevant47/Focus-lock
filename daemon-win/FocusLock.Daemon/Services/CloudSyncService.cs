using System.Diagnostics;
using System.Net.Http.Json;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using FocusLock.Daemon.Models;
using Microsoft.Extensions.Logging;

namespace FocusLock.Daemon.Services;

/// <summary>
/// Holds the long-lived WebSocket to the family server, applies push messages
/// to <see cref="FamilyEnforcementService"/>, and emits heartbeats every 60s.
///
/// Reconnects with exponential backoff up to ~30s on transport failures.
/// On reconnect the daemon pulls the current rule set via the REST snapshot
/// endpoint before re-opening the WS, so a missed push window can't leave the
/// cache stale.
///
/// Heartbeats carry both wall and monotonic timestamps. The wall clock is the
/// child's local <c>DateTime.UtcNow</c>; the monotonic value comes from
/// <see cref="Stopwatch"/> and is immune to clock jumps. Phase 2.4 will use
/// the divergence between the two to flag clock-tampered devices server-side.
/// </summary>
public sealed class CloudSyncService : BackgroundService
{
    private const string UserAgent = "FocusLock-Daemon/1.2.1";

    private static readonly TimeSpan HeartbeatInterval = TimeSpan.FromSeconds(60);
    private static readonly TimeSpan ReconnectMin      = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan ReconnectMax      = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan OfflineAuditThreshold = TimeSpan.FromMinutes(5);

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private readonly FamilyService _family;
    private readonly FamilyEnforcementService _enforce;
    private readonly ParentAuditService _audit;
    private readonly ILogger<CloudSyncService> _log;
    private readonly Stopwatch _bootClock = Stopwatch.StartNew();

    private CancellationTokenSource? _runCts;
    private Task? _runTask;
    private CancellationToken _stoppingToken;
    private DateTime? _lastConnectedAt;
    private DateTime? _lastDisconnectedAt;
    private volatile bool _connected;
    private string? _lastError;
    // Fires the family_offline_5min audit at most once per outage.
    private bool _outageAudited;

    public bool Connected            => _connected;
    public DateTime? LastConnectedAt => _lastConnectedAt;
    public DateTime? LastDisconnectedAt => _lastDisconnectedAt;
    public string? LastError         => _lastError;

    /// <summary>Seconds since the most recent successful WS connection. 0 while connected.</summary>
    public int OfflineSeconds
    {
        get
        {
            if (_connected) return 0;
            var anchor = _lastDisconnectedAt ?? _lastConnectedAt;
            if (anchor == null) return 0;
            var delta = DateTime.UtcNow - anchor.Value;
            return delta.TotalSeconds > 0 ? (int)delta.TotalSeconds : 0;
        }
    }

    public CloudSyncService(
        FamilyService family,
        FamilyEnforcementService enforce,
        ParentAuditService audit,
        ILogger<CloudSyncService> log)
    {
        _family  = family;
        _enforce = enforce;
        _audit   = audit;
        _log     = log;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _stoppingToken = stoppingToken;
        _family.ConfigChanged += OnFamilyConfigChanged;
        if (_family.IsPaired) RestartRunLoop();

        // Block until the host stops the service — work runs in the detached
        // _runTask which restarts whenever pairing state flips.
        try { await Task.Delay(Timeout.Infinite, stoppingToken).ConfigureAwait(false); }
        catch (OperationCanceledException) { /* expected on shutdown */ }
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        _family.ConfigChanged -= OnFamilyConfigChanged;
        try { _runCts?.Cancel(); } catch { /* ignore */ }
        if (_runTask != null)
        {
            try { await _runTask.ConfigureAwait(false); }
            catch { /* swallowed — best-effort shutdown */ }
        }
        await base.StopAsync(cancellationToken).ConfigureAwait(false);
    }

    private void OnFamilyConfigChanged(FamilyConfig? cfg)
    {
        try { _runCts?.Cancel(); } catch { /* ignore */ }
        if (cfg != null) RestartRunLoop();
        else
        {
            _enforce.Clear();
            _connected = false;
        }
    }

    private void RestartRunLoop()
    {
        var cts = CancellationTokenSource.CreateLinkedTokenSource(_stoppingToken);
        _runCts = cts;
        _runTask = Task.Run(() => RunLoopAsync(cts.Token), cts.Token);
    }

    // ── Connect / reconnect loop ───────────────────────────────────────────

    private async Task RunLoopAsync(CancellationToken ct)
    {
        var delay = ReconnectMin;
        while (!ct.IsCancellationRequested)
        {
            var cfg = _family.Current;
            if (cfg == null) return;

            try
            {
                await PullSnapshotAsync(cfg, ct).ConfigureAwait(false);
                await RunSessionAsync(cfg, ct).ConfigureAwait(false);
                delay = ReconnectMin;  // healthy close — restart fast
            }
            catch (OperationCanceledException) { return; }
            catch (Exception ex)
            {
                _lastError = ex.Message;
                _log.LogWarning(ex, "Cloud sync session ended with error — reconnecting in {Delay}", delay);
            }
            finally
            {
                _connected = false;
                _lastDisconnectedAt ??= DateTime.UtcNow;
            }

            // Fire a one-shot audit when an outage crosses the 5-minute mark.
            // Re-evaluated on every reconnect attempt — sleeps cap at 30s so
            // the alert lands within roughly half a minute of the threshold.
            MaybeAuditOutage();

            try { await Task.Delay(delay, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }

            delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, ReconnectMax.TotalMilliseconds));
        }
    }

    private void MaybeAuditOutage()
    {
        if (_outageAudited) return;
        var anchor = _lastDisconnectedAt;
        if (anchor == null) return;
        if (DateTime.UtcNow - anchor.Value < OfflineAuditThreshold) return;
        _outageAudited = true;
        _audit.Record(ParentAuditEvents.FamilyOffline5Min,
            detail: $"offlineSince={anchor.Value:O}");
        _log.LogWarning("Family device offline > 5min since {Since}", anchor);
    }

    private async Task PullSnapshotAsync(FamilyConfig cfg, CancellationToken ct)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        http.DefaultRequestHeaders.Authorization =
            new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", cfg.DeviceToken);
        http.DefaultRequestHeaders.UserAgent.ParseAdd(UserAgent);

        HttpResponseMessage resp;
        try { resp = await http.GetAsync($"{cfg.ServerUrl}/api/v1/device/rules", ct).ConfigureAwait(false); }
        catch (Exception ex)
        {
            _lastError = ex.Message;
            throw;
        }

        if (resp.StatusCode == System.Net.HttpStatusCode.Unauthorized)
        {
            _log.LogWarning("Device token rejected by server — clearing local pairing");
            _family.ClearLocal();
            throw new OperationCanceledException("device unauthorized");
        }

        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadFromJsonAsync<RulesEnvelope>(JsonOpts, ct).ConfigureAwait(false);
        _enforce.Replace(body?.Rules ?? new List<CloudRule>());
    }

    private async Task RunSessionAsync(FamilyConfig cfg, CancellationToken ct)
    {
        using var ws = new ClientWebSocket();
        ws.Options.SetRequestHeader("Authorization", $"Bearer {cfg.DeviceToken}");
        ws.Options.SetRequestHeader("User-Agent", UserAgent);
        ws.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);

        var wsUri = ToWsUri($"{cfg.ServerUrl}/api/v1/device/ws");
        _log.LogInformation("Cloud sync: connecting to {Url}", wsUri);

        try { await ws.ConnectAsync(wsUri, ct).ConfigureAwait(false); }
        catch (WebSocketException wse) when (wse.WebSocketErrorCode == WebSocketError.NotAWebSocket
            // 401 / 403 from the upgrade arrive here as InvalidResponse.
            || wse.WebSocketErrorCode == WebSocketError.HeaderError)
        {
            _log.LogWarning(wse, "WS upgrade rejected — clearing local pairing");
            _family.ClearLocal();
            throw new OperationCanceledException("device unauthorized");
        }

        bool wasOffline    = _outageAudited;
        _connected         = true;
        _lastConnectedAt   = DateTime.UtcNow;
        _lastDisconnectedAt = null;
        _lastError         = null;
        _outageAudited     = false;
        if (wasOffline)
        {
            _audit.Record(ParentAuditEvents.FamilyReconnected);
            _log.LogInformation("Family device reconnected after extended outage");
        }

        // Run heartbeat + read loop concurrently, fail-fast on whichever ends first.
        using var sessionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var hbTask   = HeartbeatLoopAsync(ws, sessionCts.Token);
        var readTask = ReadLoopAsync(ws, sessionCts.Token);

        var done = await Task.WhenAny(hbTask, readTask).ConfigureAwait(false);
        sessionCts.Cancel();

        try { await done.ConfigureAwait(false); } catch { /* surfaced by RunLoopAsync */ }
        try { await Task.WhenAll(hbTask, readTask).ConfigureAwait(false); } catch { /* ignore */ }

        try
        {
            if (ws.State == WebSocketState.Open)
                await ws.CloseAsync(WebSocketCloseStatus.NormalClosure, "client shutdown", CancellationToken.None)
                    .ConfigureAwait(false);
        }
        catch { /* ignore */ }
    }

    private async Task HeartbeatLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            var payload = new
            {
                type = "heartbeat",
                wall = DateTime.UtcNow.ToString("O"),
                mono = _bootClock.ElapsedMilliseconds,
            };
            var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(payload, JsonOpts));
            await ws.SendAsync(bytes, WebSocketMessageType.Text, true, ct).ConfigureAwait(false);

            try { await Task.Delay(HeartbeatInterval, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }
        }
    }

    private async Task ReadLoopAsync(ClientWebSocket ws, CancellationToken ct)
    {
        var buffer = new byte[8 * 1024];
        var pending = new MemoryStream();
        while (!ct.IsCancellationRequested && ws.State == WebSocketState.Open)
        {
            WebSocketReceiveResult result;
            try { result = await ws.ReceiveAsync(buffer, ct).ConfigureAwait(false); }
            catch (OperationCanceledException) { return; }

            if (result.MessageType == WebSocketMessageType.Close) return;

            pending.Write(buffer, 0, result.Count);
            if (!result.EndOfMessage) continue;

            var text = Encoding.UTF8.GetString(pending.GetBuffer(), 0, (int)pending.Length);
            pending.SetLength(0);
            HandleMessage(text);
        }
    }

    private void HandleMessage(string text)
    {
        CloudMessage? msg;
        try { msg = JsonSerializer.Deserialize<CloudMessage>(text, JsonOpts); }
        catch (Exception ex)
        {
            _log.LogDebug(ex, "Ignoring malformed cloud message");
            return;
        }
        if (msg == null) return;

        switch (msg.Type)
        {
            case "ack":
                // Server replies to our heartbeat; nothing else to do.
                break;

            case "rule_change":
                if (msg.Rule != null) _enforce.Upsert(msg.Rule);
                break;

            case "rule_delete":
                if (!string.IsNullOrEmpty(msg.RuleId)) _enforce.Remove(msg.RuleId);
                break;

            case "unpair":
                _log.LogWarning("Server requested unpair — clearing local pairing");
                _family.ClearLocal();
                break;

            default:
                _log.LogDebug("Unknown cloud message type: {Type}", msg.Type);
                break;
        }
    }

    private static Uri ToWsUri(string httpUrl)
    {
        if (httpUrl.StartsWith("https://", StringComparison.OrdinalIgnoreCase))
            return new Uri("wss://" + httpUrl.Substring("https://".Length));
        if (httpUrl.StartsWith("http://", StringComparison.OrdinalIgnoreCase))
            return new Uri("ws://" + httpUrl.Substring("http://".Length));
        return new Uri(httpUrl);
    }

    private sealed class RulesEnvelope
    {
        public List<CloudRule>? Rules { get; set; }
    }
}
