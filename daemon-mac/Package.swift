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
            ],
            // UsageDB.swift uses the platform SQLite3 (`import SQLite3`);
            // link the system library explicitly so SPM's linker resolves it.
            //
            // UsageService.swift (Phase 3) uses SCDynamicStoreCopyConsoleUser
            // from SystemConfiguration to resolve the console-user uid when
            // registering the tracker LaunchAgent — link the framework so the
            // symbol resolves at load time regardless of runtime path.
            linkerSettings: [
                .linkedLibrary("sqlite3"),
                .linkedFramework("SystemConfiguration"),
            ]
        ),
        // Phase 3: user-session helper that samples the frontmost app and
        // posts usage.report_sample to the daemon. Runs as a LaunchAgent
        // registered by UsageService.registerLaunchAgent(). Uses AppKit for
        // NSWorkspace.frontmostApplication — kept as an executableTarget so
        // it ships as its own binary that launchd can spawn independently
        // of the daemon.
        .executableTarget(
            name: "FocusLockUsageTracker",
            path: "Sources/FocusLockUsageTracker",
            swiftSettings: [
                .unsafeFlags(["-Onone"], .when(configuration: .debug)),
                .unsafeFlags(["-O", "-whole-module-optimization"], .when(configuration: .release)),
            ],
            linkerSettings: [
                .linkedFramework("AppKit"),
            ]
        ),
    ]
)
