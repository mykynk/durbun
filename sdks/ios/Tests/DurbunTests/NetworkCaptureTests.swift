import XCTest
@testable import Durbun

final class NetworkCaptureTests: SDKTestCase {
    var server: TestHTTPServer!

    override func setUpWithError() throws {
        try super.setUpWithError()
        server = TestHTTPServer()
        server.handler = { request in
            switch request.path {
            case "/json":
                return .json(#"{"id":42,"name":"Çağrı"}"#)
            case "/echo":
                var response = TestHTTPServer.Response(status: 201, body: request.body)
                response.headers = [("Content-Type", request.headers["content-type"] ?? "application/octet-stream"),
                                    ("X-Received-Length", "\(request.body.count)")]
                return response
            case "/redirect":
                return TestHTTPServer.Response(status: 302, headers: [("Location", "/json")])
            case "/slow":
                var response = TestHTTPServer.Response.json(#"{"slow":true}"#)
                response.delay = 3
                return response
            case "/large":
                return .json("[" + Array(repeating: #""abcdefghij""#, count: 5000).joined(separator: ",") + "]")
            case "/png":
                return TestHTTPServer.Response(status: 200, headers: [("Content-Type", "image/png")],
                                               body: Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D]))
            case "/missing":
                return .json(#"{"error":"not found"}"#, status: 404)
            default:
                return TestHTTPServer.Response(status: 200)
            }
        }
        try server.start()
    }

    override func tearDown() {
        server?.stop()
        server = nil
        super.tearDown()
    }

    private func url(_ path: String) -> URL { URL(string: server.baseURL + path)! }

    private struct Outcome {
        var data: Data?
        var response: HTTPURLResponse?
        var error: NSError?
        var elapsed: TimeInterval
    }

    private func perform(_ request: URLRequest, session: URLSession = .shared, timeout: TimeInterval = 10) -> Outcome {
        let done = expectation(description: "request")
        var outcome = Outcome(elapsed: 0)
        let start = Date()
        session.dataTask(with: request) { data, response, error in
            outcome = Outcome(data: data, response: response as? HTTPURLResponse, error: error as NSError?, elapsed: Date().timeIntervalSince(start))
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: timeout)
        return outcome
    }

    /// net.request + final message (net.response or net.error) for the request to `path`.
    private func capture(for path: String, final: String = "net.response", file: StaticString = #filePath, line: UInt = #line) -> (request: [String: Any], final: [String: Any])? {
        guard let request = desktop.waitForType("net.request", where: { ($0["url"] as? String)?.hasSuffix(path) == true }) else {
            XCTFail("no net.request for \(path)", file: file, line: line)
            return nil
        }
        let id = request["id"] as? String
        guard let result = desktop.waitForType(final, where: { $0["id"] as? String == id }) else {
            XCTFail("no \(final) for \(path)", file: file, line: line)
            return nil
        }
        return (request, result)
    }

    // MARK: Capture

    func testCapturesSharedSessionRequestAndResponse() throws {
        startConnected(options(network: true))
        var request = URLRequest(url: url("/echo"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("Bearer secret-token", forHTTPHeaderField: "Authorization")
        request.httpBody = Data(#"{"email":"ayse@example.com","remember":true}"#.utf8)
        let outcome = perform(request)
        XCTAssertNil(outcome.error)
        XCTAssertEqual(outcome.response?.statusCode, 201)
        XCTAssertEqual(outcome.data, request.httpBody, "the app gets the real response untouched")
        XCTAssertEqual(server.requests.last?.body, request.httpBody, "the server gets the real body")

        let (captured, response) = try XCTUnwrap(capture(for: "/echo"))
        XCTAssertEqual(captured["method"] as? String, "POST")
        XCTAssertEqual(captured["source"] as? String, "urlsession")
        let headers = try XCTUnwrap(captured["headers"] as? [[String]])
        XCTAssertTrue(headers.contains(["Authorization", "Bearer secret-token"]))
        XCTAssertEqual(headers.map { $0[0].lowercased() }, headers.map { $0[0].lowercased() }.sorted(), "headers are sorted")
        let body = try XCTUnwrap(captured["body"] as? [String: Any])
        XCTAssertEqual(body["encoding"] as? String, "utf8")
        XCTAssertEqual(body["data"] as? String, #"{"email":"ayse@example.com","remember":true}"#)
        XCTAssertEqual(body["size"] as? Int, request.httpBody?.count)

        XCTAssertEqual(response["status"] as? Int, 201)
        XCTAssertEqual(response["statusText"] as? String, "Created")
        XCTAssertNil(response["mocked"])
        let responseBody = try XCTUnwrap(response["body"] as? [String: Any])
        XCTAssertEqual(responseBody["data"] as? String, #"{"email":"ayse@example.com","remember":true}"#)
        XCTAssertTrue((response["headers"] as? [[String]] ?? []).contains(["X-Received-Length", "44"]))
        XCTAssertNotNil(response["timings"] as? [String: Any], "URLSessionTaskMetrics → timings")
        XCTAssertEqual(response["protocol"] as? String, "http/1.1")
        XCTAssertNotNil(response["remoteAddress"] as? String)
        XCTAssertGreaterThanOrEqual(response["ts"] as? Double ?? 0, captured["ts"] as? Double ?? .infinity)
    }

    func testCustomSessionsAreCapturedThroughSwizzledConfigurations() throws {
        startConnected(options(network: true))
        let configuration = URLSessionConfiguration.default
        XCTAssertTrue(configuration.protocolClasses?.first == DurbunURLProtocol.self, "default configuration is injected")
        XCTAssertTrue(URLSessionConfiguration.ephemeral.protocolClasses?.first == DurbunURLProtocol.self, "ephemeral too")
        configuration.httpAdditionalHeaders = ["X-App-Version": "2.4.0"]
        let session = URLSession(configuration: configuration)
        defer { session.invalidateAndCancel() }
        let outcome = perform(URLRequest(url: url("/json")), session: session)
        XCTAssertEqual(outcome.response?.statusCode, 200)
        XCTAssertEqual(String(decoding: outcome.data ?? Data(), as: UTF8.self), #"{"id":42,"name":"Çağrı"}"#)
        let (request, response) = try XCTUnwrap(capture(for: "/json"))
        XCTAssertTrue((request["headers"] as? [[String]] ?? []).contains(["X-App-Version", "2.4.0"]), "session headers are visible")
        XCTAssertEqual(server.requests.last?.headers["x-app-version"], "2.4.0", "and still sent")
        XCTAssertEqual((response["body"] as? [String: Any])?["data"] as? String, #"{"id":42,"name":"Çağrı"}"#)
    }

    func testStreamedAndUploadBodiesAreForwardedAndCaptured() throws {
        startConnected(options(network: true))
        let payload = Data((0..<70_000).map { UInt8($0 % 251) })
        var streamed = URLRequest(url: url("/echo"))
        streamed.httpMethod = "PUT"
        streamed.httpBodyStream = InputStream(data: payload)
        let first = perform(streamed)
        XCTAssertEqual(first.data, payload)
        XCTAssertEqual(server.requests.last?.body, payload)

        var upload = URLRequest(url: url("/echo"))
        upload.httpMethod = "POST"
        upload.setValue("text/plain", forHTTPHeaderField: "Content-Type")
        let text = Data("upload task body ✓".utf8)
        let done = expectation(description: "upload")
        var uploadData: Data?
        URLSession.shared.uploadTask(with: upload, from: text) { data, _, _ in
            uploadData = data
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        XCTAssertEqual(uploadData, text)

        let requests = desktop.waitForCount(2) { $0.type == "net.request" }.map(\.object)
        let streamedBody = try XCTUnwrap(requests.first { $0["method"] as? String == "PUT" }?["body"] as? [String: Any])
        XCTAssertEqual(streamedBody["encoding"] as? String, "base64", "no content type + binary bytes")
        XCTAssertEqual(streamedBody["size"] as? Int, payload.count)
        let uploadBody = try XCTUnwrap(requests.first { $0["method"] as? String == "POST" }?["body"] as? [String: Any])
        XCTAssertEqual(uploadBody["data"] as? String, "upload task body ✓")
    }

    func testLargeBodiesAreTruncatedButSizeIsKept() throws {
        desktop.config["maxBodyBytes"] = 1000
        startConnected(options(network: true))
        let outcome = perform(URLRequest(url: url("/large")))
        let fullSize = try XCTUnwrap(outcome.data?.count)
        XCTAssertGreaterThan(fullSize, 50_000, "the app still gets everything")
        let (_, response) = try XCTUnwrap(capture(for: "/large"))
        let body = try XCTUnwrap(response["body"] as? [String: Any])
        XCTAssertEqual(body["size"] as? Int, fullSize)
        XCTAssertEqual(body["truncated"] as? Bool, true)
        XCTAssertEqual((body["data"] as? String)?.utf8.count, 1000)
    }

    func testCaptureBodiesFalseSendsSizesOnly() throws {
        desktop.config["captureBodies"] = false
        startConnected(options(network: true))
        _ = perform(URLRequest(url: url("/json")))
        let (_, response) = try XCTUnwrap(capture(for: "/json"))
        let body = try XCTUnwrap(response["body"] as? [String: Any])
        XCTAssertEqual(body["data"] as? String, "")
        XCTAssertEqual(body["size"] as? Int, #"{"id":42,"name":"Çağrı"}"#.utf8.count)
    }

    func testBinaryResponsesAreBase64() throws {
        startConnected(options(network: true))
        _ = perform(URLRequest(url: url("/png")))
        let (_, response) = try XCTUnwrap(capture(for: "/png"))
        let body = try XCTUnwrap(response["body"] as? [String: Any])
        XCTAssertEqual(body["encoding"] as? String, "base64")
        XCTAssertEqual(Data(base64Encoded: body["data"] as? String ?? "")?.prefix(4), Data([0x89, 0x50, 0x4E, 0x47]))
    }

    func testRedirectHopsAreReportedSeparately() throws {
        startConnected(options(network: true))
        let outcome = perform(URLRequest(url: url("/redirect")))
        XCTAssertNil(outcome.error)
        XCTAssertEqual(outcome.response?.statusCode, 200)
        XCTAssertEqual(outcome.response?.url?.path, "/json")
        XCTAssertEqual(String(decoding: outcome.data ?? Data(), as: UTF8.self), #"{"id":42,"name":"Çağrı"}"#)
        let (_, hop) = try XCTUnwrap(capture(for: "/redirect"))
        XCTAssertEqual(hop["status"] as? Int, 302)
        XCTAssertTrue((hop["headers"] as? [[String]] ?? []).contains(["Location", "/json"]))
        let (_, final) = try XCTUnwrap(capture(for: "/json"))
        XCTAssertEqual(final["status"] as? Int, 200)
        XCTAssertTrue(desktop.messages(ofType: "net.error").isEmpty, "the redirect hand-off is not an error")
    }

    func testHTTPErrorsAndConnectionFailures() throws {
        startConnected(options(network: true))
        let notFound = perform(URLRequest(url: url("/missing")))
        XCTAssertEqual(notFound.response?.statusCode, 404)
        let (_, response) = try XCTUnwrap(capture(for: "/missing"))
        XCTAssertEqual(response["statusText"] as? String, "Not Found")

        let closedPort = freeLocalPort()
        let refused = perform(URLRequest(url: URL(string: "http://127.0.0.1:\(closedPort)/nothing")!))
        XCTAssertEqual(refused.error?.code, NSURLErrorCannotConnectToHost, "the app sees the natural error")
        let (_, failure) = try XCTUnwrap(capture(for: "/nothing", final: "net.error"))
        XCTAssertTrue((failure["error"] as? String ?? "").contains("URLError.cannotConnectToHost -1004"), "\(failure)")
        XCTAssertNil(failure["cancelled"])
    }

    func testCancellationIsReported() throws {
        startConnected(options(network: true))
        let done = expectation(description: "cancelled")
        var error: NSError?
        let task = URLSession.shared.dataTask(with: url("/slow")) { _, _, e in
            error = e as NSError?
            done.fulfill()
        }
        task.resume()
        XCTAssertNotNil(desktop.waitForType("net.request") { ($0["url"] as? String)?.hasSuffix("/slow") == true })
        task.cancel()
        wait(for: [done], timeout: 5)
        XCTAssertEqual(error?.code, NSURLErrorCancelled)
        let (_, failure) = try XCTUnwrap(capture(for: "/slow", final: "net.error"))
        XCTAssertEqual(failure["cancelled"] as? Bool, true)
    }

    func testCancelDuringASlowBodyStillReportsRequestBeforeError() throws {
        startConnected(options(network: true))
        var input: InputStream?
        var output: OutputStream?
        Stream.getBoundStreams(withBufferSize: 1024, inputStream: &input, outputStream: &output)
        let writer = try XCTUnwrap(output)
        writer.open()
        var request = URLRequest(url: url("/echo"))
        request.httpMethod = "POST"
        request.httpBodyStream = input
        let done = expectation(description: "cancelled")
        let task = URLSession.shared.dataTask(with: request) { _, _, _ in done.fulfill() }
        task.resume()
        _ = writer.write("partial body", maxLength: 12)
        _ = waitUntil(timeout: 0.3) { false } // the SDK is now blocked reading the unfinished body
        task.cancel()
        wait(for: [done], timeout: 5)
        writer.close() // body complete: the request is reported, then the deferred cancellation
        let (captured, failure) = try XCTUnwrap(capture(for: "/echo", final: "net.error"))
        XCTAssertEqual(failure["cancelled"] as? Bool, true)
        XCTAssertEqual((captured["body"] as? [String: Any])?["data"] as? String, "partial body")
        let order = desktop.all.filter { $0.object["id"] as? String == captured["id"] as? String }.compactMap(\.type)
        XCTAssertEqual(order, ["net.request", "net.error"])
        XCTAssertTrue(server.requests.isEmpty, "a cancelled request is never forwarded")
    }

    func testTimeoutIsReportedAsErrorNotCancellation() throws {
        startConnected(options(network: true))
        var request = URLRequest(url: url("/slow"))
        request.timeoutInterval = 0.5
        let outcome = perform(request)
        XCTAssertEqual(outcome.error?.code, NSURLErrorTimedOut, "the app's own timeout still fires")
        XCTAssertLessThan(outcome.elapsed, 2.5)
        let (_, failure) = try XCTUnwrap(capture(for: "/slow", final: "net.error"))
        XCTAssertNil(failure["cancelled"], "\(failure)")
        XCTAssertTrue((failure["error"] as? String ?? "").contains("timedOut"), "\(failure)")
    }

    func testIgnoredHostsAndStoppedSDKAreNotCaptured() throws {
        startConnected(options(network: true, ignoredHosts: ["127.0.0.1"]))
        XCTAssertEqual(perform(URLRequest(url: url("/json"))).response?.statusCode, 200)
        Thread.sleep(forTimeInterval: 0.2)
        XCTAssertTrue(desktop.messages(ofType: "net.request").isEmpty)
        Durbun.stop()
        XCTAssertFalse(DurbunURLProtocol.canInit(with: URLRequest(url: url("/json"))))
        XCTAssertEqual(perform(URLRequest(url: url("/json"))).response?.statusCode, 200, "requests keep working after stop")
    }

    // MARK: Mocks

    private func rule(_ id: String, url: String, match: String = "contains", method: String = "*", action: [String: Any]) -> [String: Any] {
        ["id": id, "enabled": true, "method": method, "url": url, "match": match, "action": action, "createdAt": 1_730_540_000_000]
    }

    func testMockRespondSynthesizesResponseWithoutNetwork() throws {
        desktop.mocks = [rule("m-respond", url: "*/api/profile", match: "glob", method: "GET", action: [
            "type": "respond", "status": 418,
            "headers": [["X-Mock", "1"], ["Set-Cookie", "a=1"], ["Set-Cookie", "b=2"]],
            "body": #"{"name":"Mock Kedi"}"#,
        ])]
        startConnected(options(network: true))
        let before = server.requests.count
        let outcome = perform(URLRequest(url: url("/api/profile")))
        XCTAssertEqual(outcome.response?.statusCode, 418)
        XCTAssertEqual(outcome.response?.value(forHTTPHeaderField: "X-Mock"), "1")
        XCTAssertEqual(outcome.response?.value(forHTTPHeaderField: "Content-Type"), "application/json; charset=utf-8", "JSON bodies get a content type")
        XCTAssertEqual(String(decoding: outcome.data ?? Data(), as: UTF8.self), #"{"name":"Mock Kedi"}"#)
        XCTAssertEqual(server.requests.count, before, "the network was not touched")
        let (_, response) = try XCTUnwrap(capture(for: "/api/profile"))
        XCTAssertEqual(response["mocked"] as? Bool, true)
        XCTAssertEqual(response["mockRuleId"] as? String, "m-respond")
        XCTAssertEqual(response["status"] as? Int, 418)
        XCTAssertEqual((response["body"] as? [String: Any])?["data"] as? String, #"{"name":"Mock Kedi"}"#)
    }

    func testMockRespondHonorsDelayAndBase64() throws {
        desktop.mocks = [rule("m-img", url: "/avatar.png", action: [
            "type": "respond", "status": 200, "headers": [["Content-Type", "image/png"]],
            "body": "iVBORw0KGgo=", "bodyEncoding": "base64", "delayMs": 400,
        ])]
        startConnected(options(network: true))
        let outcome = perform(URLRequest(url: url("/avatar.png")))
        XCTAssertGreaterThanOrEqual(outcome.elapsed, 0.38)
        XCTAssertEqual(outcome.data, Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))
    }

    func testMockDelayPerformsTheRealRequestLater() throws {
        desktop.mocks = [rule("m-delay", url: "/json", action: ["type": "delay", "delayMs": 500])]
        startConnected(options(network: true))
        let outcome = perform(URLRequest(url: url("/json")))
        XCTAssertGreaterThanOrEqual(outcome.elapsed, 0.48)
        XCTAssertEqual(outcome.response?.statusCode, 200)
        XCTAssertEqual(server.requests.last?.path, "/json", "the real server answered")
        let (_, response) = try XCTUnwrap(capture(for: "/json"))
        XCTAssertEqual(response["mocked"] as? Bool, true)
        XCTAssertEqual(response["mockRuleId"] as? String, "m-delay")
    }

    func testMockFailRaisesNaturalURLErrors() throws {
        let kinds: [(String, Int)] = [
            ("timeout", NSURLErrorTimedOut),
            ("connection", NSURLErrorCannotConnectToHost),
            ("dns", NSURLErrorCannotFindHost),
            ("tls", NSURLErrorSecureConnectionFailed),
            ("custom", NSURLErrorUnknown),
        ]
        desktop.mocks = kinds.map { kind, _ in
            var action: [String: Any] = ["type": "fail", "error": kind, "delayMs": 50]
            if kind == "custom" { action["message"] = "Sunucu bakımda" }
            return rule("m-\(kind)", url: "/fail/\(kind)", action: action)
        }
        startConnected(options(network: true))
        for (kind, code) in kinds {
            let outcome = perform(URLRequest(url: url("/fail/\(kind)")))
            XCTAssertEqual(outcome.error?.domain, NSURLErrorDomain, kind)
            XCTAssertEqual(outcome.error?.code, code, kind)
            XCTAssertEqual((outcome.error?.userInfo[NSURLErrorFailingURLErrorKey] as? URL)?.path, "/fail/\(kind)")
            let (_, failure) = try XCTUnwrap(capture(for: "/fail/\(kind)", final: "net.error"))
            XCTAssertEqual(failure["mocked"] as? Bool, true, kind)
            XCTAssertEqual(failure["mockRuleId"] as? String, "m-\(kind)")
        }
        let custom = try XCTUnwrap(capture(for: "/fail/custom", final: "net.error"))
        XCTAssertTrue((custom.final["error"] as? String ?? "").hasPrefix("Sunucu bakımda"))
        XCTAssertTrue(server.requests.isEmpty, "failed mocks never reach the network")
    }

    func testMocksMessageReplacesRulesLive() throws {
        startConnected(options(network: true))
        XCTAssertEqual(perform(URLRequest(url: url("/json"))).response?.statusCode, 200)
        desktop.send(["type": "mocks", "rules": [rule("live", url: "/json", action: ["type": "respond", "status": 503, "body": "down"])]])
        XCTAssertTrue(waitUntil { DurbunCore.shared.mockRules.count == 1 })
        XCTAssertEqual(perform(URLRequest(url: url("/json"))).response?.statusCode, 503)
        desktop.send(["type": "mocks", "rules": []])
        XCTAssertTrue(waitUntil { DurbunCore.shared.mockRules.isEmpty })
        XCTAssertEqual(perform(URLRequest(url: url("/json"))).response?.statusCode, 200)
    }

    func testRulesForOtherAppsAreIgnored() throws {
        desktop.mocks = [
            rule("other", url: "/json", action: ["type": "respond", "status": 500]).merging(["apps": ["com.someone.else"]]) { $1 },
        ]
        startConnected(options(network: true))
        XCTAssertEqual(perform(URLRequest(url: url("/json"))).response?.statusCode, 200)
    }
}
