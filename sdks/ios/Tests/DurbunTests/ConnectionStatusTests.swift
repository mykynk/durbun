import Network
import XCTest
@testable import Durbun

/// Connection diagnosis (same table as the other SDKs), the run-time desktop address and the wording
/// of MetricKit diagnostics.
final class ConnectionStatusTests: SDKTestCase {
    private var suiteName = ""
    private var defaults: UserDefaults!

    override func setUpWithError() throws {
        try super.setUpWithError()
        suiteName = "dev.durbun.tests.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
        DurbunCore.shared.overrides.defaults = defaults
        DurbunCore.shared.overrides.infoPlistHost = .some(nil)
    }

    override func tearDown() {
        super.tearDown()
        defaults?.removePersistentDomain(forName: suiteName)
        defaults = nil
    }

    private func diagnose(_ attempts: [ConnectAttempt], platform: String = "android", physical: Bool = true, lan: String? = nil) -> ConnectIssue {
        ConnectionDiagnosis.diagnose(attempts: attempts, platform: platform, isPhysical: physical, lanEndpoint: lan)
    }

    func testDiagnosisMatchesTheOtherSdks() {
        let loop = { (kind: String) in ConnectAttempt(endpoint: "127.0.0.1:9751", kind: kind) }
        XCTAssertEqual(diagnose([loop("refused")]), .usbNotSetUp)
        XCTAssertEqual(diagnose([loop("closed")]), .usbDesktopClosed)
        XCTAssertEqual(diagnose([loop("refused")], platform: "ios"), .iosUsbWaiting)
        XCTAssertEqual(diagnose([loop("refused")], platform: "ios", physical: false), .desktopNotRunning)
        XCTAssertEqual(diagnose([loop("refused")], platform: "other"), .desktopNotRunning)
        XCTAssertEqual(diagnose([loop("no-welcome")], platform: "other"), .notDurbun)
        let lan = "192.168.1.20:9751"
        let withLan = { (kind: String) in [loop("refused"), ConnectAttempt(endpoint: lan, kind: kind)] }
        XCTAssertEqual(diagnose(withLan("refused"), lan: lan), .lanRefused)
        XCTAssertEqual(diagnose(withLan("timeout"), lan: lan), .lanTimeout)
        XCTAssertEqual(diagnose(withLan("unreachable"), lan: lan), .lanUnreachable)
        XCTAssertEqual(diagnose(withLan("lookup"), lan: lan), .lanBadAddress)
        XCTAssertEqual(diagnose(withLan("no-welcome"), lan: lan), .notDurbun)
        XCTAssertEqual(diagnose(withLan("error"), lan: lan), .other)
        XCTAssertEqual(diagnose([loop("denied")]), .permissionDenied)

        let text = ConnectionDiagnosis.consoleHint(.lanRefused, attempts: withLan("refused"), port: 9751, lanEndpoint: lan)
        XCTAssertTrue(text.hasPrefix("Dürbün: not connected"))
        XCTAssertTrue(text.contains("Allow local network"))
        XCTAssertTrue(text.contains("192.168.1.20:9751 refused"))
        XCTAssertTrue(ConnectionDiagnosis.nextStep(.iosUsbWaiting, port: 9751, lanEndpoint: nil).contains("-DurbunHost"))
        for issue in ConnectIssue.allCases {
            XCTAssertFalse(ConnectionDiagnosis.nextStep(issue, port: 9751, lanEndpoint: "x:1").isEmpty)
        }
    }

    func testNetworkErrorsAreSorted() {
        XCTAssertEqual(AttemptKind.classify(.posix(.ECONNREFUSED)), AttemptKind.refused)
        XCTAssertEqual(AttemptKind.classify(.posix(.ETIMEDOUT)), AttemptKind.timeout)
        XCTAssertEqual(AttemptKind.classify(.posix(.EHOSTUNREACH)), AttemptKind.unreachable)
        XCTAssertEqual(AttemptKind.classify(.posix(.ENETUNREACH)), AttemptKind.unreachable)
        XCTAssertEqual(AttemptKind.classify(.dns(-65554)), AttemptKind.lookup)
        XCTAssertEqual(AttemptKind.classify(.dns(-65570)), AttemptKind.denied)
        XCTAssertEqual(AttemptKind.classify(.posix(.ECONNREFUSED), localNetworkDenied: true), AttemptKind.denied)
        XCTAssertEqual(AttemptKind.classify(.posix(.EIO)), AttemptKind.error)
    }

