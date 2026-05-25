import Foundation
import CryptoKit
import CommonCrypto
import Security

/// Parental controls: a PIN gates sensitive mutations (profile/schedule edits,
/// Hardcore disable, stopping a parent-locked session). Verifying the PIN issues
/// a short-lived HMAC grace token. The UI caches that token in memory and supplies
/// it as `parentToken` on subsequent gated requests until it expires.
///
/// Mirrors the Windows ParentService.cs: PBKDF2-SHA256 (200k iters, 16-byte salt),
/// HMAC-SHA256 tokens, same rate-limit backoff ladder, 5-minute grace window.
final class ParentService {
    static let graceWindowSeconds: TimeInterval = 5 * 60

    private static let pbkdf2Iterations: UInt32 = 200_000
    private static let saltBytes = 16
    private static let hashBytes = 32

    private static let stateDir = URL(fileURLWithPath: "/Library/Application Support/FocusLock")
    private static let credPath = stateDir.appendingPathComponent("parent.cred")
    private static let tokenKeyPath = stateDir.appendingPathComponent("parent.tokenkey")

    private let lock = NSLock()
    private let tokenKey: SymmetricKey
    private let audit: ParentAuditService
    private var cred: ParentCred?

    // Rate limiting for failed verify attempts.
    private var failedAttempts = 0
    private var nextAttemptAllowed: Date = .distantPast

    init(audit: ParentAuditService) {
        try? FileManager.default.createDirectory(at: Self.stateDir, withIntermediateDirectories: true)
        self.audit = audit
        self.tokenKey = Self.loadOrCreateTokenKey()
        self.cred = Self.loadCred()
    }

    var isEnabled: Bool { lock.withLock { cred != nil } }

    var graceMinutes: Int { Int(Self.graceWindowSeconds / 60) }

    var isRateLimited: Bool { lock.withLock { Date() < nextAttemptAllowed } }

    var retryAfterSeconds: Double? {
        lock.withLock {
            nextAttemptAllowed > Date() ? nextAttemptAllowed.timeIntervalSinceNow : nil
        }
    }

    // ── Public API ──────────────────────────────────────────────────────────

    struct Outcome {
        let error: String
        let code: String?
        let success: Bool
    }

    struct PinOutcome {
        let error: String
        let code: String?
        let success: Bool
        let recoveryKey: String?  // populated only on first setup or regenerate
    }

    struct VerifyOutcome {
        let error: String
        let code: String?
        let token: String?
        let expiresAt: Date?
    }

    /// Sets the parent PIN. Requires the existing PIN if one is already set.
    /// Generates a fresh recovery key on first setup; preserves the existing key on change.
    /// Returns the plaintext recovery key only on first setup — caller MUST display it once;
    /// it is never returned again.
    func setPin(_ newPin: String, oldPin: String?) -> PinOutcome {
        if newPin.isEmpty { return PinOutcome(error: "PIN cannot be empty", code: nil, success: false, recoveryKey: nil) }

        var isChange = false
        var newRecoveryKey: String? = nil
        let result: PinOutcome = lock.withLock {
            if let existing = cred {
                isChange = true
                guard let supplied = oldPin, !supplied.isEmpty else {
                    return PinOutcome(error: "Existing PIN required to change it", code: ParentErrorCode.pinInvalid, success: false, recoveryKey: nil)
                }
                guard Self.verifyAgainstCred(supplied, cred: existing) else {
                    recordFailedAttemptLocked()
                    return PinOutcome(error: "Existing PIN incorrect", code: ParentErrorCode.pinInvalid, success: false, recoveryKey: nil)
                }
            }

            let salt = Self.randomBytes(Self.saltBytes)
            let hash = Self.pbkdf2(pin: newPin, salt: salt)

            let keySalt: Data
            let keyHash: Data
            if isChange, let existing = cred, !existing.recoveryKeySalt.isEmpty {
                // Preserve existing recovery key on change — the user shouldn't have to
                // re-save the key just because they changed the PIN.
                keySalt = existing.recoveryKeySalt
                keyHash = existing.recoveryKeyHash
            } else {
                let generated = Self.generateRecoveryKey()
                newRecoveryKey = generated
                keySalt = Self.randomBytes(Self.saltBytes)
                keyHash = Self.pbkdf2(pin: Self.normalizeRecoveryKey(generated), salt: keySalt)
            }

            let newCred = ParentCred(
                salt: salt, hash: hash, createdAt: Date(),
                recoveryKeySalt: keySalt, recoveryKeyHash: keyHash
            )
            cred = newCred
            Self.saveCred(newCred)
            resetRateLimitLocked()
            fputs("[parent] PIN configured\n", stderr)
            return PinOutcome(error: "", code: nil, success: true, recoveryKey: newRecoveryKey)
        }
        if result.success {
            audit.record(isChange ? ParentAuditEvents.pinChanged : ParentAuditEvents.pinSet)
        }
        return result
    }

