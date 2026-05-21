using FocusLock.Daemon;
using FocusLock.Daemon.Services;

var builder = Host.CreateApplicationBuilder(args);

builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "FocusLock";
});

builder.Services.AddSingleton<SessionService>();
builder.Services.AddSingleton<HostsFileService>();
builder.Services.AddSingleton<ProcessKillService>();
builder.Services.AddSingleton<ProfileService>();
builder.Services.AddSingleton<ScheduleService>();
builder.Services.AddSingleton<ParentAuditService>();
builder.Services.AddSingleton<ParentService>();
builder.Services.AddSingleton<IntegritySigner>();
builder.Services.AddSingleton<EnvironmentProbe>();
builder.Services.AddSingleton<FamilyService>();
builder.Services.AddSingleton<FamilyEnforcementService>();
builder.Services.AddSingleton<CloudSyncService>();
builder.Services.AddHostedService<SafeModeRegistration>();
builder.Services.AddHostedService<DaemonWorker>();
builder.Services.AddHostedService<IpcPipeService>();
builder.Services.AddHostedService<InterceptHttpService>();
builder.Services.AddHostedService<ServiceWatchdogService>();
// CloudSyncService is a hosted service but also injected directly for status —
// register the same instance under both shapes.
builder.Services.AddHostedService(sp => sp.GetRequiredService<CloudSyncService>());

builder.Logging.AddEventLog(settings =>
{
    settings.SourceName = "FocusLock";
});

var host = builder.Build();
host.Run();
