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
builder.Services.AddHostedService<DaemonWorker>();
builder.Services.AddHostedService<IpcPipeService>();
builder.Services.AddHostedService<InterceptHttpService>();
builder.Services.AddHostedService<ServiceWatchdogService>();

builder.Logging.AddEventLog(settings =>
{
    settings.SourceName = "FocusLock";
});

var host = builder.Build();
host.Run();
