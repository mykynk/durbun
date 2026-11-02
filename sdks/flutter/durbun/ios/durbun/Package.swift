// swift-tools-version: 5.9
//
// iOS side of package:durbun for Flutter's Swift Package Manager integration (CocoaPods uses
// ../durbun.podspec; both build Sources/durbun). Sources/durbun/Core is an exact copy of
// sdks/ios/Sources/Durbun — refresh it with `dart run tool/sync_native.dart`.

import PackageDescription

let package = Package(
    name: "durbun",
    platforms: [
        .iOS("13.0"),
    ],
    products: [
        .library(name: "durbun", targets: ["durbun"]),
    ],
    dependencies: [],
    targets: [
        .target(
            name: "durbun",
            dependencies: [],
            resources: [
                .process("PrivacyInfo.xcprivacy"),
            ]
        ),
    ],
    swiftLanguageVersions: [.v5]
)
