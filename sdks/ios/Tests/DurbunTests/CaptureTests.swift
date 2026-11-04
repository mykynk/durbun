import XCTest
@testable import Durbun

final class StdioCaptureTests: SDKTestCase {
    func testPrintAndStderrBecomeReadableLogs() throws {
        startConnected(options(stdout: true))
        print("Kullanıcı giriş yaptı ✓")
        print("payload = {\n  \"id\": 7,\n  \"ok\": true\n}")
        FileHandle.standardError.write(Data("warning: disk almost full\n".utf8))
        fputs("2026-11-02 12:00:01.123456+0300 Pati[1234:5678] NSLog style line\n", stderr)

        let plain = try XCTUnwrap(desktop.waitForType("log") { $0["message"] as? String == "Kullanıcı giriş yaptı ✓" })
        XCTAssertEqual(plain["tag"] as? String, "stdout")
        XCTAssertEqual(plain["level"] as? String, "info")

        let grouped = try XCTUnwrap(desktop.waitForType("log") { ($0["message"] as? String)?.hasPrefix("payload = {") == true })
        XCTAssertEqual(grouped["message"] as? String, "payload = {\n  \"id\": 7,\n  \"ok\": true\n}", "multi-line output stays one entry")

        let warning = try XCTUnwrap(desktop.waitForType("log") { $0["message"] as? String == "warning: disk almost full" })
        XCTAssertEqual(warning["tag"] as? String, "stderr")
        XCTAssertEqual(warning["level"] as? String, "warn")

        XCTAssertNotNil(desktop.waitForType("log") { $0["message"] as? String == "NSLog style line" }, "NSLog prefix removed")
    }

    func testOwnOSLogIsForwardedOnlyWhileTheDesktopHasNoDeviceLogs() throws {
        try XCTSkipUnless(OSLogCapture.isAvailable, "OSLogStore needs macOS 12 / iOS 15")
        startConnected(options(stdout: true)) // the fake desktop reads no device logs (Wi-Fi)
        XCTAssertNotNil(desktop.waitForType("log") {
            ($0["message"] as? String)?.hasPrefix("The desktop cannot read this device's logs") == true
        })
        XCTAssertEqual(DurbunCore.shared.osLogMode, .fast)
        desktop.send(["type": "config", "config": ["deviceLogsAvailable": true]])
        XCTAssertTrue(waitUntil { DurbunCore.shared.osLogMode == .off }, "USB: the desktop streams them itself")
    }

    func testStopRestoresDescriptors() throws {
        let before = fcntlStatus(STDOUT_FILENO)
        startConnected(options(stdout: true))
        Durbun.stop()
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(fcntlStatus(STDOUT_FILENO), before, "stdout points back to the original file")
        print("after stop goes to the console only")
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertFalse(desktop.all.contains { ($0.object["message"] as? String)?.contains("after stop") == true })
    }

    private func fcntlStatus(_ fd: Int32) -> String {
        var info = stat()
        fstat(fd, &info)
        return "\(info.st_dev):\(info.st_ino):\(info.st_mode)"
    }
}

final class CrashCaptureTests: XCTestCase {
    private var directory: URL!
    private var originalDirectory: URL!

