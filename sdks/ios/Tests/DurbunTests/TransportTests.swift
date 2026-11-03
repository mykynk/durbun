import XCTest
@testable import Durbun

final class TransportTests: SDKTestCase {
    func testHelloWelcomeThenBufferedLogsInOrder() throws {
        Durbun.start(options: options())
        // Logged before the handshake: buffered, then flushed after `welcome`.
        Durbun.log("first", level: .debug, tag: "auth", data: ["userId": 42])
        Durbun.info("second")
        Durbun.error("third", error: URLError(.notConnectedToInternet), tag: "net")
        Durbun.event("purchase", ["amount": 49.9, "currency": "TRY"])

        let hello = try XCTUnwrap(desktop.waitForType("hello"))
        XCTAssertEqual(hello["protocol"] as? Int, 1)
        XCTAssertEqual(hello["session"] as? String, DurbunCore.sessionId)
        XCTAssertEqual((hello["sdk"] as? [String: Any])?["platform"] as? String, "ios")
        XCTAssertEqual((hello["sdk"] as? [String: Any])?["version"] as? String, Durbun.version)
        let app = try XCTUnwrap(hello["app"] as? [String: Any])
        XCTAssertEqual(app["pid"] as? Int, Int(ProcessInfo.processInfo.processIdentifier))
        XCTAssertNotNil(app["id"] as? String)
        let device = try XCTUnwrap(hello["device"] as? [String: Any])
        XCTAssertEqual(device["platform"] as? String, "other", "macOS reports 'other'")
        XCTAssertEqual(device["manufacturer"] as? String, "Apple")
        XCTAssertNotNil(device["osVersion"] as? String)

        let received = desktop.waitForCount(4) { ["log", "event"].contains($0.type ?? "") }
        XCTAssertEqual(received.count, 4, "three logs and one event")
        let logs = received.filter { $0.type == "log" }.map(\.object)
        XCTAssertEqual(logs.map { $0["message"] as? String }, ["first", "second", "third"])
        XCTAssertEqual(logs[0]["level"] as? String, "debug")
        XCTAssertEqual(logs[0]["tag"] as? String, "auth")
        XCTAssertEqual((logs[0]["data"] as? [String: Any])?["userId"] as? Int, 42)
        XCTAssertNotNil(logs[0]["tid"] as? Int)
        let error = try XCTUnwrap(logs[2]["error"] as? [String: Any])
        XCTAssertEqual(error["type"] as? String, "NSURLErrorDomain -1009")
        XCTAssertTrue((error["message"] as? String ?? "").isEmpty == false)
        XCTAssertNotNil(error["stack"] as? String)
        XCTAssertFalse((error["stack"] as? String ?? "").contains("6Durbun0A0O"), "SDK frames are dropped from the call site stack")
        let event = try XCTUnwrap(received.first { $0.type == "event" }?.object)
        XCTAssertEqual(event["name"] as? String, "purchase")

        // Everything arrived after hello, on the same connection.
        let all = desktop.all
        XCTAssertEqual(all.first?.type, "hello")
        XCTAssertEqual(Set(all.map(\.connection)).count, 1)
    }

    func testReconnectsWithSameSessionAfterDesktopDrops() throws {
        startConnected()
        Durbun.info("before drop")
        XCTAssertNotNil(desktop.waitForType("log") { $0["message"] as? String == "before drop" })
        desktop.closeConnections()
        XCTAssertTrue(waitUntil { !Durbun.isConnected })
        Durbun.info("while disconnected")
        let hellos = desktop.waitForCount(2) { $0.type == "hello" }
        XCTAssertEqual(hellos.count, 2, "the SDK reconnects on its own")
        XCTAssertEqual(hellos[0].object["session"] as? String, hellos[1].object["session"] as? String)
        let late = try XCTUnwrap(desktop.waitFor { $0.type == "log" && $0.object["message"] as? String == "while disconnected" })
        XCTAssertEqual(late.connection, hellos[1].connection, "buffered while disconnected, flushed on the new connection")
    }

