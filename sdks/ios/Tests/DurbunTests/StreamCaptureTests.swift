import XCTest
import ObjectiveC
@testable import Durbun

/// A value written by a task and read by the test after waiting for it.
final class Box<Value> {
    var value: Value

    init(_ value: Value) {
        self.value = value
    }
}

/// Shared helpers: a desktop that asks for stream messages, and lookups by entry.
class StreamTestCase: SDKTestCase {
    static let streamConfig: [String: Any] = [
        "captureBodies": true,
        "maxBodyBytes": 1_048_576,
        "metricsIntervalMs": 1000,
        "deviceLogsAvailable": false,
        "captureStreams": true,
        "maxStreamMessageBytes": 65536,
    ]

    func setStreams(_ on: Bool, cap: Int = 65536, live: Bool = false) {
        var config = Self.streamConfig
        config["captureStreams"] = on
        config["maxStreamMessageBytes"] = cap
        desktop.config = config
        if live {
            desktop.send(["type": "config", "config": config])
            XCTAssertTrue(waitUntil { (DurbunCore.shared.streamMessageCap != nil) == on && (!on || DurbunCore.shared.streamMessageCap == cap) })
        }
    }

    func requestId(urlContaining fragment: String, timeout: TimeInterval = 5) -> String? {
        desktop.waitForType("net.request", timeout: timeout, where: { ($0["url"] as? String)?.contains(fragment) == true })?["id"] as? String
    }

    func messages(_ type: String, id: String) -> [[String: Any]] {
        desktop.messages(ofType: type).filter { $0["id"] as? String == id }
    }

    /// Every message about entry `id`, in arrival order: "net.request", "net.response", "net.ws:out:text", …
    func timeline(_ id: String) -> [String] {
        desktop.all.filter { $0.object["id"] as? String == id }.compactMap { received -> String? in
            guard let type = received.type else { return nil }
            if type == "net.ws" {
                return "net.ws:\(received.object["dir"] as? String ?? "?"):\(received.object["opcode"] as? String ?? "?")"
            }
            return type
        }
    }

    func settle(_ seconds: TimeInterval = 0.3) {
        _ = waitUntil(timeout: seconds) { false }
        StreamPipeline.shared.waitUntilIdle()
    }
}

final class WebSocketCaptureTests: StreamTestCase {
    var server: TestWebSocketServer!

    override func setUpWithError() throws {
        try super.setUpWithError()
        server = TestWebSocketServer()
        try server.start()
        setStreams(true)
    }

    override func tearDown() {
        server?.stop()
        server = nil
        super.tearDown()
    }

    private func url(_ path: String) -> URL { URL(string: "ws://127.0.0.1:\(server.port)\(path)")! }

