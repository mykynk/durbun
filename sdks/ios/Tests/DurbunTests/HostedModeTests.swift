import XCTest
@testable import Durbun

/// Hosted mode (the core inside the Flutter plugin): no socket, messages go to the host, the desktop
/// state comes from the host.
final class HostedModeTests: XCTestCase {
    private final class RecordingLink: HostLink {
        private let lock = NSLock()
        private var _lines: [String] = []
        private var _actions: [String] = []
        var flushResult = true

        var lines: [String] { lock.lock(); defer { lock.unlock() }; return _lines }
        var actions: [String] { lock.lock(); defer { lock.unlock() }; return _actions }

        func deliver(_ lines: [String]) {
            lock.lock()
            _lines += lines
            lock.unlock()
        }

        func actionsChanged(_ descriptorsJSON: String) {
            lock.lock()
            _actions.append(descriptorsJSON)
            lock.unlock()
        }

        func flush(timeout: TimeInterval) -> Bool { flushResult }

        func messages(_ type: String) -> [[String: Any]] {
            lines.compactMap { line in
                (try? JSONSerialization.jsonObject(with: Data(line.utf8))) as? [String: Any]
            }.filter { $0["type"] as? String == type }
        }
    }

    private func hostedOptions(stdout: Bool = false, network: Bool = false) -> DurbunOptions {
        DurbunOptions(captureStdout: stdout, captureNetwork: network, captureCrashes: false, collectMetrics: false)
    }

    override func tearDown() {
        Durbun.stop()
        super.tearDown()
    }

    func testLogsAndEventsGoToTheHostWithoutASocket() {
        let link = RecordingLink()
        XCTAssertTrue(DurbunCore.shared.startHosted(options: hostedOptions(), link: link))
        XCTAssertTrue(DurbunCore.shared.isHosted)
        XCTAssertNil(DurbunCore.shared.transportSnapshot, "no transport in hosted mode")
        for i in 0..<300 { Durbun.info("line \(i)", tag: "auth") }
        Durbun.event("purchase", ["amount": 49.9])
        XCTAssertTrue(spinUntil(timeout: 5) { link.lines.count == 301 })
        let logs = link.messages("log")
        XCTAssertEqual(logs.first?["message"] as? String, "line 0")
        XCTAssertEqual(logs.first?["tag"] as? String, "auth")
        XCTAssertEqual(link.messages("event").first?["name"] as? String, "purchase")
        XCTAssertFalse(link.lines.contains { $0.hasSuffix("\n") }, "lines are handed over without newline")
    }