    func testRingBufferDropsOldestAndWarnsAfterReconnect() throws {
        let port = freeLocalPort()
        Durbun.start(options: options(port: port, maxBuffered: 3))
        for i in 1...10 { Durbun.info("message \(i)") }
        Thread.sleep(forTimeInterval: 0.1)
        let lateDesktop = FakeDesktop()
        try lateDesktop.start(port: port)
        defer { lateDesktop.stop() }
        XCTAssertNotNil(lateDesktop.waitForType("hello"))
        let logs = lateDesktop.waitForCount(4) { $0.type == "log" }.map(\.object)
        XCTAssertEqual(logs.prefix(3).map { $0["message"] as? String }, ["message 8", "message 9", "message 10"])
        let warning = try XCTUnwrap(logs.last)
        XCTAssertEqual(warning["level"] as? String, "warn")
        XCTAssertEqual(warning["tag"] as? String, "durbun")
        XCTAssertTrue((warning["message"] as? String ?? "").contains("7 messages were dropped"), "\(warning)")
    }

    func testAnswersPingWithPong() throws {
        startConnected()
        desktop.send(["type": "ping", "ts": 1_730_540_000_000])
        let pong = try XCTUnwrap(desktop.waitForType("pong"))
        XCTAssertNotNil(pong["ts"] as? Double)
    }

    func testUnknownCommandAnswersOkFalse() throws {
        startConnected()
        desktop.send(["type": "command", "id": "c1", "name": "flutter.debugPaint", "params": ["value": true]])
        let result = try XCTUnwrap(desktop.waitForType("command.result"))
        XCTAssertEqual(result["id"] as? String, "c1")
        XCTAssertEqual(result["ok"] as? Bool, false)
        XCTAssertTrue((result["error"] as? String ?? "").contains("Unknown command"))
    }

    func testCustomActionsAreAdvertisedAndExecuted() throws {
        var received: Bool?
        Durbun.registerAction(DurbunAction(id: "app.mockLogin", label: "Mock login", kind: .toggle(false))) { params in
            received = params["value"] as? Bool
            return ["applied": true]
        }
        Durbun.registerAction(DurbunAction(id: "app.fail", label: "Fail")) { _ in
            throw DurbunActionError("Cache is locked")
        }
        defer {
            Durbun.removeAction(id: "app.mockLogin")
            Durbun.removeAction(id: "app.fail")
        }
        startConnected()
        let hello = try XCTUnwrap(desktop.messages(ofType: "hello").first)
        let advertised = try XCTUnwrap(hello["actions"] as? [[String: Any]])
        let toggle = try XCTUnwrap(advertised.first { $0["id"] as? String == "app.mockLogin" })
        XCTAssertEqual(toggle["kind"] as? String, "toggle")
        XCTAssertEqual(toggle["value"] as? Bool, false)
        XCTAssertEqual(toggle["group"] as? String, "app")

        desktop.send(["type": "command", "id": "c2", "name": "app.mockLogin", "params": ["value": true]])
        let result = try XCTUnwrap(desktop.waitForType("command.result") { $0["id"] as? String == "c2" })
        XCTAssertEqual(result["ok"] as? Bool, true)
        XCTAssertEqual((result["data"] as? [String: Any])?["applied"] as? Bool, true)
        XCTAssertEqual(received, true)
        let update = try XCTUnwrap(desktop.waitForType("actions"))
        let updated = (update["actions"] as? [[String: Any]])?.first { $0["id"] as? String == "app.mockLogin" }
        XCTAssertEqual(updated?["value"] as? Bool, true, "the new toggle state is pushed to the desktop")

        desktop.send(["type": "command", "id": "c3", "name": "app.fail"])
        let failure = try XCTUnwrap(desktop.waitForType("command.result") { $0["id"] as? String == "c3" })
        XCTAssertEqual(failure["ok"] as? Bool, false)
        XCTAssertEqual(failure["error"] as? String, "Cache is locked")
    }