    override func setUp() {
        super.setUp()
        originalDirectory = CrashCapture.reportsDirectory
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("durbun-crash-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        CrashCapture.reportsDirectory = directory
    }

    override func tearDown() {
        try? FileManager.default.removeItem(at: directory)
        CrashCapture.reportsDirectory = originalDirectory
        super.tearDown()
    }

    func testUncaughtExceptionMessage() throws {
        let exception = NSException(name: .invalidArgumentException, reason: "-[__NSCFNumber length]: unrecognized selector", userInfo: ["screen": "Profile"])
        let message = CrashCapture.crashMessage(for: exception, ts: 1000)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONWriter.line(message)) as? [String: Any])
        XCTAssertEqual(object["type"] as? String, "log")
        XCTAssertEqual(object["kind"] as? String, "crash")
        XCTAssertEqual(object["level"] as? String, "fatal")
        XCTAssertEqual(object["tag"] as? String, "crash")
        XCTAssertEqual(object["message"] as? String, "Uncaught exception NSInvalidArgumentException: -[__NSCFNumber length]: unrecognized selector")
        XCTAssertEqual((object["error"] as? [String: Any])?["type"] as? String, "NSInvalidArgumentException")
        XCTAssertEqual((object["data"] as? [String: Any])?["screen"] as? String, "Profile")
    }

    func testExceptionHandlerChainsAndRestores() {
        let before = NSGetUncaughtExceptionHandler()
        CrashCapture.install()
        XCTAssertNotNil(NSGetUncaughtExceptionHandler())
        CrashCapture.uninstall()
        let after = NSGetUncaughtExceptionHandler()
        XCTAssertEqual(before.map { unsafeBitCast($0, to: UnsafeRawPointer.self) }, after.map { unsafeBitCast($0, to: UnsafeRawPointer.self) })
    }

    func testSignalHandlersAreInstalledAndRestored() {
        var before = sigaction()
        sigaction(SIGSEGV, nil, &before)
        CrashCapture.install()
        var during = sigaction()
        sigaction(SIGSEGV, nil, &during)
        XCTAssertNotNil(during.__sigaction_u.__sa_sigaction)
        XCTAssertNotEqual(during.sa_flags & SA_SIGINFO, 0)
        CrashCapture.uninstall()
        var after = sigaction()
        sigaction(SIGSEGV, nil, &after)
        XCTAssertEqual(unsafeBitCast(after.__sigaction_u.__sa_handler, to: Int.self), unsafeBitCast(before.__sigaction_u.__sa_handler, to: Int.self))
    }

    func testPendingSignalReportBecomesCrashLog() throws {
        let report = """
        DURBUN-SIGNAL-REPORT 1
        signal=5
        time=1730540000
        --- output ---
        Loading profile…
        Pati/ProfileViewModel.swift:88: Fatal error: Unexpectedly found nil while unwrapping an Optional value
        --- backtrace ---
        0   Pati   0x0000000100a4c2f4 $s4Pati16ProfileViewModelC4loadyyF + 120
        1   Pati   0x0000000100a4c000 main + 40
        """
        try report.write(to: CrashCapture.signalReportURL, atomically: true, encoding: .utf8)
        let messages = CrashCapture.takePendingReports()
        XCTAssertEqual(messages.count, 1)
        XCTAssertFalse(FileManager.default.fileExists(atPath: CrashCapture.signalReportURL.path), "reports are sent once")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONWriter.line(messages[0])) as? [String: Any])
        XCTAssertEqual(object["kind"] as? String, "crash")
        XCTAssertEqual(object["level"] as? String, "fatal")
        XCTAssertEqual(object["ts"] as? Double, 1_730_540_000_000)
        XCTAssertEqual(object["message"] as? String,
                       "Crash in previous launch: Pati/ProfileViewModel.swift:88: Fatal error: Unexpectedly found nil while unwrapping an Optional value")
        let error = try XCTUnwrap(object["error"] as? [String: Any])
        XCTAssertEqual(error["type"] as? String, "SIGTRAP")
        XCTAssertTrue((error["stack"] as? String ?? "").contains("ProfileViewModel"))
        XCTAssertEqual((object["data"] as? [String: Any])?["previousLaunch"] as? Bool, true)
        XCTAssertTrue(CrashCapture.takePendingReports().isEmpty)
    }

    func testPendingExceptionReportWinsOverItsSignal() throws {
        let exception = NSException(name: .rangeException, reason: "index 3 beyond bounds", userInfo: nil)
        try JSONWriter.line(CrashCapture.crashMessage(for: exception)).write(to: CrashCapture.exceptionReportURL)
        try "DURBUN-SIGNAL-REPORT 1\nsignal=6\ntime=1\n".write(to: CrashCapture.signalReportURL, atomically: true, encoding: .utf8)
        let messages = CrashCapture.takePendingReports()
        XCTAssertEqual(messages.count, 1, "the SIGABRT that follows an uncaught exception is the same crash")
        XCTAssertEqual(messages.first?["message"]?.stringValue, "Crash in previous launch: Uncaught exception NSRangeException: index 3 beyond bounds")
    }

    func testSignalHandlerWritesAReportForTheNextLaunch() throws {
        CrashCapture.install()
        defer { CrashCapture.uninstall() }
        var console = Array("Cart açıldı\nPati/CartViewModel.swift:31: Fatal error: Index out of range (durbun-test)\n".utf8)
        console.withUnsafeMutableBufferPointer { ConsoleTail.record($0.baseAddress!, count: $0.count) }
        // The real async-signal-safe writer. For SIGSEGV outside a fault it only writes the report
        // and restores the previous disposition (no re-raise).
        SignalCrashRecorder.handle(SIGSEGV)
        let raw = try String(contentsOf: CrashCapture.signalReportURL, encoding: .utf8)
        XCTAssertTrue(raw.hasPrefix("DURBUN-SIGNAL-REPORT 1\nsignal=11\ntime="), raw)
        let messages = CrashCapture.takePendingReports()
        XCTAssertEqual(messages.count, 1)
        XCTAssertEqual(messages.first?["message"]?.stringValue,
                       "Crash in previous launch: Pati/CartViewModel.swift:31: Fatal error: Index out of range (durbun-test)")
        XCTAssertEqual(messages.first?["error"]?["type"]?.stringValue, "SIGSEGV")
        XCTAssertFalse((messages.first?["error"]?["stack"]?.stringValue ?? "").isEmpty, "backtrace_symbols_fd output")
        XCTAssertEqual(messages.first?["kind"]?.stringValue, "crash")
    }

    func testSignalReportWithoutConsoleOutputExplainsTheSignal() {
        let report = SignalReport(data: Data("DURBUN-SIGNAL-REPORT 1\nsignal=11\ntime=5\n--- output ---\n--- backtrace ---\n0 x\n".utf8))
        XCTAssertNotNil(report)
        XCTAssertEqual(report?.message()["message"]?.stringValue, "Crash in previous launch: SIGSEGV (EXC_BAD_ACCESS — invalid memory access)")
        XCTAssertNil(SignalReport(data: Data("garbage".utf8)))
    }
}