    private func send(_ task: URLSessionWebSocketTask, _ message: URLSessionWebSocketTask.Message, file: StaticString = #filePath, line: UInt = #line) {
        let done = expectation(description: "send")
        task.send(message) { error in
            XCTAssertNil(error, file: file, line: line)
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
    }

    private func receive(_ task: URLSessionWebSocketTask) -> Result<URLSessionWebSocketTask.Message, Error>? {
        let done = expectation(description: "receive")
        var result: Result<URLSessionWebSocketTask.Message, Error>?
        task.receive { outcome in
            result = outcome
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        return result
    }

    private func receivedText(_ task: URLSessionWebSocketTask) -> String? {
        if case let .success(.string(text))? = receive(task) { return text }
        return nil
    }

    func testHandshakeAndMessagesInTheOrderTheAppSawThem() throws {
        startConnected(options(network: true))
        XCTAssertNotNil(WebSocketCapture.installedClass, "the task class was hooked")
        let task = URLSession.shared.webSocketTask(with: url("/chat?room=1"), protocols: ["chat"])
        task.resume()
        send(task, .string("hello")) // possibly before the 101 was seen
        XCTAssertEqual(receivedText(task), "hello")
        send(task, .data(Data([1, 2, 3])))
        guard case let .success(.data(echo))? = receive(task) else { return XCTFail("no binary echo") }
        XCTAssertEqual(echo, Data([1, 2, 3]), "the app receives exactly what the server sent")
        // URLSession reads the pong only while a receive is pending (as apps keep one).
        let closed = expectation(description: "pending receive ends with the close")
        task.receive { _ in closed.fulfill() }
        let pong = expectation(description: "pong")
        task.sendPing { error in
            XCTAssertNil(error)
            pong.fulfill()
        }
        wait(for: [pong], timeout: 5)
        task.cancel(with: .normalClosure, reason: Data("bye".utf8))
        wait(for: [closed], timeout: 5)

        let id = try XCTUnwrap(requestId(urlContaining: "/chat?room=1"))
        XCTAssertNotNil(desktop.waitFor { $0.type == "net.ws" && $0.object["id"] as? String == id && $0.object["opcode"] as? String == "close" })
        settle()
        XCTAssertEqual(timeline(id), [
            "net.request", "net.response",
            "net.ws:out:text", "net.ws:in:text", "net.ws:out:binary", "net.ws:in:binary",
            "net.ws:out:ping", "net.ws:in:pong", "net.ws:out:close",
        ])
        let request = try XCTUnwrap(messages("net.request", id: id).first)
        XCTAssertEqual(request["method"] as? String, "GET")
        XCTAssertEqual(request["url"] as? String, "ws://127.0.0.1:\(server.port)/chat?room=1")
        XCTAssertEqual(request["source"] as? String, "urlsession")
        let requestHeaders = (request["headers"] as? [[String]] ?? []).reduce(into: [String: String]()) { $0[$1[0].lowercased()] = $1[1] }
        XCTAssertEqual(requestHeaders["upgrade"]?.lowercased(), "websocket")
        XCTAssertEqual(requestHeaders["sec-websocket-protocol"], "chat")
        let response = try XCTUnwrap(messages("net.response", id: id).first)
        XCTAssertEqual(response["status"] as? Int, 101)
        XCTAssertEqual(response["statusText"] as? String, "Switching Protocols")
        XCTAssertNil(response["body"])
        let responseHeaders = (response["headers"] as? [[String]] ?? []).map { $0[0].lowercased() }
        XCTAssertTrue(responseHeaders.contains("sec-websocket-accept"))

        let ws = messages("net.ws", id: id)
        guard ws.count == 7 else { return XCTFail("\(ws.count) net.ws messages") }
        XCTAssertEqual(ws[0]["size"] as? Int, 5)
        XCTAssertEqual((ws[0]["body"] as? [String: Any])?["data"] as? String, "hello")
        XCTAssertEqual((ws[0]["body"] as? [String: Any])?["encoding"] as? String, "utf8")
        XCTAssertEqual((ws[2]["body"] as? [String: Any])?["data"] as? String, "AQID")
        XCTAssertEqual((ws[2]["body"] as? [String: Any])?["encoding"] as? String, "base64")
        XCTAssertEqual(ws[4]["size"] as? Int, 0)
        XCTAssertNil(ws[4]["body"])
        XCTAssertEqual(ws[6]["closeCode"] as? Int, 1000)
        XCTAssertEqual(ws[6]["closeReason"] as? String, "bye")
        XCTAssertEqual(ws[6]["size"] as? Int, 5)
        let tss = ws.compactMap { $0["ts"] as? Double }
        XCTAssertEqual(tss, tss.sorted())
        XCTAssertTrue(messages("net.error", id: id).isEmpty)
        // What the server got is what the app sent.
        XCTAssertEqual(server.received.filter { $0.opcode == .text }.map { String(decoding: $0.data, as: UTF8.self) }, ["hello"])
    }

    @available(macOS 12.0, iOS 15.0, *)
    private func asyncExchange(_ task: URLSessionWebSocketTask) async throws -> String? {
        try await task.send(.string("async"))
        if case let .string(text) = try await task.receive() { return text }
        return nil
    }

    func testTheAsyncAPIIsCaptured() throws {
        guard #available(macOS 12.0, iOS 15.0, *) else { throw XCTSkip("async URLSession API") }
        startConnected(options(network: true))
        let task = URLSession.shared.webSocketTask(with: url("/async"))
        task.resume()
        let done = expectation(description: "async")
        let echoed = Box<String?>(nil)
        Task {
            echoed.value = try? await self.asyncExchange(task)
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        XCTAssertEqual(echoed.value, "async")
        let id = try XCTUnwrap(requestId(urlContaining: "/async"))
        XCTAssertEqual(desktop.waitForCount(2, { $0.type == "net.ws" && $0.object["id"] as? String == id }).count, 2)
        XCTAssertEqual(timeline(id), ["net.request", "net.response", "net.ws:out:text", "net.ws:in:text"])
        task.cancel(with: .goingAway, reason: nil)
    }

    func testServerCloseIsReportedWithItsCodeAndReason() throws {
        startConnected(options(network: true))
        let task = URLSession.shared.webSocketTask(with: url("/server-close"))
        task.resume()
        send(task, .string("close:4001:server bye"))
        guard case .failure? = receive(task) else { return XCTFail("the receive fails once the server closed") }
        let id = try XCTUnwrap(requestId(urlContaining: "/server-close"))
        let close = try XCTUnwrap(desktop.waitForType("net.ws", where: { $0["id"] as? String == id && $0["opcode"] as? String == "close" }))
        XCTAssertEqual(close["dir"] as? String, "in")
        XCTAssertEqual(close["closeCode"] as? Int, 4001)
        XCTAssertEqual(close["closeReason"] as? String, "server bye")
        settle()
        XCTAssertTrue(messages("net.error", id: id).isEmpty, "a close frame is not a failure")
    }

    func testCancelIsReportedAsCancelledAndABrokenConnectionAsAnError() throws {
        startConnected(options(network: true))
        let cancelled = URLSession.shared.webSocketTask(with: url("/cancel"))
        cancelled.resume()
        send(cancelled, .string("x"))
        XCTAssertEqual(receivedText(cancelled), "x")
        cancelled.cancel()
        let cancelledId = try XCTUnwrap(requestId(urlContaining: "/cancel"))
        let error = try XCTUnwrap(desktop.waitForType("net.error", where: { $0["id"] as? String == cancelledId }))
        XCTAssertEqual(error["cancelled"] as? Bool, true)

        let broken = URLSession.shared.webSocketTask(with: url("/broken"))
        broken.resume()
        send(broken, .string("drop"))
        guard case .failure? = receive(broken) else { return XCTFail("the receive fails") }
        let brokenId = try XCTUnwrap(requestId(urlContaining: "/broken"))
        let failure = try XCTUnwrap(desktop.waitForType("net.error", where: { $0["id"] as? String == brokenId }))
        XCTAssertNil(failure["cancelled"])
        settle()
        XCTAssertFalse(timeline(brokenId).contains("net.ws:in:close"))
        XCTAssertEqual(timeline(cancelledId).filter { $0 == "net.error" }.count, 1, "reported once")
    }

    func testAConnectionThatNeverOpensIsAnError() throws {
        startConnected(options(network: true))
        let port = freeLocalPort()
        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(port)/nobody")!)
        task.resume()
        guard case .failure? = receive(task) else { return XCTFail("nothing listens there") }
        let id = try XCTUnwrap(requestId(urlContaining: "/nobody"))
        let error = try XCTUnwrap(desktop.waitForType("net.error", where: { $0["id"] as? String == id }))
        XCTAssertTrue((error["error"] as? String ?? "").contains("-1004"))
        XCTAssertEqual(timeline(id), ["net.request", "net.error"])
    }

    func testAFailedUpgradeIsANormalResponse() throws {
        let http = TestHTTPServer()
        http.handler = { _ in .json(#"{"error":"no websockets here"}"#, status: 404) }
        try http.start()
        defer { http.stop() }
        startConnected(options(network: true))
        let task = URLSession.shared.webSocketTask(with: URL(string: "ws://127.0.0.1:\(http.port)/plain")!)
        task.resume()
        guard case .failure? = receive(task) else { return XCTFail("no upgrade") }
        let id = try XCTUnwrap(requestId(urlContaining: "/plain"))
        settle(0.5)
        let response = messages("net.response", id: id).first
        if let response {
            XCTAssertEqual(response["status"] as? Int, 404)
            XCTAssertEqual(timeline(id), ["net.request", "net.response"])
        } else {
            // URLSession may fail the task without exposing the response: then it is an error.
            XCTAssertEqual(timeline(id), ["net.request", "net.error"])
        }
    }

    func testNothingIsReportedUntilTheDesktopAsksThenTheHandshakeComesFirst() throws {
        setStreams(false)
        desktop.config.removeValue(forKey: "captureStreams") // an older desktop
        startConnected(options(network: true))
        let task = URLSession.shared.webSocketTask(with: url("/gated"))
        task.resume()
        send(task, .string("before"))
        XCTAssertEqual(receivedText(task), "before")
        settle()
        XCTAssertNil(requestId(urlContaining: "/gated", timeout: 0.2), "a WebSocket is not reported while the desktop does not ask")
        XCTAssertTrue(desktop.messages(ofType: "net.ws").isEmpty)

        // On: the open socket is reported at once (its real handshake times), then messages from now on.
        setStreams(true, live: true)
        let id = try XCTUnwrap(requestId(urlContaining: "/gated", timeout: 3))
        XCTAssertNotNil(desktop.waitForType("net.response", where: { $0["id"] as? String == id }))
        let request = try XCTUnwrap(messages("net.request", id: id).first)
        let response = try XCTUnwrap(messages("net.response", id: id).first)
        XCTAssertLessThan(try XCTUnwrap(request["ts"] as? Double), try XCTUnwrap(response["ts"] as? Double))
        send(task, .string("during"))
        XCTAssertEqual(receivedText(task), "during")
        XCTAssertEqual(desktop.waitForCount(2, { $0.type == "net.ws" && $0.object["id"] as? String == id }).count, 2)

        // Off: messages stop at once, but the connection that was reported still ends.
        setStreams(false, live: true)
        send(task, .string("after"))
        XCTAssertEqual(receivedText(task), "after")
        task.cancel(with: .normalClosure, reason: nil)
        XCTAssertNotNil(desktop.waitForType("net.ws", where: { $0["id"] as? String == id && $0["opcode"] as? String == "close" }))
        settle()
        XCTAssertEqual(timeline(id), ["net.request", "net.response", "net.ws:out:text", "net.ws:in:text", "net.ws:out:close"])
    }

    func testPayloadCapAndSizesOnly() throws {
        setStreams(true, cap: 4)
        startConnected(options(network: true))
        let task = URLSession.shared.webSocketTask(with: url("/cap"))
        task.resume()
        send(task, .string("héllo wörld"))
        XCTAssertEqual(receivedText(task), "héllo wörld", "the app's message is untouched")
        send(task, .data(Data(repeating: 7, count: 10)))
        _ = receive(task)
        let id = try XCTUnwrap(requestId(urlContaining: "/cap"))
        let ws = desktop.waitForCount(4, { $0.type == "net.ws" && $0.object["id"] as? String == id }).map(\.object)
        guard ws.count == 4 else { return XCTFail("\(ws.count) net.ws messages") }
        XCTAssertEqual(ws[0]["size"] as? Int, 13)
        XCTAssertEqual((ws[0]["body"] as? [String: Any])?["data"] as? String, "hél", "4 bytes, on a character boundary")
        XCTAssertEqual((ws[0]["body"] as? [String: Any])?["truncated"] as? Bool, true)
        XCTAssertEqual((ws[0]["body"] as? [String: Any])?["size"] as? Int, 13)
        XCTAssertEqual(ws[2]["size"] as? Int, 10)
        XCTAssertEqual((ws[2]["body"] as? [String: Any])?["data"] as? String, Data(repeating: 7, count: 4).base64EncodedString())

        setStreams(true, cap: 0, live: true)
        send(task, .string("sizes only"))
        _ = receive(task)
        let sized = desktop.waitForCount(6, { $0.type == "net.ws" && $0.object["id"] as? String == id }).map(\.object)
        guard sized.count == 6 else { return XCTFail("\(sized.count) net.ws messages") }
        XCTAssertEqual(sized[4]["size"] as? Int, 10)
        XCTAssertNil(sized[4]["body"])
        task.cancel()
    }

    func testManyMessagesKeepTheirOrder() throws {
        startConnected(options(network: true))
        let task = URLSession.shared.webSocketTask(with: url("/many"))
        task.resume()
        send(task, .string("push:200"))
        for index in 1...200 { XCTAssertEqual(receivedText(task), "m\(index)") }
        let id = try XCTUnwrap(requestId(urlContaining: "/many"))
        let incoming = desktop.waitForCount(200, { $0.type == "net.ws" && $0.object["id"] as? String == id && $0.object["dir"] as? String == "in" })
        XCTAssertEqual(incoming.compactMap { ($0.object["body"] as? [String: Any])?["data"] as? String }, (1...200).map { "m\($0)" })
        task.cancel()
    }

    func testTasksStartedWhileCaptureIsOffPassStraightThrough() throws {
        startConnected(options(network: true, ignoredHosts: ["127.0.0.1"]))
        let ignored = URLSession.shared.webSocketTask(with: url("/ignored"))
        ignored.resume()
        send(ignored, .string("a"))
        XCTAssertEqual(receivedText(ignored), "a")
        XCTAssertNil(WebSocketCapture.connection(of: ignored), "an ignored host is never tracked")
        ignored.cancel()
        Durbun.stop()

        startConnected(options(network: true))
        let tracked = URLSession.shared.webSocketTask(with: url("/tracked"))
        tracked.resume()
        send(tracked, .string("b"))
        XCTAssertEqual(receivedText(tracked), "b")
        Durbun.stop()
        // The SDK stopped: the tracked task keeps working and is forgotten; new tasks are not tracked.
        send(tracked, .string("c"))
        XCTAssertEqual(receivedText(tracked), "c")
        XCTAssertTrue(waitUntil { !(WebSocketCapture.connection(of: tracked)?.isLive ?? true) })
        let later = URLSession.shared.webSocketTask(with: url("/later"))
        later.resume()
        send(later, .string("d"))
        XCTAssertEqual(receivedText(later), "d")
        XCTAssertNil(WebSocketCapture.connection(of: later))
        tracked.cancel()
        later.cancel()
        settle()
        XCTAssertNil(requestId(urlContaining: "/ignored", timeout: 0.1))
        XCTAssertNil(requestId(urlContaining: "/later", timeout: 0.1))
    }

    func testHooksAreInstalledOnceAndChainWithAnotherToolsHook() throws {
        startConnected(options(network: true))
        NetworkCapture.install()
        WebSocketCapture.install()
        let cls: AnyClass = try XCTUnwrap(WebSocketCapture.installedClass)
        let selector = NSSelectorFromString("sendMessage:completionHandler:")
        let method = try XCTUnwrap(class_getInstanceMethod(cls, selector))
        // Another tool hooks the same method after Dürbün, calling on to what it found.
        typealias SendIMP = @convention(c) (AnyObject, Selector, AnyObject?, AnyObject?) -> Void
        let ours = method_getImplementation(method)
        var theirCalls = 0
        let theirs: @convention(block) (AnyObject, AnyObject?, AnyObject?) -> Void = { task, message, completion in
            theirCalls += 1
            unsafeBitCast(ours, to: SendIMP.self)(task, selector, message, completion)
        }
        method_setImplementation(method, imp_implementationWithBlock(unsafeBitCast(theirs, to: AnyObject.self)))
        defer { method_setImplementation(method, ours) }

        let task = URLSession.shared.webSocketTask(with: url("/chained"))
        task.resume()
        var completions = 0
        let done = expectation(description: "send")
        task.send(.string("once")) { error in
            XCTAssertNil(error)
            completions += 1
            done.fulfill()
        }
        wait(for: [done], timeout: 5)
        XCTAssertEqual(receivedText(task), "once")
        let id = try XCTUnwrap(requestId(urlContaining: "/chained"))
        XCTAssertEqual(desktop.waitForCount(2, { $0.type == "net.ws" && $0.object["id"] as? String == id }).count, 2)
        settle()
        XCTAssertEqual(theirCalls, 1)
        XCTAssertEqual(completions, 1, "the app's completion runs once")
        XCTAssertEqual(timeline(id).filter { $0 == "net.ws:out:text" }.count, 1, "reported once")
        task.cancel()
    }

    func testEachConnectionIsItsOwnEntryAndTheSDKsOwnLinkIsNeverCaptured() throws {
        startConnected(options(network: true))
        let first = URLSession.shared.webSocketTask(with: url("/again"))
        first.resume()
        send(first, .string("1"))
        first.cancel()
        let second = URLSession.shared.webSocketTask(with: url("/again"))
        second.resume()
        send(second, .string("2"))
        second.cancel()
        XCTAssertEqual(desktop.waitForCount(2, { $0.type == "net.request" && ($0.object["url"] as? String)?.contains("/again") == true }).count, 2)
        let ids = Set(desktop.messages(ofType: "net.request").compactMap { $0["id"] as? String })
        XCTAssertEqual(ids.count, desktop.messages(ofType: "net.request").count, "a reconnect is a new entry")
        XCTAssertFalse(desktop.messages(ofType: "net.request").contains { ($0["url"] as? String)?.contains(":\(desktop.port)") == true })
    }
}

final class EventStreamCaptureTests: StreamTestCase {
    var server: TestEventStreamServer!

    override func setUpWithError() throws {
        try super.setUpWithError()
        server = TestEventStreamServer()
        try server.start()
        setStreams(true)
    }

    override func tearDown() {
        server?.stop()
        server = nil
        super.tearDown()
    }

    /// An app reading the stream through its session delegate, chunk by chunk.
    final class Reader: NSObject, URLSessionDataDelegate {
        private let lock = NSLock()
        private var chunks: [Data] = []
        private(set) var error: Error?
        private(set) var finished = false
        let completed = XCTestExpectation(description: "completed")

        var received: Data {
            lock.lock()
            defer { lock.unlock() }
            return chunks.reduce(Data(), +)
        }

        func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
            lock.lock()
            chunks.append(data)
            lock.unlock()
        }

        func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
            self.error = error
            finished = true
            completed.fulfill()
        }
    }

    private func open(_ reader: Reader) -> (URLSession, URLSessionDataTask) {
        let session = URLSession(configuration: .default, delegate: reader, delegateQueue: nil)
        var request = URLRequest(url: server.url)
        request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        let task = session.dataTask(with: request)
        let count = server.requestCount
        task.resume()
        XCTAssertNotNil(server.waitForRequest(count: count + 1))
        return (session, task)
    }

    private func events(_ id: String) -> [[String: Any]] {
        messages("net.sse", id: id).filter { $0["end"] == nil }
    }

    func testEventsAreReportedAsTheyArriveAndTheBodyIsNeverKept() throws {
        startConnected(options(network: true))
        let reader = Reader()
        let (session, _) = open(reader)
        defer { session.invalidateAndCancel() }
        let id = try XCTUnwrap(requestId(urlContaining: "/events"))
        // URLSession hands the response over with the first body bytes (not at the bare headers).
        server.send("data: one\n\n")
        let response = try XCTUnwrap(desktop.waitForType("net.response", where: { $0["id"] as? String == id }), "sent at the headers")
        XCTAssertEqual(response["status"] as? Int, 200)
        XCTAssertNil(response["body"])
        XCTAssertNotNil(desktop.waitForType("net.sse", where: { $0["id"] as? String == id }))
        XCTAssertTrue(waitUntil { reader.received == Data("data: one\n\n".utf8) }, "the app got the chunk before the stream ended")

        // An event split inside a CRLF and inside "ç", then a comment.
        let tail = Data("event: update\r\nid: 7\r\nretry: 3000\r\ndata: a\r\ndata: ç".utf8)
        server.send(Data(tail.dropLast()))
        server.send(Data(tail.suffix(1)) + Data("ö\r".utf8))
        server.send("\n\r\n: keepalive\n\n")
        XCTAssertEqual(desktop.waitForCount(2, { $0.type == "net.sse" && $0.object["id"] as? String == id }).count, 2)
        server.finish()
        wait(for: [reader.completed], timeout: 5)
        XCTAssertNil(reader.error)
        XCTAssertNotNil(desktop.waitForType("net.sse", where: { $0["id"] as? String == id && $0["end"] as? Bool == true }))
        settle()

        let sse = events(id)
        XCTAssertEqual(sse.count, 2)
        XCTAssertNil(sse[0]["event"])
        XCTAssertEqual((sse[0]["body"] as? [String: Any])?["data"] as? String, "one")
        XCTAssertEqual(sse[0]["size"] as? Int, 3)
        XCTAssertEqual(sse[1]["event"] as? String, "update")
        XCTAssertEqual(sse[1]["eventId"] as? String, "7")
        XCTAssertEqual(sse[1]["retry"] as? Int, 3000)
        XCTAssertEqual((sse[1]["body"] as? [String: Any])?["data"] as? String, "a\nçö")
        XCTAssertEqual(timeline(id), ["net.request", "net.response", "net.sse", "net.sse", "net.sse"])
        XCTAssertTrue(messages("net.error", id: id).isEmpty)
        XCTAssertTrue(reader.received.starts(with: Data("data: one\n\nevent: update".utf8)), "the app saw every byte")
    }

    func testCancellingTheReaderAndACutStream() throws {
        startConnected(options(network: true))
        let reader = Reader()
        let (session, task) = open(reader)
        defer { session.invalidateAndCancel() }
        let id = try XCTUnwrap(requestId(urlContaining: "/events"))
        server.send("data: x\n\n")
        XCTAssertNotNil(desktop.waitForType("net.sse", where: { $0["id"] as? String == id }))
        task.cancel()
        let error = try XCTUnwrap(desktop.waitForType("net.error", where: { $0["id"] as? String == id }))
        XCTAssertEqual(error["cancelled"] as? Bool, true)

        let second = Reader()
        let (session2, _) = open(second)
        defer { session2.invalidateAndCancel() }
        let secondId = try XCTUnwrap(desktop.waitForType("net.request", where: { $0["id"] as? String != id })?["id"] as? String)
        server.send("data: partial")
        XCTAssertNotNil(desktop.waitForType("net.response", where: { $0["id"] as? String == secondId }))
        server.cut()
        wait(for: [second.completed], timeout: 5)
        XCTAssertNotNil(second.error)
        let failure = try XCTUnwrap(desktop.waitForType("net.error", where: { $0["id"] as? String == secondId }))
        XCTAssertNil(failure["cancelled"])
        settle()
        XCTAssertTrue(events(secondId).isEmpty, "an unfinished event is not reported")
        XCTAssertTrue(messages("net.sse", id: secondId).allSatisfy { $0["end"] == nil })
    }

    func testWithoutStreamsTheResponseIsReportedAsBefore() throws {
        setStreams(false)
        desktop.config.removeValue(forKey: "captureStreams")
        startConnected(options(network: true))
        let reader = Reader()
        let (session, _) = open(reader)
        defer { session.invalidateAndCancel() }
        let id = try XCTUnwrap(requestId(urlContaining: "/events"))
        server.send("data: one\n\n")
        XCTAssertTrue(waitUntil { !reader.received.isEmpty })
        settle()
        XCTAssertTrue(messages("net.response", id: id).isEmpty, "the response goes out when it ends, as before")
        server.finish()
        let response = try XCTUnwrap(desktop.waitForType("net.response", where: { $0["id"] as? String == id }))
        XCTAssertEqual((response["body"] as? [String: Any])?["data"] as? String, "data: one\n\n")
        settle()
        XCTAssertTrue(desktop.messages(ofType: "net.sse").isEmpty)
    }

    func testTheDesktopAskingMidStreamStartsAtTheNextEventAndOffStillEnds() throws {
        setStreams(false)
        startConnected(options(network: true))
        let reader = Reader()
        let (session, _) = open(reader)
        defer { session.invalidateAndCancel() }
        let id = try XCTUnwrap(requestId(urlContaining: "/events"))
        server.send("data: first\n\ndata: par")
        XCTAssertTrue(waitUntil { reader.received.count == 22 })

        setStreams(true, live: true)
        server.send("tial\n\ndata: second\n\n")
        XCTAssertNotNil(desktop.waitForType("net.sse", where: { $0["id"] as? String == id }))
        let response = try XCTUnwrap(messages("net.response", id: id).first)
        XCTAssertNil(response["body"], "the part before is not sent as a body either")

        setStreams(false, live: true)
        server.send("data: third\n\n")
        XCTAssertTrue(waitUntil { reader.received.count == 55 })
        server.finish()
        XCTAssertNotNil(desktop.waitForType("net.sse", where: { $0["id"] as? String == id && $0["end"] as? Bool == true }),
                        "a reported stream always ends")
        settle()
        XCTAssertEqual(events(id).compactMap { ($0["body"] as? [String: Any])?["data"] as? String }, ["second"])
        XCTAssertEqual(messages("net.response", id: id).count, 1)
    }

    func testAsyncBytesAreCaptured() throws {
        guard #available(macOS 12.0, iOS 15.0, *) else { throw XCTSkip("URLSession.bytes") }
        startConnected(options(network: true))
        let done = expectation(description: "lines")
        let lines = Box<[String]>([])
        let url = server.url
        let reading = Task {
            let (bytes, _) = try await URLSession.shared.bytes(from: url)
            for try await line in bytes.lines {
                lines.value.append(line)
                if lines.value.count == 2 { break }
            }
            done.fulfill()
        }
        XCTAssertNotNil(server.waitForRequest(count: 1))
        server.send("data: alpha\n\n")
        server.send("data: beta\n\n")
        wait(for: [done], timeout: 5)
        reading.cancel()
        XCTAssertEqual(lines.value, ["data: alpha", "data: beta"])
        let id = try XCTUnwrap(requestId(urlContaining: "/events"))
        let sse = desktop.waitForCount(2, { $0.type == "net.sse" && $0.object["id"] as? String == id })
        XCTAssertEqual(sse.compactMap { ($0.object["body"] as? [String: Any])?["data"] as? String }, ["alpha", "beta"])
        server.finish()
    }

    func testStreamMessagesAreNotKeptForALaterConnection() throws {
        startConnected(options(network: true))
        desktop.autoWelcome = false
        desktop.closeConnections()
        XCTAssertTrue(waitUntil { !Durbun.isConnected })
        XCTAssertNil(DurbunCore.shared.streamMessageCap, "no desktop: nothing asks for streams")
        DurbunCore.shared.sendStream(WireMessage.netSse(id: "x", ts: 1, end: true))
        Durbun.info("kept")
        XCTAssertTrue(waitUntil { DurbunCore.shared.transportSnapshot?.buffered == 1 }, "only the log line waits for the next connection")
    }
}