    func testDesktopAddressTakesWhatAPersonTypes() {
        let ok = { (input: String) in DesktopAddress.parse(input)?.description }
        XCTAssertEqual(ok("192.168.1.20"), "192.168.1.20")
        XCTAssertEqual(ok("  192.168.1.20:9751 "), "192.168.1.20:9751")
        XCTAssertEqual(ok("http://192.168.1.20:9751/"), "192.168.1.20:9751")
        XCTAssertEqual(ok("my-mac.local"), "my-mac.local")
        XCTAssertEqual(ok("[fe80::1]:9751"), "[fe80::1]:9751")
        XCTAssertEqual(ok("[fe80::1]"), "fe80::1")
        XCTAssertEqual(ok("fe80::1"), "fe80::1")
        for bad in ["", "   ", "192.168.1", "192.168.1.300", "1.2.3.99999999999", "my mac", "mac/path", "-mac",
                    "192.168.1.20:0", "192.168.1.20:70000", "192.168.1.20:abc", "192.168.1.20:"] {
            XCTAssertNil(DesktopAddress.parse(bad), bad)
        }
    }

    func testBuildAddressPrecedence() {
        XCTAssertEqual(DurbunCore.buildHost(options: "10.0.0.1", environment: "10.0.0.2", infoPlist: "10.0.0.3")?.source, "options")
        XCTAssertEqual(DurbunCore.buildHost(options: nil, environment: "10.0.0.2", infoPlist: "10.0.0.3")?.source, "environment")
        let plist = DurbunCore.buildHost(options: " ", environment: nil, infoPlist: "10.0.0.3:9800")
        XCTAssertEqual(plist?.source, "infoPlist")
        XCTAssertEqual(plist?.address.port, 9800)
        XCTAssertNil(DurbunCore.buildHost(options: nil, environment: nil, infoPlist: "$(DURBUN_HOST)"), "an undefined build setting")
    }

    func testStatusExplainsAMissingDesktop() {
        DurbunCore.shared.overrides.consoleHintDelay = 0.2
        XCTAssertEqual(Durbun.connectionStatus.issue, "notStarted")
        Durbun.start(options: options(port: freeLocalPort()))
        XCTAssertTrue(waitUntil { Durbun.connectionStatus.issue != nil })
        let status = Durbun.connectionStatus
        XCTAssertFalse(status.isConnected)
        XCTAssertEqual(status.issue, "desktopNotRunning")
        XCTAssertTrue(status.hint?.contains("open the Dürbün Mac app") == true)
        XCTAssertGreaterThanOrEqual(status.failedAttempts, 1)
        XCTAssertNil(status.desktopHost)
    }

    func testARunTimeAddressConnectsAtOnceAndIsKeptForTheNextLaunch() throws {
        let deadPort = freeLocalPort()
        let changed = expectation(forNotification: Durbun.connectionStatusDidChangeNotification, object: nil)
        changed.assertForOverFulfill = false
        Durbun.start(options: options(port: deadPort))
        XCTAssertTrue(waitUntil { Durbun.connectionStatus.failedAttempts >= 1 })

        XCTAssertFalse(Durbun.setDesktopHost("not an address"))
        XCTAssertTrue(Durbun.setDesktopHost("127.0.0.1:\(desktop.port)"))
        XCTAssertTrue(waitUntil { Durbun.isConnected })
        wait(for: [changed], timeout: 2)
        var status = Durbun.connectionStatus
        XCTAssertEqual(status.via, "127.0.0.1:\(desktop.port)")
        XCTAssertEqual(status.desktopHost, "127.0.0.1:\(desktop.port)")
        XCTAssertEqual(status.desktopHostSource, "runtime")
        XCTAssertNil(status.issue)
        XCTAssertEqual(defaults.string(forKey: DurbunCore.savedHostKey), "127.0.0.1:\(desktop.port)")

        // Next launch: the saved address wins over the build's.
        Durbun.stop()
        Durbun.start(options: DurbunOptions(host: "10.9.9.9", port: deadPort, captureStdout: false, captureNetwork: false,
                                            captureCrashes: false, collectMetrics: false))
        XCTAssertTrue(waitUntil { Durbun.isConnected })
        XCTAssertEqual(Durbun.connectionStatus.desktopHostSource, "runtime")

        // Clearing goes back to the build's address and closes the Wi-Fi link.
        XCTAssertTrue(Durbun.setDesktopHost(nil))
        XCTAssertTrue(waitUntil { !Durbun.isConnected })
        status = Durbun.connectionStatus
        XCTAssertEqual(status.desktopHostSource, "options")
        XCTAssertEqual(status.desktopHost, "10.9.9.9:\(deadPort)")
        XCTAssertNil(defaults.string(forKey: DurbunCore.savedHostKey))
    }

