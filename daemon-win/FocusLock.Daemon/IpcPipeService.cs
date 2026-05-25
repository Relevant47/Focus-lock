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
    private readonly ParentService _parent;
    private readonly ParentAuditService _audit;
    private readonly FamilyService _family;
    private readonly FamilyEnforcementService _familyEnforce;
    private readonly CloudSyncService _cloudSync;
    private readonly EnvironmentProbe _envProbe;
    private readonly FirewallLockdownService _firewallLockdown;
    private readonly ILogger<IpcPipeService> _log;

    public IpcPipeService(
        SessionService session,
        ProfileService profiles,
        ParentService parent,
        ParentAuditService audit,
        FamilyService family,
        FamilyEnforcementService familyEnforce,
        CloudSyncService cloudSync,
        EnvironmentProbe envProbe,
        FirewallLockdownService firewallLockdown,
        ILogger<IpcPipeService> log)
    {
        _session = session;
        _profiles = profiles;
        _parent = parent;
        _audit = audit;
        _family = family;
        _familyEnforce = familyEnforce;
        _cloudSync = cloudSync;
        _envProbe = envProbe;
        _firewallLockdown = firewallLockdown;
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
                "get_status"               => IpcResponse.Status(BuildStatus()),
                "start_session"            => HandleStartSession(req),
                "stop_session"             => HandleStopSession(req),
                "skip_break"               => HandleSkipBreak(),
                "request_disable_hardcore" => HandleRequestDisableHardcore(req),
                "get_profiles"             => IpcResponse.Profiles(_profiles.GetAll()),
                "save_profile"             => HandleSaveProfile(req),
                "delete_profile"           => HandleDeleteProfile(req),
                "get_logs"                 => HandleGetLogs(req),
                "get_schedules"            => IpcResponse.Schedules(_profiles.GetSchedules()),
                "save_schedule"            => HandleSaveSchedule(req),
                "delete_schedule"          => HandleDeleteSchedule(req),
                "record_block_attempt"     => HandleRecordBlockAttempt(req),
                "set_parent_pin"           => HandleSetParentPin(req),
                "verify_parent_pin"        => HandleVerifyParentPin(req),
                "change_parent_pin"        => HandleChangeParentPin(req),
                "clear_parent_pin"         => HandleClearParentPin(req),
                "verify_recovery_key"      => HandleVerifyRecoveryKey(req),
                "regenerate_recovery_key"  => HandleRegenerateRecoveryKey(req),
                "get_parent_audit"         => HandleGetParentAudit(req),
                "family_redeem_code"       => HandleFamilyRedeem(req).GetAwaiter().GetResult(),
                "family_unpair"            => HandleFamilyUnpair(req),
                "family_get_status"        => IpcResponse.FamilyStatus(BuildFamilyStatus()),
                "family_check_environment" => IpcResponse.FamilyEnvironment(_envProbe.Probe()),
                "family_authorize_uninstall" => HandleAuthorizeUninstall(req),
                "family_set_firewall_lockdown" => HandleSetFirewallLockdown(req),
                _ => IpcResponse.Error($"Unknown request type: {req.Type}"),
            };
        }
        catch (Exception ex)
        {
            _log.LogError(ex, "Error handling IPC request {Type}", req.Type);
            return IpcResponse.Error(ex.Message);
        }
    }

    // ── Status overlay ──────────────────────────────────────────────────────

    private DaemonStatus BuildStatus()
    {
        var status = _session.GetStatus();
        status.Version = System.Reflection.Assembly.GetExecutingAssembly()
            .GetName().Version?.ToString(3) ?? status.Version;
        status.ParentControls = new ParentControlsState
        {
            Enabled = _parent.IsEnabled,
            RateLimited = _parent.IsRateLimited,
            RetryAfterSeconds = _parent.RetryAfterSeconds,
            GraceMinutes = _parent.GraceMinutes,
        };
        status.Family = BuildFamilyStatus();
        return status;
    }

    private FamilyStatus BuildFamilyStatus()
    {
        var cfg = _family.Current;
        var snapshot = _familyEnforce.Snapshot();
        return new FamilyStatus
        {
            Paired              = cfg != null,
            Connected           = _cloudSync.Connected,
            AccountId           = cfg?.AccountId,
            DeviceId            = cfg?.DeviceId,
            ServerUrl           = cfg?.ServerUrl,
            LastConnectedAt     = _cloudSync.LastConnectedAt?.ToString("O"),
            LastDisconnectedAt  = _cloudSync.LastDisconnectedAt?.ToString("O"),
            LastError           = _cloudSync.LastError,
            ActiveRuleCount     = snapshot.Count,
            OfflineSeconds      = _cloudSync.OfflineSeconds,
            ActiveRules         = snapshot.ToList(),
            FirewallLockdownEnabled = cfg?.FirewallLockdownEnabled ?? false,
            FirewallLockdownActive  = _firewallLockdown.IsLocked,
        };
    }

    // ── Parental control gate ──────────────────────────────────────────────

    private IpcResponse? GateOrNull(IpcRequest req)
    {
        if (!_parent.IsEnabled) return null;
        var token = ExtractParentToken(req.Payload);
        if (_parent.IsAuthorized(token))
        {
            // Token-authorized passage through the gate: audit it. (Implicit
            // pass when no PIN is configured is not audited — there is no gate.)
            _audit.Record(ParentAuditEvents.GateAllowed, command: req.Type);
            return null;
        }
        _audit.Record(ParentAuditEvents.GateBlocked, command: req.Type);
        return IpcResponse.Error(
            "Parent PIN required to perform this action",
            ErrorCode.ParentLockRequired.ToWireString());
    }

    private static string? ExtractParentToken(JsonElement? payload)
    {
        if (payload == null) return null;
        if (!payload.Value.TryGetProperty("parentToken", out var tok)) return null;
        return tok.ValueKind == JsonValueKind.String ? tok.GetString() : null;
    }

    // ── Handlers ───────────────────────────────────────────────────────────

    private IpcResponse HandleStartSession(IpcRequest req)
    {
        var payload = Deserialize<StartSessionPayload>(req.Payload);
        if (payload == null) return IpcResponse.Error("Invalid payload");
        var (err, ok) = _session.StartSession(payload);
        return ok ? IpcResponse.Ok() : IpcResponse.Error(err);
    }

    private IpcResponse HandleStopSession(IpcRequest req)
    {
        // Parental gate: when a parent PIN is set, stopping early requires the parent token,
        // in addition to any friend-lock token the session already enforces.
        var gate = GateOrNull(req);
        if (gate != null) return gate;

        var payload = Deserialize<StopSessionPayload>(req.Payload);
        var (err, ok) = _session.StopSession(payload?.UnlockToken);
        return ok ? IpcResponse.Ok() : IpcResponse.Error(err);
    }

    private IpcResponse HandleSaveProfile(IpcRequest req)
    {
        var gate = GateOrNull(req);
        if (gate != null) return gate;

        var profile = Deserialize<FocusProfile>(req.Payload);
        if (profile == null) return IpcResponse.Error("Invalid payload");
        _profiles.SaveProfile(profile);
        return IpcResponse.Ok();
    }

    private IpcResponse HandleDeleteProfile(IpcRequest req)
    {
        var gate = GateOrNull(req);
        if (gate != null) return gate;

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
        var gate = GateOrNull(req);
        if (gate != null) return gate;

        var schedule = Deserialize<ScheduledSession>(req.Payload);
        if (schedule == null) return IpcResponse.Error("Invalid payload");
        _profiles.SaveSchedule(schedule);
        return IpcResponse.Ok();
    }

    private IpcResponse HandleDeleteSchedule(IpcRequest req)
    {
        var gate = GateOrNull(req);
        if (gate != null) return gate;

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

    private IpcResponse HandleRequestDisableHardcore(IpcRequest req)
    {
        var gate = GateOrNull(req);
        if (gate != null) return gate;

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

    private IpcResponse HandleSetParentPin(IpcRequest req)
    {
        var payload = Deserialize<SetParentPinPayload>(req.Payload);
        if (payload == null || string.IsNullOrEmpty(payload.Pin))
            return IpcResponse.Error("Invalid payload");
        var (err, code, ok, recoveryKey) = _parent.SetPin(payload.Pin, payload.OldPin);
        if (!ok) return code.HasValue ? IpcResponse.Error(err, code.Value.ToWireString()) : IpcResponse.Error(err);
        // On first setup we return the freshly-generated recovery key one time.
        // On change, the existing key is preserved and the response is a plain Ok.
        return recoveryKey != null ? IpcResponse.OkWithRecoveryKey(recoveryKey) : IpcResponse.Ok();
    }

    private IpcResponse HandleVerifyParentPin(IpcRequest req)
    {
        var payload = Deserialize<VerifyParentPinPayload>(req.Payload);
        if (payload == null || string.IsNullOrEmpty(payload.Pin))
            return IpcResponse.Error("Invalid payload");
        var (err, code, token, expiresAt) = _parent.VerifyPin(payload.Pin);
        if (token == null)
            return code.HasValue ? IpcResponse.Error(err, code.Value.ToWireString()) : IpcResponse.Error(err);
        return IpcResponse.ParentToken(new ParentTokenResponsePayload
        {
            Token = token,
            ExpiresAt = expiresAt.ToString("O"),
        });
    }

    private IpcResponse HandleChangeParentPin(IpcRequest req)
    {
        var payload = Deserialize<ChangeParentPinPayload>(req.Payload);
        if (payload == null || string.IsNullOrEmpty(payload.NewPin))
            return IpcResponse.Error("Invalid payload");
        var (err, code, ok, _) = _parent.SetPin(payload.NewPin, payload.OldPin);
        // Change preserves the existing recovery key, so no key is returned here.
        return ok ? IpcResponse.Ok()
            : code.HasValue ? IpcResponse.Error(err, code.Value.ToWireString())
            : IpcResponse.Error(err);
    }

    private IpcResponse HandleClearParentPin(IpcRequest req)
    {
        var payload = Deserialize<ClearParentPinPayload>(req.Payload);
        if (payload == null || string.IsNullOrEmpty(payload.Pin))
            return IpcResponse.Error("Invalid payload");
        var (err, code, ok) = _parent.ClearPin(payload.Pin);
        return ok ? IpcResponse.Ok()
            : code.HasValue ? IpcResponse.Error(err, code.Value.ToWireString())
            : IpcResponse.Error(err);
    }

    private IpcResponse HandleVerifyRecoveryKey(IpcRequest req)
    {
        // Intentionally ungated: recovery exists precisely for when the parent can't unlock.
        // Rate-limit ladder on the daemon side prevents brute-force.
        var payload = Deserialize<VerifyRecoveryKeyPayload>(req.Payload);
        if (payload == null || string.IsNullOrEmpty(payload.Key))
            return IpcResponse.Error("Recovery key required");
        var (err, code, ok) = _parent.VerifyRecoveryKey(payload.Key);
        return ok ? IpcResponse.Ok()
            : code.HasValue ? IpcResponse.Error(err, code.Value.ToWireString())
            : IpcResponse.Error(err);
    }

    private IpcResponse HandleRegenerateRecoveryKey(IpcRequest req)
    {
        // Regenerating requires the current PIN (not just a grace token) — the user has to
        // re-prove they know the PIN, not just have an active unlock token in this session.
        var payload = Deserialize<RegenerateRecoveryKeyPayload>(req.Payload);
        if (payload == null || string.IsNullOrEmpty(payload.Pin))
            return IpcResponse.Error("Current PIN required");
        var (err, code, ok, newKey) = _parent.RegenerateRecoveryKey(payload.Pin);
        if (!ok) return code.HasValue ? IpcResponse.Error(err, code.Value.ToWireString()) : IpcResponse.Error(err);
        return IpcResponse.RecoveryKey(newKey!);
    }

    private IpcResponse HandleGetParentAudit(IpcRequest req)
    {
        // Gate the audit read when a PIN is configured — otherwise a child could
        // read their own attempt history without authorization. When no PIN is
        // set there is nothing privileged to protect, so allow open reads.
        var gate = GateOrNull(req);
        if (gate != null) return gate;

        int limit = 100;
        if (req.Payload.HasValue &&
            req.Payload.Value.TryGetProperty("limit", out var lv) &&
            lv.ValueKind == JsonValueKind.Number)
            limit = lv.GetInt32();
        return IpcResponse.ParentAudit(_audit.Recent(limit));
    }

    // ── Family controls (Phase 2.3) ────────────────────────────────────────

    private async Task<IpcResponse> HandleFamilyRedeem(IpcRequest req)
    {
        // Pairing-code redemption is gated when a settings lock is configured —
        // otherwise the child could pair their own device to a different parent
        // account to escape an existing lock.
        var gate = GateOrNull(req);
        if (gate != null) return gate;

        var payload = Deserialize<FamilyRedeemPayload>(req.Payload);
        if (payload == null || string.IsNullOrEmpty(payload.Code) || string.IsNullOrEmpty(payload.ServerUrl))
            return IpcResponse.Error("code and serverUrl required");

        var (err, result) = await _family.RedeemAsync(payload.Code, payload.ServerUrl, CancellationToken.None)
            .ConfigureAwait(false);
        if (err != null || result == null) return IpcResponse.Error(err ?? "Pairing failed");
        return IpcResponse.FamilyPaired(result);
    }

    private IpcResponse HandleFamilyUnpair(IpcRequest req)
    {
        // Local unpair on a child device is privileged — a kid shouldn't be
        // able to walk away from a parent's account. Gate behind the settings
        // PIN when one is configured; for unpaired-PIN devices the action is
        // effectively just "stop syncing", which is fine to allow.
        var gate = GateOrNull(req);
        if (gate != null) return gate;

        _family.ClearLocal();
        return IpcResponse.Ok();
    }

    private IpcResponse HandleAuthorizeUninstall(IpcRequest req)
    {
        // Gate uninstall the same way we gate unpair — the kid shouldn't be
        // able to remove FocusLock from Windows Settings → Apps. When no PIN
        // is set the gate is a no-op (anti-self-bypass features only matter
        // once the user has opted into them).
        var gate = GateOrNull(req);
        if (gate != null) return gate;

        var dir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "FocusLock");
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, "uninstall-authorized.token");
        var expiry = DateTimeOffset.UtcNow.AddMinutes(15).ToUnixTimeSeconds();
        try
        {
            File.WriteAllText(path, expiry.ToString() + Environment.NewLine);
            RestrictAuthorizationAcl(path);
            _audit.Record(ParentAuditEvents.UninstallAuthorized, detail: $"expiresInSeconds=900");
            return IpcResponse.Ok();
        }
        catch (Exception ex)
        {
            _log.LogWarning(ex, "Failed to write uninstall authorization token");
            return IpcResponse.Error("Could not write uninstall authorization token");
        }
    }

    private IpcResponse HandleSetFirewallLockdown(IpcRequest req)
    {
        var gate = GateOrNull(req);
        if (gate != null) return gate;
        if (req.Payload == null) return IpcResponse.Error("Missing payload");
        if (!req.Payload.Value.TryGetProperty("enabled", out var enabledEl)
            || enabledEl.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            return IpcResponse.Error("Missing 'enabled' boolean");

        if (!_family.SetFirewallLockdownEnabled(enabledEl.GetBoolean()))
            return IpcResponse.Error("Device is not paired");
        return IpcResponse.Ok();
    }

    private static void RestrictAuthorizationAcl(string path)
    {
        // SYSTEM + Administrators full control. Anyone else: no access. The
        // NSIS uninstaller runs elevated so it can still read the token.
        try
        {
            var info = new FileSecurity();
            info.SetAccessRuleProtection(true, false);
            info.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            info.AddAccessRule(new FileSystemAccessRule(
                new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null),
                FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(path).SetAccessControl(info);
        }
        catch { /* daemon may not be elevated in dev runs; the token is still written */ }
    }

    private static T? Deserialize<T>(JsonElement? element)
    {
        if (element == null) return default;
        return JsonSerializer.Deserialize<T>(element.Value.GetRawText(), JsonOpts);
    }
}
