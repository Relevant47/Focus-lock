import Foundation

// launchd writes our stdout/stderr to the StandardOutPath / StandardErrorPath
// declared in com.focuslock.daemon.plist, but it does NOT create missing parent
// directories for those redirects. Pre-SMAppService installs created
// /Library/Logs/FocusLock via installer/macos/install.sh; that installer was
// removed in v1.2.0, so create the directory here on every startup (idempotent)
// to keep daemon.log working on fresh installs.
try? FileManager.default.createDirectory(
    at: URL(fileURLWithPath: "/Library/Logs/FocusLock"),
    withIntermediateDirectories: true,
    attributes: [.posixPermissions: 0o755]
)

fputs("[focuslock] Daemon starting\n", stderr)

verifyOwnCodeSignature()

let dohSvc           = BrowserDohPolicyService()
let sessionSvc       = SessionService(doh: dohSvc)
let profileSvc       = ProfileService()
let auditSvc         = ParentAuditService()
let parentSvc        = ParentService(audit: auditSvc)
let signer           = IntegritySigner()
let envProbe         = EnvironmentProbe()
let familySvc        = FamilyService(signer: signer, audit: auditSvc)
let familyEnforce    = FamilyEnforcementService(signer: signer, audit: auditSvc)
let cloudSync        = CloudSyncService(family: familySvc, enforce: familyEnforce, audit: auditSvc)
let firewallLockdown = FirewallLockdownService(family: familySvc, enforce: familyEnforce, cloud: cloudSync)
let hostsSvc         = HostsService()
let processKill      = ProcessKillService(session: sessionSvc, family: familyEnforce)
let scheduleSvc      = ScheduleService(profiles: profileSvc, session: sessionSvc)
let ipcSvc           = IpcSocketService(
    session: sessionSvc, profiles: profileSvc, parent: parentSvc, audit: auditSvc,
    family: familySvc, familyEnforce: familyEnforce, cloudSync: cloudSync,
    envProbe: envProbe, firewallLockdown: firewallLockdown)
let interceptSvc     = InterceptHttpService(session: sessionSvc, profiles: profileSvc)

ipcSvc.start()
interceptSvc.start()
cloudSync.start()
firewallLockdown.start()

// Best-effort cleanup on common signals so a Ctrl-C dev run doesn't leave
// pfctl anchor entries loaded. launchd-managed production runs go through
// SIGTERM; manual `swift run` is usually SIGINT.
signal(SIGTERM, SIG_IGN)
signal(SIGINT,  SIG_IGN)
let termSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
let intSrc  = DispatchSource.makeSignalSource(signal: SIGINT,  queue: .main)
let onShutdown: () -> Void = {
    fputs("[focuslock] shutting down\n", stderr)
    firewallLockdown.stop()
    exit(0)
}
termSrc.setEventHandler(handler: onShutdown); termSrc.resume()
intSrc.setEventHandler(handler: onShutdown);  intSrc.resume()

// ── Main tick loop ────────────────────────────────────────────────────────────

var tickCount = 0
var hostsApplied = false
var dohApplied = false
var lastFingerprint = ""

func applyEnforcement(force: Bool) {
    let session = sessionSvc.active
    let sessionLive = sessionSvc.isActive && session != nil
    let lift = sessionSvc.shouldLiftBlocksDuringBreak

    let sessionDomains: [String] = (sessionLive && !lift) ? (session?.blockedDomains ?? []) : []
    let sessionAllow:   [String] = sessionLive ? (session?.allowlistedDomains ?? []) : []
    let (familyDomains, _) = familyEnforce.union()

    var union = Set<String>()
    for d in sessionDomains { union.insert(d) }
    for d in familyDomains  { union.insert(d) }

    if union.isEmpty {
        if hostsApplied {
            hostsSvc.remove()
            hostsApplied = false
            lastFingerprint = ""
        }
        // DoH restore is handled in SessionService.finalizeSession so the
        // backup is paired with the lifecycle that captured it. We just
        // clear our local "applied" flag here.
        dohApplied = false
        return
    }

    let fp = union.sorted().joined(separator: ",") + "|" + sessionAllow.sorted().joined(separator: ",")
    let fpChanged = fp != lastFingerprint

    // Force browser DoH off whenever there are domains to block. The service
    // itself is idempotent — re-applying when the plists already hold "off"
    // and the backup file already exists is a no-op. We still drive apply()
    // on the periodic re-enforce tick so a browser policy refresh after
    // install picks up our value within 30s.
    if force || fpChanged || !dohApplied {
        dohSvc.apply()
        dohApplied = true
    }

    if !force && !fpChanged && hostsApplied { return }

    hostsSvc.apply(blocked: Array(union), allowed: sessionAllow)
    hostsApplied = true
    lastFingerprint = fp
}

applyEnforcement(force: true)

while true {
    Thread.sleep(forTimeInterval: 1.0)
    tickCount += 1

    sessionSvc.tick()

    // Re-enforce every 30s regardless to overwrite manual hosts edits.
    applyEnforcement(force: tickCount % 30 == 0)

    let sessionWorking = sessionSvc.isActive && !sessionSvc.shouldLiftBlocksDuringBreak
    let familyHas = familyEnforce.hasActiveBlocks
    if (sessionWorking || familyHas) && tickCount % 2 == 0 {
        processKill.poll()
    }

    if tickCount % 60 == 0 {
        scheduleSvc.tick()
    }
}
