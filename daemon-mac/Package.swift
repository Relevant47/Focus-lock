// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "FocusLockDaemon",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "FocusLockDaemon",
            path: "Sources/FocusLockDaemon",
            swiftSettings: [
                .unsafeFlags(["-Onone"], .when(configuration: .debug)),
                .unsafeFlags(["-O", "-whole-module-optimization"], .when(configuration: .release)),
            ]
        ),
    ]
)
