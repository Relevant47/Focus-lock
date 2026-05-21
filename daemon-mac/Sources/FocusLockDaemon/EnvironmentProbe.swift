import Foundation

/// Reads a small snapshot of "is this host hardened?" facts for the parent
/// setup flow. Intentionally narrow — listing local users + their group
/// memberships lives in the Phase 2.5 onboarding walkthrough where it can
/// drive UI step-by-step, not in this read-once probe.
final class EnvironmentProbe {
    func probe() -> FamilyEnvironment {
        let user: String?
        var buf = [CChar](repeating: 0, count: 256)
        if getlogin_r(&buf, buf.count) == 0 {
            user = String(cString: buf)
        } else {
            user = nil
        }
        return FamilyEnvironment(
            platform: "macos",
            osVersion: ProcessInfo.processInfo.operatingSystemVersionString,
            daemonElevated: getuid() == 0,
            uacEnabled: nil,  // No direct macOS analogue
            currentUser: user
        )
    }
}