private var previousHandlerCalls = 0
private func previousTestExceptionHandler(_ exception: NSException) {
    previousHandlerCalls += 1
}

final class CrashEndToEndTests: SDKTestCase {
    private var directory: URL!
    private var originalDirectory: URL!

    override func setUpWithError() throws {
        try super.setUpWithError()
        originalDirectory = CrashCapture.reportsDirectory
        directory = FileManager.default.temporaryDirectory.appendingPathComponent("durbun-crash-e2e-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        CrashCapture.reportsDirectory = directory
    }

    override func tearDown() {
        super.tearDown()
        NSSetUncaughtExceptionHandler(nil)
        try? FileManager.default.removeItem(at: directory)
        CrashCapture.reportsDirectory = originalDirectory
    }

    func testUncaughtExceptionIsReportedLiveAndChained() throws {
        previousHandlerCalls = 0
        NSSetUncaughtExceptionHandler(previousTestExceptionHandler)
        startConnected(options(crashes: true))
        let installed = try XCTUnwrap(NSGetUncaughtExceptionHandler())
        // What the Objective-C runtime does for an uncaught exception.
        installed(NSException(name: .genericException, reason: "Sepet boş olamaz", userInfo: ["cartId": 7]))

        XCTAssertEqual(previousHandlerCalls, 1, "the previously installed handler still runs")
        let crash = try XCTUnwrap(desktop.waitForType("log") { $0["kind"] as? String == "crash" })
        XCTAssertEqual(crash["message"] as? String, "Uncaught exception NSGenericException: Sepet boş olamaz")
        XCTAssertEqual(crash["level"] as? String, "fatal")
        XCTAssertEqual((crash["data"] as? [String: Any])?["cartId"] as? Int, 7)
        XCTAssertFalse(FileManager.default.fileExists(atPath: CrashCapture.exceptionReportURL.path),
                       "delivered live, so nothing is left for the next launch")

        Durbun.stop()
        let restored = NSGetUncaughtExceptionHandler().map { unsafeBitCast($0, to: UnsafeRawPointer.self) }
        let previous = unsafeBitCast(previousTestExceptionHandler as @convention(c) (NSException) -> Void, to: UnsafeRawPointer.self)
        XCTAssertEqual(restored, previous, "stop() restores the previous handler")
    }

    func testReportsFromThePreviousLaunchAreSentAfterConnecting() throws {
        try "DURBUN-SIGNAL-REPORT 1\nsignal=5\ntime=1730540000\n--- output ---\nMain.swift:3: Fatal error: boom\n--- backtrace ---\n0 x\n"
            .write(to: CrashCapture.signalReportURL, atomically: true, encoding: .utf8)
        startConnected(options(crashes: true))
        let crash = try XCTUnwrap(desktop.waitForType("log") { $0["kind"] as? String == "crash" })
        XCTAssertEqual(crash["message"] as? String, "Crash in previous launch: Main.swift:3: Fatal error: boom")
        XCTAssertTrue(waitUntil { !FileManager.default.fileExists(atPath: CrashCapture.signalReportURL.path) })
    }
}

final class MetricsTests: XCTestCase {
    func testProcessMetrics() throws {
        let memory = try XCTUnwrap(ProcessMetrics.memoryFootprintMB())
        XCTAssertGreaterThan(memory, 1)
        let cpu = try XCTUnwrap(ProcessMetrics.cpuUsage())
        XCTAssertGreaterThan(cpu.threads, 0)
        XCTAssertGreaterThanOrEqual(cpu.percent, 0)
    }

