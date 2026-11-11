// swift-tools-version:5.9
//
// Dürbün iOS SDK for Swift Package Manager:
//   .package(url: "https://github.com/mykynk/durbun", from: "0.2.0")
// and depend on the "Durbun" product. The sources live in sdks/ios/Sources/Durbun; sdks/ios/Package.swift
// is the development manifest with the tests (keep both targets alike). CocoaPods: Durbun.podspec.

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
            path: "sdks/ios/Sources/Durbun",
            resources: [.process("PrivacyInfo.xcprivacy")]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