    func testDeviceListenerAcceptsOneDesktopConnection() throws {
        let first = freeLocalPort()
        var overrides = DurbunCore.shared.overrides
        overrides.deviceListener = true
        overrides.loopbackClient = false
        DurbunCore.shared.overrides = overrides
        var opts = options()
        opts.devicePorts = first...(first + 1)
        Durbun.start(options: opts)

        // The SDK listens on 127.0.0.1:<first free port>; the desktop arrives through usbmux.
        var listenerPort: UInt16?
        XCTAssertTrue(waitUntil {
            listenerPort = DurbunCore.shared.transportSnapshot?.listenerPort
            return listenerPort != nil
        })
        let usb = desktop.connect(toPort: try XCTUnwrap(listenerPort))
        let hello = try XCTUnwrap(desktop.waitFor { $0.type == "hello" && $0.connection == usb })
        XCTAssertEqual(hello.object["session"] as? String, DurbunCore.sessionId)
        XCTAssertTrue(waitUntil { Durbun.isConnected })
        Durbun.info("over usb")
        let log = try XCTUnwrap(desktop.waitFor { $0.type == "log" && $0.object["message"] as? String == "over usb" })
        XCTAssertEqual(log.connection, usb)
        XCTAssertEqual(DurbunCore.shared.transportSnapshot?.activeOrigin, .usb)

        // A second tunnel while one is active is closed immediately, without a hello.
        let extra = desktop.connect(toPort: try XCTUnwrap(listenerPort))
        XCTAssertTrue(desktop.waitForClose(extra, timeout: 3))
        XCTAssertFalse(desktop.all.contains { $0.connection == extra })
    }

    func testListenerSkipsBusyPorts() throws {
        let blocker = FakeDesktop()
        let busy = freeLocalPort()
        try blocker.start(port: busy)
        defer { blocker.stop() }
        var overrides = DurbunCore.shared.overrides
        overrides.deviceListener = true
        overrides.loopbackClient = false
        DurbunCore.shared.overrides = overrides
        var opts = options()
        opts.devicePorts = busy...(busy + 3)
        Durbun.start(options: opts)
        var chosen: UInt16?
        XCTAssertTrue(waitUntil {
            chosen = DurbunCore.shared.transportSnapshot?.listenerPort
            return chosen != nil
        })
        XCTAssertNotEqual(chosen, busy)
        XCTAssertTrue((busy...(busy + 3)).contains(chosen ?? 0))
    }

    func testFirstCompletedHandshakeWinsAndOthersClose() throws {
        // Loopback client → a desktop that accepts but never answers `hello`;
        // USB listener ← the real desktop, which answers. The USB link must win.
        let silent = FakeDesktop()
        silent.autoWelcome = false
        try silent.start()
        defer { silent.stop() }
        let first = freeLocalPort()
        var overrides = DurbunCore.shared.overrides
        overrides.deviceListener = true
        overrides.loopbackClient = true
        DurbunCore.shared.overrides = overrides
        var opts = options(port: silent.port)
        opts.devicePorts = first...(first + 1)
        Durbun.start(options: opts)

        let pending = try XCTUnwrap(silent.waitFor { $0.type == "hello" })
        var listenerPort: UInt16?
        XCTAssertTrue(waitUntil {
            listenerPort = DurbunCore.shared.transportSnapshot?.listenerPort
            return listenerPort != nil
        })
        let usb = desktop.connect(toPort: try XCTUnwrap(listenerPort))
        XCTAssertNotNil(desktop.waitFor { $0.type == "hello" && $0.connection == usb })
        XCTAssertTrue(waitUntil { Durbun.isConnected })
        XCTAssertTrue(silent.waitForClose(pending.connection, timeout: 3), "the losing candidate is closed")

        Durbun.info("only once")
        XCTAssertNotNil(desktop.waitFor { $0.type == "log" && $0.object["message"] as? String == "only once" })
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertFalse(silent.all.contains { $0.type == "log" }, "nothing is sent to a link without welcome")
        XCTAssertEqual(DurbunCore.shared.transportSnapshot?.activeOrigin, .usb)
    }