    /// Regenerates the recovery key. Requires the current PIN. Invalidates any previously-displayed key.
    func regenerateRecoveryKey(pin: String) -> PinOutcome {
        lock.withLock {
            guard let existing = cred else {
                return PinOutcome(error: "Parent controls are not configured", code: nil, success: false, recoveryKey: nil)
            }
            if Date() < nextAttemptAllowed {
                let wait = Int(nextAttemptAllowed.timeIntervalSinceNow.rounded(.up))
                return PinOutcome(error: "Too many failed attempts — wait \(wait)s",
                                  code: ParentErrorCode.rateLimited, success: false, recoveryKey: nil)
            }
            guard Self.verifyAgainstCred(pin, cred: existing) else {
                recordFailedAttemptLocked()
                return PinOutcome(error: "Incorrect PIN", code: ParentErrorCode.pinInvalid, success: false, recoveryKey: nil)
            }

            let newKey = Self.generateRecoveryKey()
            let keySalt = Self.randomBytes(Self.saltBytes)
            let keyHash = Self.pbkdf2(pin: Self.normalizeRecoveryKey(newKey), salt: keySalt)
            let newCred = ParentCred(
                salt: existing.salt, hash: existing.hash, createdAt: existing.createdAt,
                recoveryKeySalt: keySalt, recoveryKeyHash: keyHash
            )
            cred = newCred
            Self.saveCred(newCred)
            resetRateLimitLocked()
            fputs("[parent] Recovery key regenerated\n", stderr)
            return PinOutcome(error: "", code: nil, success: true, recoveryKey: newKey)
        }
    }

