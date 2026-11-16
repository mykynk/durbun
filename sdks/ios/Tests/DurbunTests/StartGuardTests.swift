import XCTest
@testable import Durbun

/// The checks in `Durbun.start` before anything starts: Flutter apps leave the native layer to the
/// plugin, and builds without `DEBUG` run only when they are development builds or opted in.
final class StartGuardTests: SDKTestCase {
    /// A build the package sees without `DEBUG`, on a device, without a debugger, not development-signed.
    private func asRelease() {
        DurbunCore.shared.overrides.releaseBuild = true
        DurbunCore.shared.overrides.debuggerAttached = false
        DurbunCore.shared.overrides.developmentSigned = .some(nil)
        DurbunCore.shared.overrides.infoPlistEnabled = .some(nil)
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
        XCTAssertFalse(waitUntil(timeout: 0.5) { Durbun.isRunning })
    }

    func testAdHocSignedBuildsStayOff() {
        asRelease()
        DurbunCore.shared.overrides.developmentSigned = false
        Durbun.start(options: options())
        XCTAssertFalse(waitUntil(timeout: 0.5) { Durbun.isRunning })
    }

    func testDevelopmentSignedBuildsRunWithoutDebug() {
        asRelease()
        DurbunCore.shared.overrides.developmentSigned = true
        Durbun.start(options: options())
        XCTAssertNotNil(desktop.waitForType("hello"), "starts after the signing check")
        XCTAssertTrue(waitUntil { Durbun.isConnected })
    }

    func testStopRightAfterStartLeavesItOff() {
        asRelease()
        DurbunCore.shared.overrides.developmentSigned = true
        Durbun.start(options: options())
        Durbun.stop() // whether or not the background check already finished
        XCTAssertFalse(waitUntil(timeout: 0.5) { Durbun.isRunning })
    }

    func testDebuggerOrSimulatorRunsWithoutDebug() {
        asRelease()
        DurbunCore.shared.overrides.debuggerAttached = true
        startConnected()
        XCTAssertTrue(Durbun.isRunning)
    }

    func testInfoPlistSwitch() {
        asRelease()
        DurbunCore.shared.overrides.infoPlistEnabled = "YES"
        startConnected()
        Durbun.stop()

        DurbunCore.shared.overrides.releaseBuild = false
        DurbunCore.shared.overrides.infoPlistEnabled = "NO"
        Durbun.start(options: options())
        XCTAssertFalse(Durbun.isRunning, "NO turns it off in a DEBUG build too")

        DurbunCore.shared.overrides.infoPlistEnabled = "$(DURBUN_ENABLED)"
        startConnected()
    }

    func testAppNameOption() throws {
        var named = options()
        named.appName = "Shop (QA)"
        Durbun.start(options: named)
        let hello = try XCTUnwrap(desktop.waitForType("hello"))
        XCTAssertEqual((hello["app"] as? [String: Any])?["name"] as? String, "Shop (QA)")
    }

    func testInfoPlistValues() {
        XCTAssertEqual(BuildSignals.infoPlistSwitch("YES"), true)
        XCTAssertEqual(BuildSignals.infoPlistSwitch(" true "), true)
        XCTAssertEqual(BuildSignals.infoPlistSwitch(NSNumber(value: true)), true)
        XCTAssertEqual(BuildSignals.infoPlistSwitch("0"), false)
        XCTAssertEqual(BuildSignals.infoPlistSwitch("No"), false)
        XCTAssertNil(BuildSignals.infoPlistSwitch(""))
        XCTAssertNil(BuildSignals.infoPlistSwitch("$(DURBUN_ENABLED)"))
        XCTAssertNil(BuildSignals.infoPlistSwitch(nil))
    }

    func testProvisioningProfileEntitlement() {
        func profile(_ entitlements: String) -> Data {
            var data = Data([0x30, 0x80, 0x06, 0x09]) // CMS envelope bytes around the plist
            data.append(Data("""
            <?xml version="1.0" encoding="UTF-8"?>
            <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
            <plist version="1.0"><dict><key>Name</key><string>Dev</string>
            <key>Entitlements</key><dict>\(entitlements)</dict></dict></plist>
            """.utf8))
            data.append(Data([0x00, 0xA0, 0x82]))
            return data
        }
        XCTAssertEqual(BuildSignals.profileAllowsDebugging(profile("<key>get-task-allow</key><true/>")), true)
        XCTAssertEqual(BuildSignals.profileAllowsDebugging(profile("<key>get-task-allow</key><false/>")), false)
        XCTAssertEqual(BuildSignals.profileAllowsDebugging(profile("<key>aps-environment</key><string>production</string>")), false)
        XCTAssertNil(BuildSignals.profileAllowsDebugging(Data("not a profile".utf8)))
    }

    func testFlutterAppsLeaveTheNativeLayerToThePlugin() {
        DurbunCore.shared.overrides.flutterPluginPresent = true
        Durbun.start(options: options())
        XCTAssertFalse(Durbun.isRunning, "a stray native call opens no second session")
        XCTAssertNil(NSClassFromString(DurbunCore.flutterPluginClass), "native-only apps have no plugin class")
    }
}