    func testHostStateDrivesConnectionConfigAndMocks() {
        let core = DurbunCore.shared
        core.startHosted(options: hostedOptions(), link: RecordingLink())
        XCTAssertFalse(core.isConnected)
        core.applyHostState("""
        {"connected":true,"via":"usbmux 127.0.0.1:9752","config":{"captureBodies":false,"maxBodyBytes":2048},
         "mocks":[{"id":"m1","enabled":true,"method":"GET","url":"/todos/","match":"contains",
                   "action":{"type":"respond","status":418}}]}
        """)
        XCTAssertTrue(core.isConnected)
        XCTAssertFalse(core.sdkConfig.captureBodies)
        XCTAssertEqual(core.sdkConfig.maxBodyBytes, 2048)
        XCTAssertEqual(core.mockRules.map(\.id), ["m1"])
        core.applyHostState(#"{"connected":false}"#)
        XCTAssertFalse(core.isConnected)
        XCTAssertFalse(core.sdkConfig.captureBodies, "missing fields keep their value")
        XCTAssertEqual(core.sdkConfig.maxBodyBytes, 2048)
        XCTAssertEqual(core.mockRules.map(\.id), [], "the mock rules end with the connection")

        let rules = #"[{"id":"m2","enabled":true,"method":"GET","url":"/todos/","match":"contains","action":{"type":"respond","status":418}}]"#
        core.applyHostState(#"{"mocks":\#(rules)}"#)
        XCTAssertEqual(core.mockRules.map(\.id), [], "never applied while the host is disconnected")
        core.applyHostState(#"{"connected":true,"mocks":\#(rules)}"#)
        XCTAssertEqual(core.mockRules.map(\.id), ["m2"])
    }

    func testCommandsAnswerThroughTheHostAndActionsAreHandedOver() {
        let link = RecordingLink()
        let core = DurbunCore.shared
        core.startHosted(options: hostedOptions(), link: link)
        Durbun.registerAction(DurbunAction(id: "app.native", label: "From Swift", kind: .button)) { _ in "done" }
        XCTAssertTrue(spinUntil(timeout: 5) { link.actions.contains { $0.contains("app.native") } })
        XCTAssertTrue(core.describeActionsJSON().contains("app.native"))
        core.handleHostCommand(#"{"type":"command","id":"c1","name":"app.native","params":{}}"#)
        core.handleHostCommand(#"{"type":"command","id":"c2","name":"nope","params":{}}"#)
        XCTAssertTrue(spinUntil(timeout: 5) { link.messages("command.result").count == 2 })
        let results = Dictionary(uniqueKeysWithValues: link.messages("command.result").map { ($0["id"] as! String, $0) })
        XCTAssertEqual(results["c1"]?["ok"] as? Bool, true)
        XCTAssertEqual(results["c1"]?["data"] as? String, "done")
        XCTAssertEqual(results["c2"]?["ok"] as? Bool, false)
        XCTAssertTrue(link.messages("actions").isEmpty, "the host publishes the merged list")
        Durbun.removeAction(id: "app.native")
    }

    func testRequestIdsAndRedactionInHostedMode() {
        let core = DurbunCore.shared
        core.startHosted(options: hostedOptions(), link: RecordingLink(), redactedHeaders: ["Authorization"])
        XCTAssertTrue(core.nextRequestId().hasPrefix("ios-"))
        Durbun.start(options: hostedOptions())
        XCTAssertTrue(core.isHosted, "a native Durbun.start() does not replace the Flutter-hosted core")
        let headers = core.redacting([("Authorization", "Bearer x"), ("Accept", "*/*")])
        XCTAssertEqual(headers.map(\.1), ["••••", "*/*"])
        XCTAssertEqual(core.hostedCapabilities(options: hostedOptions(network: true)), ["logs", "events", "commands", "network", "mocks"])
        Durbun.stop()
        XCTAssertFalse(core.isHosted)
    }

    func testFlushDeliversBufferedLinesThenAsksTheHost() {
        let link = RecordingLink()
        let core = DurbunCore.shared
        core.startHosted(options: hostedOptions(), link: link)
        Durbun.info("before crash")
        var flushed = false
        let done = expectation(description: "flush")
        DispatchQueue.global().async {
            flushed = core.flush(timeout: 1)
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        XCTAssertTrue(flushed)
        XCTAssertEqual(link.messages("log").first?["message"] as? String, "before crash")
        link.flushResult = false
        XCTAssertFalse(core.flush(timeout: 0.1), "on the main thread the host cannot answer")
    }

    // MARK: The app's own os_log lines

    func testHostDecidesWhenTheAppsOwnOSLogIsRead() throws {
        try XCTSkipUnless(OSLogCapture.isAvailable, "OSLogStore needs macOS 12 / iOS 15")
        let link = RecordingLink()
        let core = DurbunCore.shared
        core.startHosted(options: hostedOptions(stdout: true), link: link)
        XCTAssertEqual(core.osLogMode, .off, "nobody asked yet")
        core.applyHostState(#"{"connected":false,"deviceLogs":{"read":true,"fast":false,"desktop":false}}"#)
        XCTAssertEqual(core.osLogMode, .slow, "the in-app panel reads them without any desktop")
        core.applyHostState(#"{"deviceLogs":{"fast":true}}"#)
        XCTAssertEqual(core.osLogMode, .fast, "panel open: read often")
        XCTAssertFalse(link.messages("log").contains { Self.isDesktopNote($0) }, "a desktop with device logs gets no note")
        core.applyHostState(#"{"connected":true,"config":{"deviceLogsAvailable":false},"deviceLogs":{"desktop":true}}"#)
        XCTAssertTrue(spinUntil(timeout: 5) { link.messages("log").contains { Self.isDesktopNote($0) } })
        core.applyHostState(#"{"deviceLogs":{"read":false,"fast":false,"desktop":false}}"#)
        XCTAssertEqual(core.osLogMode, .off)
    }

    func testCaptureStdoutOffNeverReadsOSLog() {
        let core = DurbunCore.shared
        core.startHosted(options: hostedOptions(stdout: false), link: RecordingLink())
        core.applyHostState(#"{"connected":true,"deviceLogs":{"read":true,"fast":true,"desktop":true}}"#)
        XCTAssertEqual(core.osLogMode, .off)
    }

    func testOSLogRecordsAreFilteredAndTaggedLikeTheDesktop() {
        func record(_ message: String, level: Int = 3, subsystem: String = "", sender: String = "Runner", tid: UInt64 = 42) -> OSLogCapture.Record {
            OSLogCapture.Record(
                date: Date(timeIntervalSince1970: 1_800_000_000.25),
                level: level,
                subsystem: subsystem,
                sender: sender,
                message: message,
                threadId: tid
            )
        }
        XCTAssertEqual(
            OSLogCapture.entry(from: record("Configured", level: 2, subsystem: "com.google.firebase")),
            OSLogCapture.Entry(ts: 1_800_000_000_250, level: .info, tag: "com.google.firebase", message: "Configured", tid: 42)
        )
        XCTAssertEqual(OSLogCapture.entry(from: record("NSLog line", sender: "Foundation"))?.tag, "Foundation")
        XCTAssertEqual(OSLogCapture.entry(from: record("bare os_log", sender: ""))?.tag, "os_log")
        XCTAssertEqual(OSLogCapture.entry(from: record("db failed", level: 4, subsystem: "app"))?.level, .error)
        XCTAssertEqual(OSLogCapture.entry(from: record("serious", level: 5, subsystem: "app"))?.level, .error, "fault is not a crash")
        XCTAssertEqual(OSLogCapture.entry(from: record("notice", level: 3, subsystem: "app"))?.level, .info)
        XCTAssertNil(OSLogCapture.entry(from: record("x", tid: 0))?.tid)
        XCTAssertNil(OSLogCapture.entry(from: record("activating connection", subsystem: "com.apple.xpc")), "Apple's own lines")
        XCTAssertNil(OSLogCapture.entry(from: record("relay dropped 3", subsystem: Diagnostics.subsystem)), "the SDK's own diagnostics")
        XCTAssertNil(OSLogCapture.entry(from: record("flutter: from Dart")), "Dart sends its print() itself")
        XCTAssertNil(OSLogCapture.entry(from: record("")))
    }

    func testNSLogLinesAlreadySeenOnStderrAreSentOnce() {
        let recent = RecentConsoleLines(capacity: 2)
        recent.remember("Sepete eklendi: 3 ürün\n", ts: 10_000)
        XCTAssertTrue(recent.contains("Sepete eklendi: 3 ürün", near: 11_500))
        XCTAssertFalse(recent.contains("Sepete eklendi: 3 ürün", near: 20_000), "only within a few seconds")
        XCTAssertFalse(recent.contains("başka satır", near: 10_000))
        recent.remember("b", ts: 10_000)
        recent.remember("c", ts: 10_000)
        XCTAssertFalse(recent.contains("Sepete eklendi: 3 ürün", near: 10_000), "bounded: the oldest is forgotten")
    }

    private static func isDesktopNote(_ log: [String: Any]) -> Bool {
        (log["message"] as? String)?.hasPrefix("The desktop cannot read this device's logs") == true
    }
}
