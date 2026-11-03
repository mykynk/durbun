import XCTest
@testable import Durbun

/// The checks in `Durbun.start` before anything starts: Flutter apps leave the native layer to the
/// plugin, and builds without `DEBUG` never run in App Store installs, even when forced.
final class StartGuardTests: SDKTestCase {
    private var realReceiptName: (() -> String?)!

    override func setUpWithError() throws {
        try super.setUpWithError()
        realReceiptName = StoreInstallGuard.receiptName
    }

    override func tearDown() {
        StoreInstallGuard.receiptName = realReceiptName
        super.tearDown()
    }

    private func forcedReleaseOptions() -> DurbunOptions {
        var forced = options()
        forced.allowInReleaseBuilds = true
        return forced
    }

    private func asRelease(receipt: String?) {
        DurbunCore.shared.overrides.releaseBuild = true
        StoreInstallGuard.receiptName = { receipt }
    }

    func testForcedReleaseBuildFromTheAppStoreStaysOff() {
        asRelease(receipt: "receipt")
        Durbun.start(options: forcedReleaseOptions())
        XCTAssertFalse(Durbun.isRunning)
        XCTAssertNil(desktop.waitForType("hello", timeout: 0.5), "nothing reached the desktop")
    }

    func testTestFlightAdHocAndDevelopmentBuildsRun() {
        asRelease(receipt: "sandboxReceipt")
        startConnected(forcedReleaseOptions())
        XCTAssertTrue(Durbun.isRunning)
    }

    func testReleaseBuildsStillNeedTheOptIn() {
        asRelease(receipt: "sandboxReceipt")
        Durbun.start(options: options())
        XCTAssertFalse(Durbun.isRunning)
    }

    func testDebugBuildsDoNotLookAtTheReceipt() {
        StoreInstallGuard.receiptName = { "receipt" }
        startConnected()
        XCTAssertTrue(Durbun.isRunning)
    }

    func testFlutterAppsLeaveTheNativeLayerToThePlugin() {
        DurbunCore.shared.overrides.flutterPluginPresent = true
        Durbun.start(options: options())
        XCTAssertFalse(Durbun.isRunning, "a stray native call opens no second session")
        XCTAssertNil(NSClassFromString(DurbunCore.flutterPluginClass), "native-only apps have no plugin class")
    }

    func testGuardDecisionAndItsOneLine() {
        XCTAssertTrue(StoreInstallGuard.isStoreReceipt("receipt"))
        XCTAssertFalse(StoreInstallGuard.isStoreReceipt("sandboxReceipt"))
        XCTAssertFalse(StoreInstallGuard.isStoreReceipt(nil))
        XCTAssertNil(realReceiptName(), "macOS (where the tests run) never counts as a store install")
        XCTAssertEqual(
            StoreInstallGuard.message(preferredLanguages: ["tr-TR"]),
            "Dürbün kendini kapattı: uygulama mağazadan kurulmuş (Dürbün mağaza sürümlerinde çalışmaz)."
        )
        XCTAssertEqual(
            StoreInstallGuard.message(preferredLanguages: ["en-US", "tr"]),
            "Dürbün turned itself off: this app was installed from the store (Dürbün never runs in store builds)."
        )
        XCTAssertEqual(StoreInstallGuard.message(preferredLanguages: ["tr"]), StoreInstallGuard.messageTR)
        XCTAssertEqual(StoreInstallGuard.message(preferredLanguages: []), StoreInstallGuard.messageEN)
    }
}