    func testStopClosesConnectionAndSilencesAPI() throws {
        startConnected()
        let connection = try XCTUnwrap(desktop.all.first?.connection)
        Durbun.stop()
        XCTAssertFalse(Durbun.isRunning)
        XCTAssertTrue(desktop.waitForClose(connection, timeout: 3))
        Durbun.info("after stop")
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertFalse(desktop.all.contains { $0.object["message"] as? String == "after stop" })
    }

    func testRestartKeepsTheNewConnectionHealthy() throws {
        startConnected()
        Durbun.start(options: options()) // restart: the old transport shuts down asynchronously
        XCTAssertEqual(desktop.waitForCount(2) { $0.type == "hello" }.count, 2)
        XCTAssertTrue(waitUntil { Durbun.isConnected })
        _ = waitUntil(timeout: 0.3) { false }
        XCTAssertTrue(Durbun.isConnected, "the old transport's shutdown must not flip the new link to disconnected")
        Durbun.info("after restart")
        let log = try XCTUnwrap(desktop.waitFor { $0.type == "log" && $0.object["message"] as? String == "after restart" })
        let latestHello = try XCTUnwrap(desktop.all.last { $0.type == "hello" })
        XCTAssertEqual(log.connection, latestHello.connection, "goes over the new connection")
    }

    func testConcurrentLoggingDeliversEverythingInPerThreadOrder() throws {
        startConnected()
        let threads = 8
        let perThread = 200
        DispatchQueue.concurrentPerform(iterations: threads) { thread in
            for i in 0..<perThread { Durbun.debug("t\(thread)-\(i)", tag: "stress") }
        }
        let logs = desktop.waitForCount(threads * perThread, timeout: 10) { $0.object["tag"] as? String == "stress" }
        XCTAssertEqual(logs.count, threads * perThread)
        for thread in 0..<threads {
            let sequence = logs.compactMap { $0.object["message"] as? String }
                .filter { $0.hasPrefix("t\(thread)-") }
                .map { Int($0.split(separator: "-")[1])! }
            XCTAssertEqual(sequence, Array(0..<perThread), "thread \(thread) order")
        }
    }

    func testMockRulesEndWithTheConnectionThatPushedThem() {
        desktop.mocks = [[
            "id": "m1", "enabled": true, "method": "GET", "url": "/users", "match": "contains",
            "action": ["type": "respond", "status": 200], "createdAt": 1,
        ]]
        startConnected()
        XCTAssertTrue(waitUntil { DurbunCore.shared.mockRules.map(\.id) == ["m1"] })
        // Whoever answered the hello is not authenticated: once it is gone, its rules must not stay active.
        desktop.autoWelcome = false
        desktop.closeConnections()
        XCTAssertTrue(waitUntil { !Durbun.isConnected })
        XCTAssertTrue(waitUntil { DurbunCore.shared.mockRules.isEmpty }, "rules dropped with the connection")
        // The desktop's next welcome brings them back.
        desktop.autoWelcome = true
        XCTAssertTrue(waitUntil(timeout: 10) { Durbun.isConnected && DurbunCore.shared.mockRules.count == 1 })
    }

    func testReleaseGuardAndDisabledOption() {
        var disabled = options()
        disabled.enabled = false
        Durbun.start(options: disabled)
        XCTAssertFalse(Durbun.isRunning)
        XCTAssertTrue(DurbunCore.buildAllowsRunning, "tests are built in DEBUG")
    }
}