    /// Verifies a recovery key and, on success, clears the PIN. Same rate-limit ladder as PIN verify.
    func verifyRecoveryKey(_ providedKey: String) -> Outcome {
        if providedKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return Outcome(error: "Recovery key required", code: nil, success: false)
        }
        var auditEvent: String? = nil
        var cleared = false
        let result: Outcome = lock.withLock {
            guard let existing = cred else {
                return Outcome(error: "Parent controls are not configured", code: nil, success: false)
            }
            guard !existing.recoveryKeySalt.isEmpty else {
                return Outcome(error: "No recovery key is set for this PIN", code: nil, success: false)
            }
            if Date() < nextAttemptAllowed {
                let wait = Int(nextAttemptAllowed.timeIntervalSinceNow.rounded(.up))
                auditEvent = ParentAuditEvents.pinVerifyRateLimit
                return Outcome(error: "Too many failed attempts — wait \(wait)s",
                               code: ParentErrorCode.rateLimited, success: false)
            }
            let normalized = Self.normalizeRecoveryKey(providedKey)
            let derived = Self.pbkdf2(pin: normalized, salt: existing.recoveryKeySalt)
            guard Self.constantTimeEquals(derived, existing.recoveryKeyHash) else {
                recordFailedAttemptLocked()
                auditEvent = ParentAuditEvents.pinVerifyFail
                return Outcome(error: "Incorrect recovery key", code: ParentErrorCode.recoveryKeyInvalid, success: false)
            }
            // Match: clear the PIN.
            cred = nil
            try? FileManager.default.removeItem(at: Self.credPath)
            resetRateLimitLocked()
            fputs("[parent] PIN cleared via recovery key\n", stderr)
            cleared = true
            return Outcome(error: "", code: nil, success: true)
        }
        if let event = auditEvent { audit.record(event, detail: "recovery_key") }
        if cleared { audit.record(ParentAuditEvents.pinCleared, detail: "recovery_key") }
        return result
    }

    // 16-character recovery key in 4 groups of 4 from an unambiguous alphabet.
    // 32^16 ≈ 1.2 × 10^24 combinations — completely impractical to brute-force,
    // and the rate-limit ladder closes the door further.
    private static let recoveryAlphabet = Array("ABCDEFGHJKMNPQRSTUVWXYZ23456789")

    private static func generateRecoveryKey() -> String {
        let bytes = randomBytes(16)
        var chars = ""
        for i in 0..<16 {
            chars.append(recoveryAlphabet[Int(bytes[i]) % recoveryAlphabet.count])
        }
        let g = Array(chars)
        return "\(String(g[0...3]))-\(String(g[4...7]))-\(String(g[8...11]))-\(String(g[12...15]))"
    }

    private static func normalizeRecoveryKey(_ key: String) -> String {
        // Strip whitespace and hyphens, uppercase. Lets users paste with or without formatting.
        return key.uppercased().filter { c in
            c != "-" && !c.isWhitespace
        }
    }

    /// Verifies a PIN and returns a signed grace token on success.
    func verifyPin(_ pin: String) -> VerifyOutcome {
        var auditEvent: String?
        let result: VerifyOutcome = lock.withLock {
            guard let existing = cred else {
                return VerifyOutcome(error: "Parent controls are not configured", code: nil, token: nil, expiresAt: nil)
            }

            if Date() < nextAttemptAllowed {
                let wait = Int(nextAttemptAllowed.timeIntervalSinceNow.rounded(.up))
                auditEvent = ParentAuditEvents.pinVerifyRateLimit
                return VerifyOutcome(
                    error: "Too many failed attempts — wait \(wait)s",
                    code: ParentErrorCode.rateLimited, token: nil, expiresAt: nil)
            }

            guard Self.verifyAgainstCred(pin, cred: existing) else {
                recordFailedAttemptLocked()
                auditEvent = ParentAuditEvents.pinVerifyFail
                return VerifyOutcome(error: "Incorrect PIN", code: ParentErrorCode.pinInvalid, token: nil, expiresAt: nil)
            }

            resetRateLimitLocked()
            let expiresAt = Date().addingTimeInterval(Self.graceWindowSeconds)
            let token = issueTokenLocked(expiresAt: expiresAt)
            auditEvent = ParentAuditEvents.pinVerifySuccess
            return VerifyOutcome(error: "", code: nil, token: token, expiresAt: expiresAt)
        }
        if let event = auditEvent { audit.record(event) }
        return result
    }

    /// Clears the parent PIN. Requires the current PIN.
    func clearPin(_ pin: String) -> Outcome {
        var pinWasSet = false
        let result: Outcome = lock.withLock {
            guard let existing = cred else { return Outcome(error: "", code: nil, success: true) }
            pinWasSet = true

            if Date() < nextAttemptAllowed {
                let wait = Int(nextAttemptAllowed.timeIntervalSinceNow.rounded(.up))
                return Outcome(
                    error: "Too many failed attempts — wait \(wait)s",
                    code: ParentErrorCode.rateLimited, success: false)
            }

            guard Self.verifyAgainstCred(pin, cred: existing) else {
                recordFailedAttemptLocked()
                return Outcome(error: "Incorrect PIN", code: ParentErrorCode.pinInvalid, success: false)
            }

            cred = nil
            try? FileManager.default.removeItem(at: Self.credPath)
            resetRateLimitLocked()
            fputs("[parent] PIN cleared\n", stderr)
            return Outcome(error: "", code: nil, success: true)
        }
        // Only audit when a PIN was actually configured and now cleared — a no-op
        // clear (PIN never set) is not a meaningful audit event.
        if result.success && pinWasSet { audit.record(ParentAuditEvents.pinCleared) }
        return result
    }

    /// True when no PIN is configured, or the supplied token is valid and unexpired.
    func isAuthorized(_ token: String?) -> Bool {
        lock.withLock {
            guard cred != nil else { return true }
            guard let token = token, !token.isEmpty else { return false }
            return validateToken(token)
        }
    }

    // ── Token issuance ──────────────────────────────────────────────────────

    private func issueTokenLocked(expiresAt: Date) -> String {
        // Format: base64url(expiryUnixSeconds.signature)
        // signature = HMAC-SHA256(tokenKey, expiryUnixSeconds)
        let expiry = Int(expiresAt.timeIntervalSince1970)
        let expiryStr = String(expiry)
        let sig = HMAC<SHA256>.authenticationCode(for: Data(expiryStr.utf8), using: tokenKey)
        let sigHex = Data(sig).hexString
        let payload = "\(expiryStr).\(sigHex)"
        let bytes = Data(payload.utf8)
        return Self.base64URLEncode(bytes)
    }

    private func validateToken(_ token: String) -> Bool {
        guard let raw = Self.base64URLDecode(token),
              let str = String(data: raw, encoding: .utf8) else { return false }
        let parts = str.split(separator: ".", maxSplits: 1, omittingEmptySubsequences: false)
        guard parts.count == 2 else { return false }
        guard let expiry = Int(parts[0]) else { return false }

        let expected = HMAC<SHA256>.authenticationCode(for: Data(parts[0].utf8), using: tokenKey)
        let expectedHex = Data(expected).hexString
        let providedHex = String(parts[1])

        // Constant-time hex string comparison.
        guard Self.constantTimeEquals(expectedHex, providedHex) else { return false }
        return Date(timeIntervalSince1970: TimeInterval(expiry)) > Date()
    }

    // ── PIN hashing ────────────────────────────────────────────────────────

    private static func pbkdf2(pin: String, salt: Data) -> Data {
        var derived = Data(count: hashBytes)
        let pinByteCount = pin.utf8.count
        _ = derived.withUnsafeMutableBytes { derivedBuf -> Int32 in
            salt.withUnsafeBytes { saltBuf -> Int32 in
                pin.withCString { pinPtr -> Int32 in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        pinPtr, pinByteCount,
                        saltBuf.bindMemory(to: UInt8.self).baseAddress, salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        pbkdf2Iterations,
                        derivedBuf.bindMemory(to: UInt8.self).baseAddress, hashBytes
                    )
                }
            }
        }
        return derived
    }

    private static func verifyAgainstCred(_ pin: String, cred: ParentCred) -> Bool {
        let derived = pbkdf2(pin: pin, salt: cred.salt)
        return constantTimeEquals(derived, cred.hash)
    }

    // ── Rate limiting ──────────────────────────────────────────────────────

    private func recordFailedAttemptLocked() {
        failedAttempts += 1
        let backoff = Self.backoffSeconds(failedAttempts)
        nextAttemptAllowed = Date().addingTimeInterval(TimeInterval(backoff))
        fputs("[parent] Failed PIN attempt #\(failedAttempts) — backoff \(backoff)s\n", stderr)
    }

    private func resetRateLimitLocked() {
        failedAttempts = 0
        nextAttemptAllowed = .distantPast
    }

    private static func backoffSeconds(_ attempts: Int) -> Int {
        switch attempts {
        case 1: return 10
        case 2: return 30
        case 3: return 60
        default: return 300
        }
    }

    // ── Persistence ────────────────────────────────────────────────────────

    private struct ParentCred {
        let salt: Data
        let hash: Data
        let createdAt: Date
        let recoveryKeySalt: Data
        let recoveryKeyHash: Data
    }

    private struct ParentCredDto: Codable {
        var salt: String
        var hash: String
        var createdAt: Date
        var recoveryKeySalt: String?
        var recoveryKeyHash: String?
    }

    private static func loadCred() -> ParentCred? {
        guard let data = try? Data(contentsOf: credPath) else { return nil }
        let dec = JSONDecoder()
        dec.dateDecodingStrategy = .iso8601
        guard let dto = try? dec.decode(ParentCredDto.self, from: data),
              let salt = Data(base64Encoded: dto.salt),
              let hash = Data(base64Encoded: dto.hash) else {
            fputs("[parent] Failed to load parent.cred — treating as not configured\n", stderr)
            return nil
        }
        let keySalt = dto.recoveryKeySalt.flatMap { Data(base64Encoded: $0) } ?? Data()
        let keyHash = dto.recoveryKeyHash.flatMap { Data(base64Encoded: $0) } ?? Data()
        return ParentCred(salt: salt, hash: hash, createdAt: dto.createdAt,
                          recoveryKeySalt: keySalt, recoveryKeyHash: keyHash)
    }

    private static func saveCred(_ cred: ParentCred) {
        let dto = ParentCredDto(
            salt: cred.salt.base64EncodedString(),
            hash: cred.hash.base64EncodedString(),
            createdAt: cred.createdAt,
            recoveryKeySalt: cred.recoveryKeySalt.isEmpty ? nil : cred.recoveryKeySalt.base64EncodedString(),
            recoveryKeyHash: cred.recoveryKeyHash.isEmpty ? nil : cred.recoveryKeyHash.base64EncodedString()
        )
        let enc = JSONEncoder()
        enc.dateEncodingStrategy = .iso8601
        enc.outputFormatting = .prettyPrinted
        if let data = try? enc.encode(dto) {
            try? data.write(to: credPath)
            chmod(credPath.path, 0o600)
        }
    }

    private static func loadOrCreateTokenKey() -> SymmetricKey {
        if let data = try? Data(contentsOf: tokenKeyPath), data.count == 32 {
            return SymmetricKey(data: data)
        }
        let key = SymmetricKey(size: .bits256)
        let raw = key.withUnsafeBytes { Data($0) }
        try? raw.write(to: tokenKeyPath)
        chmod(tokenKeyPath.path, 0o600)
        return key
    }

    // ── Crypto helpers ─────────────────────────────────────────────────────

    private static func randomBytes(_ count: Int) -> Data {
        var data = Data(count: count)
        _ = data.withUnsafeMutableBytes { buf -> Int32 in
            SecRandomCopyBytes(kSecRandomDefault, count, buf.baseAddress!)
        }
        return data
    }

    private static func constantTimeEquals(_ a: Data, _ b: Data) -> Bool {
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    private static func constantTimeEquals(_ a: String, _ b: String) -> Bool {
        constantTimeEquals(Data(a.utf8), Data(b.utf8))
    }

    private static func base64URLEncode(_ data: Data) -> String {
        var s = data.base64EncodedString()
        s = s.replacingOccurrences(of: "+", with: "-")
        s = s.replacingOccurrences(of: "/", with: "_")
        s = s.replacingOccurrences(of: "=", with: "")
        return s
    }

    private static func base64URLDecode(_ s: String) -> Data? {
        var b64 = s.replacingOccurrences(of: "-", with: "+")
                   .replacingOccurrences(of: "_", with: "/")
        let pad = (4 - b64.count % 4) % 4
        b64 += String(repeating: "=", count: pad)
        return Data(base64Encoded: b64)
    }
}
