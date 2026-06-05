import Foundation
import ServiceManagement
import SwiftRs

/// Status codes mirrored to Rust as `i32`.
/// Keep in sync with `RegisterOutcome` in `src/macos_daemon.rs`.
private let OK_RUNNING_OR_PENDING: Int32 = 0
private let REQUIRES_APPROVAL: Int32 = 1
private let NOT_FOUND: Int32 = 2
private let GENERIC_ERROR: Int32 = 99

private let plistName = "com.focuslock.daemon.plist"

/// Register and start the bundled FocusLock daemon via SMAppService.
/// macOS will prompt the user for an admin password on first call.
@_cdecl("focuslock_sm_register")
public func focuslockSMRegister() -> Int32 {
    let service = SMAppService.daemon(plistName: plistName)
    do {
        try service.register()
        return OK_RUNNING_OR_PENDING
    } catch let nsErr as NSError {
        recordError(nsErr)
        switch nsErr.code {
        case Int(kSMErrorAlreadyRegistered):
            return OK_RUNNING_OR_PENDING
        case Int(kSMErrorAuthorizationFailure):
            return REQUIRES_APPROVAL
        case Int(kSMErrorJobNotFound):
            return NOT_FOUND
        default:
            return GENERIC_ERROR
        }
    }
}

/// Returns the SMAppService status as an Int32:
/// 0 = notRegistered, 1 = enabled, 2 = requiresApproval, 3 = notFound
@_cdecl("focuslock_sm_status")
public func focuslockSMStatus() -> Int32 {
    let service = SMAppService.daemon(plistName: plistName)
    switch service.status {
    case .notRegistered:      return 0
    case .enabled:            return 1
    case .requiresApproval:   return 2
    case .notFound:           return 3
    @unknown default:         return 99
    }
}

/// Best-effort unregister. Used only by the legacy-cleanup flow.
@_cdecl("focuslock_sm_unregister")
public func focuslockSMUnregister() -> Int32 {
    let service = SMAppService.daemon(plistName: plistName)
    do {
        try service.unregister()
        return 0
    } catch {
        return 1
    }
}

// ── Error reporting ──────────────────────────────────────────────────────────

private var _lastError: String = ""
private let _lastErrorLock = NSLock()

private func recordError(_ err: NSError) {
    _lastErrorLock.lock()
    defer { _lastErrorLock.unlock() }
    _lastError = "\(err.domain) \(err.code): \(err.localizedDescription)"
}

/// Returns the last error string as an SRString.
@_cdecl("focuslock_sm_last_error")
public func focuslockSMLastError() -> SRString {
    _lastErrorLock.lock()
    defer { _lastErrorLock.unlock() }
    return SRString(_lastError)
}
