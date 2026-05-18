using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using FocusLock.Daemon.Models;
using FocusLock.Daemon.Services;

namespace FocusLock.Daemon;

public sealed class IpcPipeService : BackgroundService
{
    public const string PipeName = "focuslock";

    private static readonly JsonSerializerOptions JsonOpts = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = true,
    };

    private readonly SessionService _session;
    private readonly ProfileService _profiles;
    private readonly ILogger<IpcPipeService> _log;

    public IpcPipeService(
        SessionService session,
        ProfileService profiles,
        ILogger<IpcPipeService> log)
    {
        _session = session;
        _profiles = profiles;
        _log = log;
    }

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        _log.LogInformation("IPC pipe listening on \\\\.\\pipe\\{Name}", PipeName);

        while (!ct.IsCancellationRequested)
        {
            try
            {
                var pipe = CreatePipe();
                await pipe.WaitForConnectionAsync(ct).ConfigureAwait(false);
                _ = Task.Run(() => HandleClientAsync(pipe, ct), ct);
            }
            catch (OperationCanceledException) { break; }
            catch (Exception ex)
            {
                _log.LogError(ex, "Named pipe listener error");
                await Task.Delay(1000, ct).ConfigureAwait(false);
            }
        }
    }

    private static NamedPipeServerStream CreatePipe()
    {
        // Preferred path (production, daemon running as SYSTEM): explicit DACL
        // that grants SYSTEM full control + AuthenticatedUsers ReadWrite, so any
        // local user's UI app can connect.
        //
        // Setting a custom DACL via NamedPipeServerStreamAcl.Create requires
        // SeSecurityPrivilege to be enabled in the calling process token. SYSTEM
        // has this enabled by default; an interactive admin user has the privilege
        // but it's disabled by default, so the call fails with UnauthorizedAccess.
        // Fall back to a default-security pipe in that case so diagnostic runs of
        // the daemon (i.e. launched manually as a user) still serve the IPC.
        try
        {
            var security = new PipeSecurity();
            security.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                PipeAccessRights.FullControl,
                AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(
                new SecurityIdentifier(WellKnownSidType.AuthenticatedUserSid, null),
                PipeAccessRights.ReadWrite,
                AccessControlType.Allow));

            return NamedPipeServerStreamAcl.Create(
                PipeName,
                PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                0, 0, security);
        }
        catch (UnauthorizedAccessException)
        {
            // Caller doesn't have SeSecurityPrivilege enabled — fall back to
            // default pipe security. The pipe is still accessible by the same
            // local users (default DACL is permissive enough for our use).
            return new NamedPipeServerStream(
                PipeName,
                PipeDirection.InOut,
                NamedPipeServerStream.MaxAllowedServerInstances,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);
        }
    }

    private async Task HandleClientAsync(NamedPipeServerStream pipe, CancellationToken ct)
    {
        await using (pipe)
        {
            using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
            await using var writer = new StreamWriter(pipe, new UTF8Encoding(false)) { AutoFlush = true };

            try
            {
                string? line;
                while ((line = await reader.ReadLineAsync(ct).ConfigureAwait(false)) != null)
                {
                    var request = JsonSerializer.Deserialize<IpcRequest>(line, JsonOpts);
                    if (request == null) continue;

                    var response = Handle(request);
                    await writer.WriteLineAsync(
                        JsonSerializer.Serialize(response, JsonOpts).AsMemory(), ct)
                        .ConfigureAwait(false);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                _log.LogDebug(ex, "Client disconnected");
            }
        }
    }

    private IpcResponse Handle(IpcRequest req)
    {
        try
        {
            return req.Type switch
            {
                "ping"                     => IpcResponse.Pong(),
                "get_status"               => IpcResponse.Status(_session.GetStatus()),
                "start_session"            => HandleStartSession(req),
                "stop_session"             => HandleStopSession(req),
                "skip_break"               => HandleSkipBreak(),
                "request_disable_hardcore" => HandleRequestDisableHardcore(),
                "get_profiles"             => IpcResponse.Profiles(_profiles.GetAll()),
                "save_profile"             => HandleSaveProfile(req),
                "delete_profile"           => HandleDeleteProfile(req),
                "get_logs"                 => HandleGetLogs(req),
                "get_schedules"            => IpcResponse.Schedules(_profiles.GetSchedules()),
                "save_schedule"            => HandleSaveSchedule(req),
                "delete_schedule"          => HandleDeleteSchedule(req),
                "record_block_attempt"     => HandleRecordBlockAttempt(req),
                _ => IpcResponse.Error($"Unknown request type: {req.Type}"),
            };
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Error handling IPC request {Type}", req.Type);
            return IpcResponse.Error(ex.Message);
        }
    }

    private IpcResponse HandleStartSession(IpcRequest req)
    {
        var payload = Deserialize<StartSessionPayload>(req.Payload);
        if (payload == null) return IpcResponse.Error("Invalid payload");
        var (err, ok) = _session.StartSession(payload);
        return ok ? IpcResponse.Ok() : IpcResponse.Error(err);
    }

    private IpcResponse HandleStopSession(IpcRequest req)
    {
        var payload = Deserialize<StopSessionPayload>(req.Payload);
        var (err, ok) = _session.StopSession(payload?.UnlockToken);
        return ok ? IpcResponse.Ok() : IpcResponse.Error(err);
    }

    private IpcResponse HandleSaveProfile(IpcRequest req)
    {
        var profile = Deserialize<FocusProfile>(req.Payload);
        if (profile == null) return IpcResponse.Error("Invalid payload");
        _profiles.SaveProfile(profile);
        return IpcResponse.Ok();
    }

    private IpcResponse HandleDeleteProfile(IpcRequest req)
    {
        var id = req.Payload?.GetProperty("id").GetString();
        if (string.IsNullOrEmpty(id)) return IpcResponse.Error("Missing id");
        _profiles.DeleteProfile(id);
        return IpcResponse.Ok();
    }

    private IpcResponse HandleGetLogs(IpcRequest req)
    {
        int limit = 50;
        if (req.Payload.HasValue &&
            req.Payload.Value.TryGetProperty("limit", out var lv))
            limit = lv.GetInt32();
        return IpcResponse.Logs(_session.GetLogs(limit));
    }

    private IpcResponse HandleSaveSchedule(IpcRequest req)
    {
        var schedule = Deserialize<ScheduledSession>(req.Payload);
        if (schedule == null) return IpcResponse.Error("Invalid payload");
        _profiles.SaveSchedule(schedule);
        return IpcResponse.Ok();
    }

    private IpcResponse HandleDeleteSchedule(IpcRequest req)
    {
        var id = req.Payload?.GetProperty("id").GetString();
        if (string.IsNullOrEmpty(id)) return IpcResponse.Error("Missing id");
        _profiles.DeleteSchedule(id);
        return IpcResponse.Ok();
    }

    private IpcResponse HandleSkipBreak()
    {
        var (err, ok) = _session.SkipBreak();
        return ok ? IpcResponse.Ok() : IpcResponse.Error(err);
    }

    private IpcResponse HandleRequestDisableHardcore()
    {
        var (err, ok) = _session.RequestDisableHardcore();
        return ok ? IpcResponse.Ok() : IpcResponse.Error(err);
    }

    private IpcResponse HandleRecordBlockAttempt(IpcRequest req)
    {
        var payload = Deserialize<RecordBlockAttemptPayload>(req.Payload);
        var label = payload?.Label;
        if (!string.IsNullOrWhiteSpace(label))
            _log.LogInformation("Block attempt logged with label: {Label}", label);
        _session.IncrementBlockAttempt();
        return IpcResponse.Ok();
    }

    private static T? Deserialize<T>(JsonElement? element)
    {
        if (element == null) return default;
        return JsonSerializer.Deserialize<T>(element.Value.GetRawText(), JsonOpts);
    }
}
