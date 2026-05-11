import Foundation

fputs("[focuslock] Daemon starting\n", stderr)

let sessionSvc   = SessionService()
let profileSvc   = ProfileService()
let hostsSvc     = HostsService()
let processKill  = ProcessKillService(session: sessionSvc)
let scheduleSvc  = ScheduleService(profiles: profileSvc, session: sessionSvc)
let ipcSvc       = IpcSocketService(session: sessionSvc, profiles: profileSvc)
let interceptSvc = InterceptHttpService(session: sessionSvc)

// Re-apply hosts file if a session was recovered from disk
if sessionSvc.isActive, let active = sessionSvc.active {
    hostsSvc.apply(active)
    fputs("[focuslock] Resumed active session, hosts file applied\n", stderr)
} else {
    hostsSvc.remove()
}

ipcSvc.start()
interceptSvc.start()

// ── Main tick loop ────────────────────────────────────────────────────────────

var tickCount = 0
var wasActive = sessionSvc.isActive
var lastAppliedSessionId: String? = sessionSvc.active?.sessionId
var hostsCurrentlyLifted = false

while true {
    Thread.sleep(forTimeInterval: 1.0)
    tickCount += 1

    sessionSvc.tick()

    let isActive = sessionSvc.isActive

    if isActive, let active = sessionSvc.active {
        let sid = active.sessionId
        let shouldLift = sessionSvc.shouldLiftBlocksDuringBreak

        if shouldLift {
            if !hostsCurrentlyLifted {
                hostsSvc.remove()
                hostsCurrentlyLifted = true
                fputs("[pomodoro] Break — blocks lifted\n", stderr)
            }
            // Don't kill processes during break
        } else {
            if hostsCurrentlyLifted || sid != lastAppliedSessionId || tickCount % 30 == 0 {
                hostsSvc.apply(active)
                lastAppliedSessionId = sid
                hostsCurrentlyLifted = false
            }
            if tickCount % 2 == 0 {
                processKill.poll()
            }
        }

        wasActive = true
    } else if wasActive && !isActive {
        hostsSvc.remove()
        lastAppliedSessionId = nil
        wasActive = false
        hostsCurrentlyLifted = false
    }

    if tickCount % 60 == 0 {
        scheduleSvc.tick()
    }
}