    func testReporterSendsSamples() throws {
        let received = expectation(description: "metric")
        received.assertForOverFulfill = false
        var sample: JSONValue?
        let reporter = MetricsReporter { message in
            sample = message
            received.fulfill()
        }
        reporter.start(intervalMs: 250)
        wait(for: [received], timeout: 3)
        reporter.stop()
        let value = try XCTUnwrap(sample)
        XCTAssertEqual(value["type"], .string("metric"))
        XCTAssertNotNil(value["memoryMB"]?.doubleValue)
        XCTAssertNotNil(value["cpu"]?.doubleValue)
        XCTAssertNotNil(value["threads"]?.doubleValue)
        XCTAssertNil(value["fps"], "no display link on macOS")
    }
}

final class MetricsEndToEndTests: SDKTestCase {
    func testMetricsFollowTheDesktopInterval() throws {
        desktop.config["metricsIntervalMs"] = 250
        startConnected(options(metrics: true))
        let metrics = desktop.waitForCount(2, timeout: 3) { $0.type == "metric" }
        XCTAssertGreaterThanOrEqual(metrics.count, 2)
        XCTAssertNotNil(metrics.first?.object["memoryMB"] as? Double)
    }
}

final class EnvironmentAndCommandTests: XCTestCase {
    func testEnvironment() {
        let environment = AppEnvironment.current()
        XCTAssertFalse(environment.app.id.isEmpty)
        XCTAssertFalse(environment.app.name.isEmpty)
        XCTAssertEqual(environment.app.pid, Int(ProcessInfo.processInfo.processIdentifier))
        XCTAssertEqual(environment.app.debug, true)
        XCTAssertEqual(environment.device.platform, "other")
        XCTAssertEqual(environment.device.manufacturer, "Apple")
        XCTAssertNotNil(environment.device.model)
        XCTAssertNotNil(AppEnvironment.machineIdentifier())
        XCTAssertFalse(AppEnvironment.isPhysicalIOSDevice)
    }

    func testCommandCenter() {
        let center = CommandCenter()
        let unknown = expectation(description: "unknown")
        center.handle(name: "nope", params: [:]) { result in
            XCTAssertFalse(result.ok)
            XCTAssertEqual(result.error, "Unknown command 'nope'")
            unknown.fulfill()
        }
        var changes = 0
        center.onChange = { changes += 1 }
        center.register(DurbunAction(id: "app.env", label: "Environment", kind: .select(
            options: [.init(value: "prod", label: "Production"), .init(value: "staging", label: "Staging")], value: "prod"
        ))) { params in "switched to \(params["value"] as? String ?? "?")" }
        XCTAssertEqual(changes, 1)
        let descriptor = center.descriptors().first { $0.id == "app.env" }
        XCTAssertEqual(descriptor?.kind, "select")
        XCTAssertEqual(descriptor?.value, .string("prod"))
        XCTAssertEqual(descriptor?.options?.count, 2)

        let selected = expectation(description: "select")
        center.handle(name: "app.env", params: ["value": "staging"]) { result in
            XCTAssertTrue(result.ok)
            XCTAssertEqual(result.data, .string("switched to staging"))
            selected.fulfill()
        }
        wait(for: [unknown, selected], timeout: 3)
        XCTAssertTrue(waitFor { center.descriptors().first { $0.id == "app.env" }?.value == .string("staging") })
        center.remove(id: "app.env")
        XCTAssertNil(center.descriptors().first { $0.id == "app.env" })
    }

    private func waitFor(_ condition: () -> Bool) -> Bool {
        for _ in 0..<200 {
            if condition() { return true }
            RunLoop.current.run(until: Date().addingTimeInterval(0.01))
        }
        return condition()
    }
}
