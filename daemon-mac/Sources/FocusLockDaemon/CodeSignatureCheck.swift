import Foundation
import Security

/// Verifies that the running daemon binary is signed by FocusLock's Apple
/// Developer Team ID. Replaces the previous SHA256-of-own-binary check,
/// which was brittle across legitimate updates.
///
/// On failure: logs and calls `exit(1)`. launchd's KeepAlive will retry,
/// the retries will keep failing, and the UI will eventually route to the
/// SetupRequired "tampered" state.
///
/// Dev-build bypass:
/// - `FOCUSLOCK_DEV_BUILD=1` env var (set by `swift run` wrapper) — full bypass
/// - Ad-hoc signature — `swift build` output is ad-hoc signed by default;
///   treat as a dev build
func verifyOwnCodeSignature() {
    if ProcessInfo.processInfo.environment["FOCUSLOCK_DEV_BUILD"] == "1" {
        fputs("[security] DEV BUILD — code signature check skipped\n", stderr)
        return
    }

    let execPath = CommandLine.arguments[0]
    let url = URL(fileURLWithPath: execPath)

    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(url as CFURL, [], &staticCode) == errSecSuccess,
          let code = staticCode else {
        fputs("[security] could not create SecStaticCode — exiting\n", stderr)
        exit(1)
    }

    // Detect ad-hoc signature (dev `swift build` output) and bypass.
    var infoCF: CFDictionary?
    let infoFlags = SecCSFlags(rawValue: kSecCSSigningInformation)
    if SecCodeCopySigningInformation(code, infoFlags, &infoCF) == errSecSuccess,
       let dict = infoCF as? [String: Any] {
        let flags = (dict[kSecCodeInfoFlags as String] as? UInt32) ?? 0
        // kSecCodeSignatureAdhoc = 2
        if flags & 2 != 0 {
            fputs("[security] DEV BUILD (ad-hoc signed) — code signature check skipped\n", stderr)
            return
        }
    }

    // FocusLock Apple Developer Team ID — replace before shipping.
    // Find it: codesign -dv /Applications/FocusLock.app 2>&1 | grep TeamIdentifier
    let teamID = "FOCUSLOCK_TEAM_ID_PLACEHOLDER"
    if teamID == "FOCUSLOCK_TEAM_ID_PLACEHOLDER" {
        fputs("[security] FATAL: TeamID placeholder not replaced — exiting\n", stderr)
        exit(1)
    }

    let requirementString = "anchor apple generic and certificate leaf[subject.OU] = \"\(teamID)\""
    var requirement: SecRequirement?
    guard SecRequirementCreateWithString(requirementString as CFString, [], &requirement) == errSecSuccess,
          let req = requirement else {
        fputs("[security] could not create SecRequirement — exiting\n", stderr)
        exit(1)
    }

    let status = SecStaticCodeCheckValidity(code, [], req)
    if status != errSecSuccess {
        fputs("[security] code signature check failed: OSStatus \(status) — exiting\n", stderr)
        exit(1)
    }

    fputs("[security] code signature verified (Team ID \(teamID))\n", stderr)
}
