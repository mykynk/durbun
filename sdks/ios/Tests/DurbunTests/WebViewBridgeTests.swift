import XCTest
@testable import Durbun
#if canImport(WebKit)
import WebKit
#endif

/// The native half of the web view bridge: messages as the injected script sends them (sdks/js/webview/bridge.ts)
/// become the SDK's own `net.*` and `log` messages, within its capture settings and limits.
final class WebViewReceiverTests: SDKTestCase {
    private var clock: TimeInterval = 1_000

    private func start(
        network: Bool = true,
        redact: [String] = [],
        ignoredHosts: [String] = [],
        captureBodies: Bool? = nil,
        maxBodyBytes: Int? = nil
    ) -> WebViewReceiver {
        startConnected(DurbunOptions(
            port: desktop.port,
            captureStdout: false,
            captureNetwork: network,
            captureCrashes: false,
            collectMetrics: false,
            ignoredHosts: ignoredHosts,
            redactHeaders: redact,
            captureBodies: captureBodies,
            maxBodyBytes: maxBodyBytes
        ))
        return WebViewReceiver(nowMs: { 1_700_000_000_000 }, monotonic: { [unowned self] in clock })
    }

    private func json(_ fields: [String: Any]) -> String {
        var object = fields
        object["v"] = 1
        let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    private func request(id: String = "w1-1", url: String = "https://shop.example.com/api/cart", _ extra: [String: Any] = [:]) -> String {
        var fields: [String: Any] = [
            "t": "req", "id": id, "api": "fetch", "ts": 1_700_000_000_123, "method": "post", "url": url,
            "headers": [["Content-Type", "application/json"], ["Authorization", "Bearer secret"]],
            "body": ["encoding": "utf8", "data": #"{"qty":2}"#, "size": 9],
        ]
        fields.merge(extra) { _, new in new }
        return json(fields)
    }

    private func waitFor(_ type: String, where predicate: (([String: Any]) -> Bool)? = nil) -> [String: Any]? {
        desktop.waitForType(type, where: predicate)
    }

    func testARequestAndItsResponseBecomeOneNetworkEntry() throws {
        let receiver = start(redact: ["authorization"])
        receiver.handle(request())
        receiver.handle(json([
            "t": "res", "id": "w1-1", "ts": 1_700_000_000_400, "status": 201, "statusText": "Created",
            "headers": [["content-type", "application/json"]],
            "body": ["encoding": "utf8", "data": #"{"ok":true}"#, "size": 11],
            "wait": 120.25, "receive": 3,
        ]))
        let req = try XCTUnwrap(waitFor("net.request"))
        XCTAssertEqual(req["method"] as? String, "POST")
        XCTAssertEqual(req["url"] as? String, "https://shop.example.com/api/cart")
        XCTAssertEqual(req["source"] as? String, "webview:fetch")
        XCTAssertEqual(req["ts"] as? Double, 1_700_000_000_123)
        XCTAssertEqual(req["headers"] as? [[String]], [["Content-Type", "application/json"], ["Authorization", "••••"]])
        let body = try XCTUnwrap(req["body"] as? [String: Any])
        XCTAssertEqual(body["data"] as? String, #"{"qty":2}"#)
        XCTAssertEqual(body["size"] as? Int, 9)
        let id = try XCTUnwrap(req["id"] as? String)
        XCTAssertTrue(id.hasPrefix("webview-"))
        let res = try XCTUnwrap(waitFor("net.response") { $0["id"] as? String == id })
        XCTAssertEqual(res["status"] as? Int, 201)
        XCTAssertEqual(res["statusText"] as? String, "Created")
        let timings = try XCTUnwrap(res["timings"] as? [String: Any])
        XCTAssertEqual(timings["wait"] as? Double, 120.3)
        XCTAssertEqual(timings["receive"] as? Double, 3)
        XCTAssertEqual((res["body"] as? [String: Any])?["data"] as? String, #"{"ok":true}"#)
    }

    func testARequestObjectBodyIsReportedAgainUnderTheSameId() {
        let receiver = start()
        receiver.handle(request(["body": NSNull()]))
        receiver.handle(json(["t": "reqbody", "id": "w1-1", "body": ["encoding": "utf8", "data": "name=Ada", "size": 8]]))
        let both = desktop.waitForCount(2) { $0.type == "net.request" }.map(\.object)
        XCTAssertEqual(both.count, 2)
        XCTAssertEqual(both.first?["id"] as? String, both.last?["id"] as? String)
        XCTAssertNil(both.first?["body"])
        XCTAssertEqual((both.last?["body"] as? [String: Any])?["data"] as? String, "name=Ada")
    }

    func testFailuresAndCancellationsBecomeNetErrors() {
        let receiver = start()
        receiver.handle(request(id: "a"))
        receiver.handle(request(id: "b"))
        receiver.handle(json(["t": "err", "id": "a", "error": "TypeError: Failed to fetch"]))
        receiver.handle(json(["t": "err", "id": "b", "error": "AbortError", "cancelled": true]))
        let errors = desktop.waitForCount(2) { $0.type == "net.error" }.map(\.object)
        XCTAssertEqual(errors.first?["error"] as? String, "TypeError: Failed to fetch")
        XCTAssertNil(errors.first?["cancelled"])
        XCTAssertEqual(errors.last?["cancelled"] as? Bool, true)
    }

    func testConsoleLinesBecomeLogsTaggedWebview() {
        let receiver = start()
        receiver.handle(json(["t": "log", "level": "warn", "message": "Slow image", "page": "https://shop.example.com/"]))
        receiver.handle(json([
            "t": "log", "level": "error", "message": "Uncaught TypeError: x is undefined",
            "error": ["type": "TypeError", "message": "x is undefined", "stack": "at app.js:1:2"],
        ]))
        receiver.handle(json(["t": "log", "level": "bogus", "message": "Plain"]))
        let logs = desktop.waitForCount(3) { $0.type == "log" && $0.object["tag"] as? String == "webview" }.map(\.object)
        XCTAssertEqual(logs.map { $0["level"] as? String }, ["warn", "error", "info"])
        XCTAssertEqual((logs.first?["data"] as? [String: Any])?["page"] as? String, "https://shop.example.com/")
        let error = logs[1]["error"] as? [String: Any]
        XCTAssertEqual(error?["type"] as? String, "TypeError")
        XCTAssertEqual(error?["stack"] as? String, "at app.js:1:2")
    }

    func testFollowsTheCaptureSettings() throws {
        let receiver = start(ignoredHosts: ["analytics.example.com"], maxBodyBytes: 4)
        receiver.handle(request(id: "skipped", url: "https://eu.analytics.example.com/collect"))
        receiver.handle(json(["t": "res", "id": "skipped", "status": 204]))
        receiver.handle(request(id: "kept"))
        let req = try XCTUnwrap(waitFor("net.request"))
        XCTAssertEqual(req["url"] as? String, "https://shop.example.com/api/cart")
        let body = try XCTUnwrap(req["body"] as? [String: Any])
        XCTAssertEqual(body["data"] as? String, #"{"qt"#)
        XCTAssertEqual(body["size"] as? Int, 9)
        XCTAssertEqual(body["truncated"] as? Bool, true)
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(desktop.messages(ofType: "net.request").count, 1)
        XCTAssertTrue(desktop.messages(ofType: "net.response").isEmpty)
    }

    func testBodiesShrinkToSizesWhenBodyCaptureIsOff() throws {
        let receiver = start(captureBodies: false)
        receiver.handle(request())
        let body = try XCTUnwrap(waitFor("net.request")?["body"] as? [String: Any])
        XCTAssertEqual(body["data"] as? String, "")
        XCTAssertEqual(body["size"] as? Int, 9)
    }

    func testNetworkCaptureOffKeepsTheConsole() {
        let receiver = start(network: false)
        receiver.handle(request())
        receiver.handle(json(["t": "log", "level": "info", "message": "still here"]))
        XCTAssertNotNil(waitFor("log") { $0["message"] as? String == "still here" })
        XCTAssertTrue(desktop.messages(ofType: "net.request").isEmpty)
    }

    func testIgnoresWhatIsNotABridgeMessage() {
        let receiver = start()
        receiver.receive(42)
        receiver.handle("not json")
        receiver.handle("[1,2]")
        receiver.handle(#"{"v":2,"t":"log","message":"future version"}"#)
        receiver.handle(json(["t": "log", "message": 42]))
        receiver.handle(request(url: "javascript:alert(1)"))
        receiver.handle(request(url: "file:///var/mobile/secret"))
        receiver.handle(json(["t": "req", "id": ["x"], "url": "https://a.example.com/"]))
        receiver.handle(json(["t": "res", "id": "never-requested", "status": 200]))
        receiver.handle(json(["t": "log", "message": String(repeating: "x", count: WebViewReceiver.maxMessageChars)]))
        receiver.handle(json(["t": "log", "level": "info", "message": "the last one"]))
        XCTAssertNotNil(waitFor("log") { $0["message"] as? String == "the last one" })
        XCTAssertTrue(desktop.messages(ofType: "net.request").isEmpty)
        XCTAssertTrue(desktop.messages(ofType: "net.response").isEmpty)
        let drops = desktop.messages(ofType: "log").filter { ($0["message"] as? String)?.hasPrefix("Dürbün dropped") == true }
        XCTAssertEqual(drops.count, 1, "the oversized message counts as dropped, reported once")
    }

    func testCapsForgedValues() throws {
        let receiver = start()
        receiver.handle(request([
            "method": "DROP TABLE",
            "ts": 1,
            "headers": (0..<500).map { ["X-\($0)", "v"] },
        ]))
        let req = try XCTUnwrap(waitFor("net.request"))
        XCTAssertEqual(req["method"] as? String, "GET")
        XCTAssertEqual(req["ts"] as? Double, 1_700_000_000_000, "a clock far off is replaced by now")
        XCTAssertEqual((req["headers"] as? [Any])?.count, WebViewReceiver.maxHeaders)
        receiver.handle(json(["t": "res", "id": "w1-1", "status": 99_999, "wait": -5, "receive": "slow"]))
        let res = try XCTUnwrap(waitFor("net.response"))
        XCTAssertEqual(res["status"] as? Int, 0)
        XCTAssertNil(res["timings"])
    }

    func testLimitsTheMessageRateAndSaysHowManyItDropped() {
        let receiver = start()
        let burst = Int(WebViewReceiver.burst)
        for i in 0..<(burst + 100) { receiver.handle(json(["t": "log", "level": "info", "message": "line \(i)"])) }
        let isLine: (FakeDesktop.Received) -> Bool = { $0.type == "log" && ($0.object["message"] as? String)?.hasPrefix("line ") == true }
        XCTAssertEqual(desktop.waitForCount(burst, isLine).count, burst)
        let warning = waitFor("log") { ($0["message"] as? String)?.hasPrefix("Dürbün dropped") == true }
        XCTAssertEqual(warning?["level"] as? String, "warn")
        XCTAssertEqual(warning?["message"] as? String, "Dürbün dropped 1 message(s) from a web view: the page sent too many, or too large ones.")
        Thread.sleep(forTimeInterval: 0.15)
        XCTAssertEqual(desktop.all.filter(isLine).count, burst)
        clock += WebViewReceiver.dropReportInterval
        receiver.handle(json(["t": "dropped", "count": 7]))
        XCTAssertNotNil(waitFor("log") {
            $0["message"] as? String == "Dürbün dropped 106 message(s) from a web view: the page sent too many, or too large ones."
        })
    }

    func testBoundsRequestsInFlight() throws {
        let receiver = start()
        for i in 0...WebViewReceiver.maxPending { receiver.handle(request(id: "id-\(i)")) }
        let requests = desktop.waitForCount(WebViewReceiver.maxPending + 1) { $0.type == "net.request" }
        XCTAssertEqual(requests.count, WebViewReceiver.maxPending + 1)
        receiver.handle(json(["t": "res", "id": "id-0", "status": 200])) // evicted: the oldest
        receiver.handle(json(["t": "res", "id": "id-\(WebViewReceiver.maxPending)", "status": 200]))
        let res = try XCTUnwrap(waitFor("net.response"))
        Thread.sleep(forTimeInterval: 0.1)
        XCTAssertEqual(desktop.messages(ofType: "net.response").count, 1)
        XCTAssertEqual(res["id"] as? String, requests.last?.object["id"] as? String)
    }

    func testReceiveRunsOffTheCallingThread() {
        let receiver = start()
        receiver.receive(json(["t": "log", "level": "info", "message": "from the main thread"]))
        XCTAssertNotNil(waitFor("log") { $0["message"] as? String == "from the main thread" })
    }

    func testNothingHappensWhileTheSDKIsOff() {
        let receiver = WebViewReceiver()
        receiver.handle(request())
        XCTAssertTrue(desktop.all.isEmpty)
    }
}

#if canImport(WebKit)
/// The bridge in a real `WKWebView` (macOS): the script is injected at document start and reports through the
/// message handler.
final class DurbunWebViewTests: SDKTestCase {
    private var server: TestHTTPServer!

    override func setUpWithError() throws {
        try super.setUpWithError()
        server = TestHTTPServer()
        server.handler = { request in
            switch request.path {
            case "/page":
                let html = """
                <!doctype html><html><body><script>
                console.log('page script', { items: 3 });
                var seen = [];
                function note(part) { seen.push(part); seen.sort(); document.title = seen.join(' '); }
                fetch('/json?from=fetch').then(function (r) { return r.json(); })
                  .then(function (d) { note('fetch:' + d.items.length); });
                var xhr = new XMLHttpRequest();
                xhr.open('POST', '/echo');
                xhr.setRequestHeader('Content-Type', 'application/json');
                xhr.onload = function () { note('xhr:' + xhr.status + ':' + xhr.responseText); };
                xhr.send('{"from":"xhr"}');
                </script></body></html>
                """
                return TestHTTPServer.Response(status: 200, headers: [("Content-Type", "text/html; charset=utf-8")], body: Data(html.utf8))
            case let path where path.hasPrefix("/json"):
                return .json(#"{"items":[1,2,3]}"#)
            case "/echo":
                return TestHTTPServer.Response(status: 200, headers: [("Content-Type", "application/json")], body: request.body)
            default:
                return TestHTTPServer.Response(status: 404)
            }
        }
        try server.start()
    }

    override func tearDown() {
        server?.stop()
        server = nil
        super.tearDown()
    }

    @MainActor
    func testDoesNothingWhileTheSDKIsOff() {
        let configuration = WKWebViewConfiguration()
        XCTAssertFalse(DurbunWebView.attach(to: configuration))
        XCTAssertTrue(configuration.userContentController.userScripts.isEmpty)
    }

    @MainActor
    func testAttachesOncePerConfiguration() {
        startConnected(options(network: true))
        let configuration = WKWebViewConfiguration()
        XCTAssertTrue(DurbunWebView.attach(to: configuration))
        XCTAssertTrue(DurbunWebView.attach(to: configuration))
        let webView = WKWebView(frame: .zero, configuration: configuration)
        XCTAssertTrue(DurbunWebView.attach(webView), "the web view shares the configuration's controller")
        let scripts = webView.configuration.userContentController.userScripts
        XCTAssertEqual(scripts.count, 1)
        XCTAssertEqual(scripts.first?.injectionTime, .atDocumentStart)
        XCTAssertEqual(scripts.first?.isForMainFrameOnly, false)
        XCTAssertEqual(scripts.first?.source, WebViewBridgeScript.source)
    }

    @MainActor
    func testReportsThePagesRequestsAndConsoleFromDocumentStart() throws {
        startConnected(options(network: true))
        let configuration = WKWebViewConfiguration()
        XCTAssertTrue(DurbunWebView.attach(to: configuration))
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 300), configuration: configuration)
        webView.load(URLRequest(url: URL(string: server.baseURL + "/page")!))

        let base = server.baseURL
        let fetchRequest = desktop.waitForType("net.request", timeout: 20) { $0["url"] as? String == base + "/json?from=fetch" }
        let request = try XCTUnwrap(fetchRequest, "the page's fetch was reported")
        XCTAssertEqual(request["source"] as? String, "webview:fetch")
        let id = try XCTUnwrap(request["id"] as? String)
        let response = try XCTUnwrap(desktop.waitForType("net.response", timeout: 10) { $0["id"] as? String == id })
        XCTAssertEqual(response["status"] as? Int, 200)
        XCTAssertEqual((response["body"] as? [String: Any])?["data"] as? String, #"{"items":[1,2,3]}"#)

        let xhr = try XCTUnwrap(desktop.waitForType("net.request", timeout: 10) { $0["source"] as? String == "webview:xhr" })
        XCTAssertEqual(xhr["method"] as? String, "POST")
        XCTAssertEqual((xhr["body"] as? [String: Any])?["data"] as? String, #"{"from":"xhr"}"#)

        let log = try XCTUnwrap(desktop.waitForType("log", timeout: 10) { $0["tag"] as? String == "webview" })
        XCTAssertEqual(log["message"] as? String, #"page script {"items":3}"#)
        XCTAssertEqual(server.requests.filter { $0.path.hasPrefix("/json") }.count, 1, "the page's request went out once")
        // The page itself got both answers, unchanged.
        let expected = #"fetch:3 xhr:200:{"from":"xhr"}"#
        XCTAssertTrue(waitUntil(timeout: 10) { webView.title == expected }, "page saw: \(webView.title ?? "nil")")
    }
}
#endif
