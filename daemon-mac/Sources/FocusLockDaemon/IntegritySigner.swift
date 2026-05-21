import Foundation
import CryptoKit

/// Wraps the same daemon.key SessionService uses and lets the family-controls
/// caches HMAC-sign and verify arbitrary file bytes against it.
///
/// SessionService runs first in main.swift, so by the time the family services
/// are constructed the key file already exists with mode 0600. We still
/// tolerate the missing-key path so the order of construction is not load-bearing.
final class IntegritySigner {
    private static let keyPath: URL = {
        let base = URL(fileURLWithPath: "/Library/Application Support/FocusLock")
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base.appendingPathComponent("daemon.key")
    }()

    private let key: SymmetricKey

    init() {
        if let data = try? Data(contentsOf: Self.keyPath), data.count == 32 {
            self.key = SymmetricKey(data: data)
            return
        }
        let k = SymmetricKey(size: .bits256)
        let raw = k.withUnsafeBytes { Data($0) }
        try? raw.write(to: Self.keyPath)
        chmod(Self.keyPath.path, 0o600)
        self.key = k
    }

    func hex(_ data: Data) -> String {
        let mac = HMAC<SHA256>.authenticationCode(for: data, using: key)
        return Data(mac).map { String(format: "%02x", $0) }.joined()
    }

    func verify(_ data: Data, signatureHex: String) -> Bool {
        let expected = hex(data)
        let a = Array(expected.utf8)
        let b = Array(signatureHex.utf8)
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    /// Writes data to path and a hex HMAC to path + ".sig". Not atomic across
    /// both files; readers detect partial writes via the verify step and treat
    /// them as missing.
    func writeSigned(path: String, data: Data) {
        do {
            try data.write(to: URL(fileURLWithPath: path))
            try hex(data).write(to: URL(fileURLWithPath: path + ".sig"),
                                atomically: true, encoding: .utf8)
            chmod(path, 0o600)
            chmod(path + ".sig", 0o600)
        } catch {
            fputs("[integrity] writeSigned failed: \(error)\n", stderr)
        }
    }

    /// Returns raw bytes when the .sig sidecar verifies, else nil. Stale or
    /// missing sidecars are treated as "no value" — callers should fall back
    /// to their empty / unpaired state.
    func readVerified(path: String) -> Data? {
        let sigPath = path + ".sig"
        guard FileManager.default.fileExists(atPath: path),
              FileManager.default.fileExists(atPath: sigPath) else { return nil }
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let sig  = try? String(contentsOfFile: sigPath, encoding: .utf8) else { return nil }
        let sigTrim = sig.trimmingCharacters(in: .whitespacesAndNewlines)
        return verify(data, signatureHex: sigTrim) ? data : nil
    }

    func deleteSigned(path: String) {
        try? FileManager.default.removeItem(atPath: path)
        try? FileManager.default.removeItem(atPath: path + ".sig")
    }
}
