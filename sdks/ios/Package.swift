// swift-tools-version:5.9
//
// Dürbün iOS SDK — streams app logs, stdout/stderr, crashes, URLSession traffic and performance
// metrics to the Dürbün desktop app. Builds for iOS 13+ and macOS 11+ (macOS so the tests run on a Mac).
//
// This manifest is for developing the SDK (it has the tests). Apps add the package by URL, which
// uses the repository root's Package.swift (same target, no tests); keep the two targets alike.

import PackageDescription

let package = Package(
    name: "Durbun",
    platforms: [
        .iOS(.v13),
        .macOS(.v11),
    ],
    products: [
        .library(name: "Durbun", targets: ["Durbun"]),
    ],
    targets: [
        .target(
            name: "Durbun",
            path: "Sources/Durbun",
            resources: [.process("PrivacyInfo.xcprivacy")]
        ),
        .testTarget(
            name: "DurbunTests",
            dependencies: ["Durbun"],
            path: "Tests/DurbunTests",
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