    // MARK: MetricKit diagnostics

    private let tree = Data(#"""
    {"callStackPerThread": true, "callStacks": [
      {"threadAttributed": false, "callStackRootFrames": [{"binaryName": "Other", "address": 1, "offsetIntoBinaryTextSegment": 1}]},
      {"threadAttributed": true, "callStackRootFrames": [{"binaryName": "Pati", "address": 4294983680, "offsetIntoBinaryTextSegment": 16384,
        "subFrames": [{"binaryName": "UIKitCore", "address": 7000, "offsetIntoBinaryTextSegment": 70}]}]}
    ]}
    """#.utf8)

    private func record(_ kind: SystemDiagnosticRecord.Kind) -> SystemDiagnosticRecord {
        SystemDiagnosticRecord(kind: kind, timestamp: 1_700_000_000, appVersion: "1.4.0", appBuild: "140", osVersion: "iPhone OS 18.1")
    }

    private func object(_ report: SystemDiagnosticReport?) throws -> [String: Any] {
        let line = JSONWriter.line(try XCTUnwrap(report).message)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: line) as? [String: Any])
    }

    func testDiagnosticsSayWhatTheAppCouldNotSee() throws {
        let caught = Set(SignalCrashRecorder.fatalSignals)
        var watchdog = record(.crash)
        watchdog.signal = Int(SIGKILL)
        watchdog.terminationReason = "Namespace SPRINGBOARD, Code 0x8badf00d"
        watchdog.callStackTree = tree
        let crash = try object(SystemDiagnosticReports.report(for: watchdog, caughtSignals: caught))
        XCTAssertEqual(crash["kind"] as? String, "crash")
        XCTAssertEqual(crash["level"] as? String, "fatal")
        XCTAssertTrue((crash["message"] as? String)?.contains("watchdog") == true)
        let stack = try XCTUnwrap((crash["error"] as? [String: Any])?["stack"] as? String)
        XCTAssertTrue(stack.hasPrefix("0  Pati  0x100004000 + 16384"), stack)
        XCTAssertTrue(stack.contains("1  UIKitCore"))
        XCTAssertTrue(SystemDiagnosticReports.report(for: watchdog, caughtSignals: caught)!.desktopReadsIt)

        var segv = record(.crash)
        segv.signal = Int(SIGSEGV)
        XCTAssertNil(SystemDiagnosticReports.report(for: segv, caughtSignals: caught), "the signal handler reported it")

        var hang = record(.hang)
        hang.duration = 3.24
        hang.callStackTree = tree
        let hangLine = try object(SystemDiagnosticReports.report(for: hang, caughtSignals: caught))
        XCTAssertEqual(hangLine["level"] as? String, "warn")
        XCTAssertEqual(hangLine["message"] as? String, "The main thread hung for 3.2 s in an earlier launch (reported by iOS).")
        XCTAssertEqual(hangLine["ts"] as? Double, 1_700_000_000_000)
        XCTAssertFalse(SystemDiagnosticReports.report(for: hang, caughtSignals: caught)!.desktopReadsIt)

        var disk = record(.diskWriteException)
        disk.writtenMB = 1024
        XCTAssertTrue((try object(SystemDiagnosticReports.report(for: disk, caughtSignals: caught))["message"] as? String)?
            .contains("1024 MB") == true)
    }
}
