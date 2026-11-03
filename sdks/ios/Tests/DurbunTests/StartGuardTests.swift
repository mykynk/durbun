import XCTest
@testable import Durbun

/// The checks in `Durbun.start` before anything starts: Flutter apps leave the native layer to the
/// plugin, and builds without `DEBUG` run only with `allowInReleaseBuilds`.
final class StartGuardTests: SDKTestCase {
    private func asRelease() {
        DurbunCore.shared.overrides.releaseBuild = true
    }

    func testForcedReleaseBuildsRun() {
        asRelease()
        var forced = options()
        forced.allowInReleaseBuilds = true
        startConnected(forced)
        XCTAssertTrue(Durbun.isRunning)
    }

    func testReleaseBuildsStillNeedTheOptIn() {
        asRelease()
        Durbun.start(options: options())
        XCTAssertFalse(Durbun.isRunning)
    }

    func testFlutterAppsLeaveTheNativeLayerToThePlugin() {
        DurbunCore.shared.overrides.flutterPluginPresent = true
        Durbun.start(options: options())
        XCTAssertFalse(Durbun.isRunning, "a stray native call opens no second session")
        XCTAssertNil(NSClassFromString(DurbunCore.flutterPluginClass), "native-only apps have no plugin class")
    }
}
