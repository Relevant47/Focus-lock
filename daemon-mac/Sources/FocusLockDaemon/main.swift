import Foundation

fputs("[focuslock] Daemon starting\n", stderr)

let sessionSvc       = SessionService()
let profileSvc       = ProfileService()
let auditSvc         = ParentAuditService()
let parentSvc        = ParentService(audit: auditSvc)
let signer           = IntegritySigner()
let envProbe         = EnvironmentProbe()
let familySvc        = FamilyService(signer: signer, audit: auditSvc)
let familyEnforce    = FamilyEnforcementService(signer: signer, audit: auditSvc)
let cloudSync        = CloudSyncService(family: familySvc, enforce: familyEnforce, audit: auditSvc)
let hostsSvc         = HostsService()
let processKill      = ProcessKillService(session: sessionSvc, family: familyEnforce)
let scheduleSvc      = ScheduleService(profiles: profileSvc, session: sessionSvc)
let ipcSvc           = IpcSocketService(
    session: sessionSvc, profiles: profileSvc, parent: parentSvc, audit: auditSvc,
    family: familySvc, familyEnforce: familyEnforce, cloudSync: cloudSync,
    envProbe: envProbe)
let interceptSvc     = InterceptHttpService(session: sessionSvc, profiles: profileSvc)

ipcSvc.start()
interceptSvc.start()
cloudSync.start()

// ── Main tick loop ────────────────────────────────────────────────────────────

var tickCount = 0
var hostsApplied = false
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
        return
    }

    let fp = union.sorted().joined(separator: ",") + "|" + sessionAllow.sorted().joined(separator: ",")
    if !force && fp == lastFingerprint && hostsApplied { return }

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
