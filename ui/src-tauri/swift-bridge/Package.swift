// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "FocusLockSMBridge",
    platforms: [.macOS(.v13)],
    products: [
        .library(name: "FocusLockSMBridge", type: .static, targets: ["FocusLockSMBridge"]),
    ],
    dependencies: [
        .package(url: "https://github.com/Brendonovich/swift-rs", from: "1.0.6"),
    ],
    targets: [
        .target(
            name: "FocusLockSMBridge",
            dependencies: [
                .product(name: "SwiftRs", package: "swift-rs"),
            ]
        ),
    ]
)
