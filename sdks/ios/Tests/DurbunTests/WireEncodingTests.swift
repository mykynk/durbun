import XCTest
@testable import Durbun

final class WireEncodingTests: XCTestCase {
    // MARK: Fixtures

    private let app = WireAppInfo(
        name: "Pati",
        id: "com.mykynk.pati",
        version: "2.4.0",
        build: "118",
        pid: 4242,
        processName: "Pati",
        debug: true
    )

    private let device = WireDeviceHints(
        platform: "ios",
        model: "iPhone17,1",
        manufacturer: "Apple",
        name: "iPhone 16 Pro",
        osVersion: "18.2",
        isPhysical: false,
        simulatorUdid: "6A1F9C2E-3B44-4F0B-9D8E-1C2B3A4D5E6F"
    )

    private func parse(_ value: JSONValue, file: StaticString = #filePath, line: UInt = #line) -> [String: Any] {
        let data = JSONWriter.line(value)
        XCTAssertEqual(data.last, 0x0A, "NDJSON line must end with \\n", file: file, line: line)
        XCTAssertEqual(data.filter { $0 == 0x0A }.count, 1, "exactly one newline per message", file: file, line: line)
        guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            XCTFail("invalid JSON: \(String(decoding: data, as: UTF8.self))", file: file, line: line)
            return [:]
        }
        return object
    }

    // MARK: Exact encodings

    func testLogLineIsEncodedExactly() {
        let message = WireMessage.log(
            ts: 1_730_540_000_123.456,
            level: .warning,
            tag: "auth",
            message: "Giriş başarısız: \"token\" süresi doldu\nikinci satır",
            data: .object([("userId", 42), ("roles", ["admin", .null]), ("ok", false)]),
            error: WireErrorInfo(type: "AuthError", message: "expired", stack: nil),
            kind: "crash",
            tid: 7
        )
        let expected = #"{"type":"log","ts":1730540000123.456,"level":"warn","tag":"auth","message":"Giriş başarısız: \"token\" süresi doldu\nikinci satır","data":{"userId":42,"roles":["admin",null],"ok":false},"error":{"type":"AuthError","message":"expired"},"kind":"crash","tid":7}"#
        XCTAssertEqual(String(decoding: JSONWriter.line(message), as: UTF8.self), expected + "\n")
    }

    func testOptionalFieldsAreOmitted() {
        let message = WireMessage.log(ts: 1_730_540_000_000, level: .info, tag: nil, message: "hi")
        XCTAssertEqual(JSONWriter.string(message), #"{"type":"log","ts":1730540000000,"level":"info","message":"hi"}"#)
        let error = WireMessage.netError(id: "3", ts: 5, error: "boom")
        XCTAssertEqual(JSONWriter.string(error), #"{"type":"net.error","id":"3","ts":5,"error":"boom"}"#)
    }

    func testStringEscapingRoundTrips() {
        let tricky = "quote\" backslash\\ slash/ tab\t cr\r nl\n nul\u{0} bell\u{7} esc\u{1B} del\u{7F} ls\u{2028} ps\u{2029} 🇹🇷 İıŞşĞğ é"
        let encoded = JSONWriter.string(.string(tricky))
        XCTAssertFalse(encoded.contains("\n"))
        XCTAssertTrue(encoded.contains(#"\u0000"#))
        XCTAssertTrue(encoded.contains("\\" + "u2028"), "U+2028 is escaped")
        XCTAssertFalse(encoded.unicodeScalars.contains { $0.value == 0x2028 || $0.value == 0x2029 })
        XCTAssertTrue(encoded.contains(#"\u001b"#))
        let decoded = try? JSONSerialization.jsonObject(with: Data(encoded.utf8), options: [.fragmentsAllowed]) as? String
        XCTAssertEqual(decoded, tricky)
    }

    func testNumbers() {
        XCTAssertEqual(JSONWriter.string(.double(.nan)), "null")
        XCTAssertEqual(JSONWriter.string(.double(.infinity)), "null")
        XCTAssertEqual(JSONWriter.string(.double(42)), "42")
        XCTAssertEqual(JSONWriter.string(.double(-3)), "-3")
        XCTAssertEqual(JSONWriter.string(.double(0.1)), "0.1")
        XCTAssertEqual(JSONWriter.string(.double(1_730_540_000_123.456)), "1730540000123.456")
        XCTAssertEqual(JSONWriter.string(.int(Int64.min)), "-9223372036854775808")
        let tiny = JSONWriter.string(.double(1e-7))
        XCTAssertEqual((try? JSONSerialization.jsonObject(with: Data(tiny.utf8), options: [.fragmentsAllowed])) as? Double, 1e-7)
    }

    // MARK: Message shapes

    func testHelloMessage() {
        let action = WireActionDescriptor(id: "ios.appearance", kind: "select", label: "Appearance", group: "ios",
                                          options: [(value: "dark", label: "Dark")], value: "dark")
        let hello = parse(WireMessage.hello(app: app, device: device, session: "s-1", actions: [action], sdkVersion: "0.1.0", ts: 1000))
        XCTAssertEqual(hello["type"] as? String, "hello")
        XCTAssertEqual(hello["protocol"] as? Int, 1)
        XCTAssertEqual(hello["session"] as? String, "s-1")
        let sdk = hello["sdk"] as? [String: Any]
        XCTAssertEqual(sdk?["name"] as? String, "durbun-ios")
        XCTAssertEqual(sdk?["version"] as? String, "0.1.0")
        XCTAssertEqual(sdk?["platform"] as? String, "ios")
        XCTAssertEqual((hello["app"] as? [String: Any])?["id"] as? String, "com.mykynk.pati")
        XCTAssertEqual((hello["app"] as? [String: Any])?["pid"] as? Int, 4242)
        XCTAssertEqual((hello["device"] as? [String: Any])?["simulatorUdid"] as? String, device.simulatorUdid)
        XCTAssertEqual(hello["capabilities"] as? [String], ["logs", "network", "mocks", "metrics", "events", "crash", "commands"])
        let actions = hello["actions"] as? [[String: Any]]
        XCTAssertEqual(actions?.first?["kind"] as? String, "select")
        XCTAssertEqual((actions?.first?["options"] as? [[String: Any]])?.first?["value"] as? String, "dark")
    }

    func testNetworkMessages() {
        let body = WireBody(encoding: .utf8, data: #"{"q":1}"#, size: 7, truncated: false)
        let request = parse(WireMessage.netRequest(
            id: "1", ts: 10, method: "POST", url: "https://api.example.com/v1/login",
            headers: [("Accept", "application/json"), ("Content-Type", "application/json")], body: body))
        XCTAssertEqual(request["type"] as? String, "net.request")
        XCTAssertEqual(request["source"] as? String, "urlsession")
        XCTAssertEqual((request["headers"] as? [[String]])?.first, ["Accept", "application/json"])
        XCTAssertEqual((request["body"] as? [String: Any])?["encoding"] as? String, "utf8")
        XCTAssertNil((request["body"] as? [String: Any])?["truncated"], "truncated only when true")

        let truncated = WireBody(encoding: .base64, data: "AAEC", size: 9000, truncated: true)
        let response = parse(WireMessage.netResponse(
            id: "1", ts: 20, status: 404, statusText: "Not Found", headers: [("Content-Type", "image/png")],
            body: truncated, protocolName: "h2", remoteAddress: "93.184.216.34:443",
            timings: WireTimings(dns: 1.5, connect: 10, tls: 20, send: 0.2, wait: 50, receive: 3),
            mocked: true, mockRuleId: "rule-1"))
        XCTAssertEqual(response["status"] as? Int, 404)
        XCTAssertEqual(response["protocol"] as? String, "h2")
        XCTAssertEqual(response["mocked"] as? Bool, true)
        XCTAssertEqual(response["mockRuleId"] as? String, "rule-1")
        XCTAssertEqual((response["timings"] as? [String: Any])?["wait"] as? Int, 50)
        XCTAssertEqual((response["body"] as? [String: Any])?["truncated"] as? Bool, true)
        XCTAssertEqual((response["body"] as? [String: Any])?["size"] as? Int, 9000)

        let failure = parse(WireMessage.netError(id: "2", ts: 30, error: "Cancelled", cancelled: true, mocked: true, mockRuleId: "r"))
        XCTAssertEqual(failure["cancelled"] as? Bool, true)
        XCTAssertEqual(failure["mocked"] as? Bool, true)
    }

    func testOtherMessages() {
        let event = parse(WireMessage.event(ts: 1, name: "purchase", props: JSONConversion.object(from: ["amount": 49.9, "currency": "TRY"])))
        XCTAssertEqual(event["name"] as? String, "purchase")
        XCTAssertEqual((event["props"] as? [String: Any])?["amount"] as? Double, 49.9)

        var sample = WireMetricSample(ts: 5)
        sample.cpu = 12.5
        sample.memoryMB = 180.25
        sample.fps = 59.8
        sample.jankyFrames = 2
        sample.threads = 31
        let metric = parse(WireMessage.metric(sample))
        XCTAssertEqual(metric["type"] as? String, "metric")
        XCTAssertEqual(metric["jankyFrames"] as? Int, 2)
        XCTAssertNil(metric["heapMB"])

        let result = parse(WireMessage.commandResult(id: "c1", ok: false, data: nil, error: "Unknown command 'x'"))
        XCTAssertEqual(result["type"] as? String, "command.result")
        XCTAssertEqual(result["ok"] as? Bool, false)

        let pong = parse(WireMessage.pong(ts: 9))
        XCTAssertEqual(pong["type"] as? String, "pong")
        let actions = parse(WireMessage.actions([]))
        XCTAssertEqual((actions["actions"] as? [Any])?.count, 0)
    }

    // MARK: Server → SDK

    func testParsesServerMessages() throws {
        let welcome = #"{"type":"welcome","protocol":1,"server":"durbun/0.1.0","appId":"app:3","config":{"captureBodies":false,"maxBodyBytes":2048,"metricsIntervalMs":500,"deviceLogsAvailable":true},"mocks":[{"id":"m1","enabled":true,"method":"GET","url":"/users","match":"contains","action":{"type":"respond","status":201,"headers":[["Content-Type","application/json"]],"body":"{}","delayMs":10},"createdAt":1}]}"#
        guard case let .welcome(parsed)? = ServerMessage.parse(Data(welcome.utf8)) else { return XCTFail("welcome not parsed") }
        XCTAssertEqual(parsed.appId, "app:3")
        XCTAssertEqual(parsed.server, "durbun/0.1.0")
        var expectedConfig = SdkConfig()
        expectedConfig.captureBodies = false
        expectedConfig.maxBodyBytes = 2048
        expectedConfig.metricsIntervalMs = 500
        expectedConfig.deviceLogsAvailable = true
        XCTAssertEqual(parsed.config, expectedConfig)
        XCTAssertEqual(parsed.mocks.count, 1)
        guard case let .respond(status, headers, body, _, delay) = parsed.mocks[0].action else { return XCTFail("respond expected") }
        XCTAssertEqual(status, 201)
        XCTAssertEqual(headers.first?.0, "Content-Type")
        XCTAssertEqual(body, "{}")
        XCTAssertEqual(delay, 10)

        guard case let .command(id, name, params)? = ServerMessage.parse(Data(#"{"type":"command","id":"c9","name":"ios.appearance","params":{"value":"dark"}}"#.utf8)) else {
            return XCTFail("command not parsed")
        }
        XCTAssertEqual(id, "c9")
        XCTAssertEqual(name, "ios.appearance")
        XCTAssertEqual(params["value"] as? String, "dark")

        guard case let .ping(ts)? = ServerMessage.parse(Data(#"{"type":"ping","ts":1730540000000}"#.utf8)) else { return XCTFail("ping") }
        XCTAssertEqual(ts, 1_730_540_000_000)
        guard case let .config(config)? = ServerMessage.parse(Data(#"{"type":"config","config":{"maxBodyBytes":10}}"#.utf8)) else {
            return XCTFail("config")
        }
        XCTAssertEqual(config.maxBodyBytes, 10)
        XCTAssertTrue(config.captureBodies, "missing fields keep defaults")
        guard case let .mocks(rules)? = ServerMessage.parse(Data(#"{"type":"mocks","rules":[{"id":"x"}]}"#.utf8)) else {
            return XCTFail("mocks")
        }
        XCTAssertTrue(rules.isEmpty, "malformed rules are skipped")
        XCTAssertNil(ServerMessage.parse(Data("not json".utf8)))
        XCTAssertNil(ServerMessage.parse(Data(#"{"type":"future-thing"}"#.utf8)))
    }

    // MARK: JSON conversion of user data

    func testConvertsUserData() {
        struct Address: Encodable { let city: String; let zip: Int }
        struct Plain { let name: String; let tags: [String] }
        enum Kind { case gold }
        let optionalNone: String? = nil
        let value = JSONConversion.value(from: [
            "bool": true,
            "nsBool": NSNumber(value: true),
            "int": 42,
            "nsInt": NSNumber(value: 7),
            "double": 49.9,
            "string": "çay",
            "nil": optionalNone as Any,
            "null": NSNull(),
            "date": Date(timeIntervalSince1970: 0),
            "url": URL(string: "https://example.com/a?b=1")!,
            "nested": ["list": [1, "two", false]],
            "encodable": Address(city: "İzmir", zip: 35000),
            "plain": Plain(name: "x", tags: ["a"]),
            "enum": Kind.gold,
            "data": Data([1, 2, 3]),
        ] as [String: Any])
        XCTAssertEqual(value.objectKeys, value.objectKeys.sorted(), "keys are sorted for stable output")
        XCTAssertEqual(value["bool"], .bool(true))
        XCTAssertEqual(value["nsBool"], .bool(true))
        XCTAssertEqual(value["int"], .int(42))
        XCTAssertEqual(value["nsInt"], .int(7))
        XCTAssertEqual(value["double"], .double(49.9))
        XCTAssertEqual(value["string"], .string("çay"))
        XCTAssertEqual(value["nil"], .null)
        XCTAssertEqual(value["null"], .null)
        XCTAssertEqual(value["date"], .string("1970-01-01T00:00:00.000Z"))
        XCTAssertEqual(value["url"], .string("https://example.com/a?b=1"))
        XCTAssertEqual(value["nested"]?["list"], .array([.int(1), .string("two"), .bool(false)]))
        XCTAssertEqual(value["encodable"]?["city"], .string("İzmir"))
        XCTAssertEqual(value["encodable"]?["zip"], .int(35000))
        XCTAssertEqual(value["plain"]?["tags"], .array([.string("a")]))
        XCTAssertEqual(value["enum"], .string("gold"))
        XCTAssertEqual(value["data"], .string("<3 bytes>"))
    }

    func testDescribesErrors() {
        enum APIError: Error { case unauthorized }
        struct Friendly: LocalizedError { var errorDescription: String? { "Oturum süresi doldu" } }
        XCTAssertTrue(JSONConversion.describe(APIError.unauthorized).hasSuffix("APIError.unauthorized"))
        XCTAssertEqual(JSONConversion.describe(Friendly()), "Oturum süresi doldu")
        XCTAssertEqual(JSONConversion.describe(NSError(domain: "x", code: 1, userInfo: [NSLocalizedDescriptionKey: "boom"])), "boom")
        XCTAssertTrue(NetworkErrorText.describe(URLError(.timedOut)).hasSuffix("[URLError.timedOut -1001]"))
    }

    // MARK: Field names vs. packages/protocol/src/index.ts

    private static let protocolFile = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("packages/protocol/src/index.ts")

    /// Top-level fields of `export interface <name>` (all, and the required ones).
    private func tsFields(_ source: String, _ name: String) -> (all: Set<String>, required: Set<String>)? {
        guard let start = source.range(of: "export interface \(name) ") else { return nil }
        guard let open = source[start.upperBound...].firstIndex(of: "{") else { return nil }
        var depth = 0
        var all = Set<String>()
        var required = Set<String>()
        var index = open
        var lineStartDepth = 0
        var line = ""
        while index < source.endIndex {
            let ch = source[index]
            if ch == "{" { depth += 1 }
            if ch == "}" { depth -= 1 }
            if ch == "\n" {
                if lineStartDepth == 1, let match = line.range(of: #"^\s*(\w+)(\?)?\s*:"#, options: .regularExpression) {
                    let field = String(line[match]).trimmingCharacters(in: .whitespaces)
                    let optional = field.contains("?")
                    let fieldName = field.replacingOccurrences(of: "?", with: "").replacingOccurrences(of: ":", with: "")
                        .trimmingCharacters(in: .whitespaces)
                    all.insert(fieldName)
                    if !optional { required.insert(fieldName) }
                }
                line = ""
                lineStartDepth = depth
            } else {
                line.append(ch)
            }
            if depth == 0 && ch == "}" { break }
            index = source.index(after: index)
        }
        return (all, required)
    }

    private func keys(_ value: JSONValue) -> Set<String> { Set(value.objectKeys) }

    func testFieldNamesMatchTheProtocolFile() throws {
        guard let source = try? String(contentsOf: Self.protocolFile, encoding: .utf8) else {
            throw XCTSkip("protocol file not found at \(Self.protocolFile.path) (package used outside the repo)")
        }
        let body = WireBody(encoding: .utf8, data: "x", size: 1, truncated: true)
        let action = WireActionDescriptor(id: "a", kind: "select", label: "A", labelKey: "k", group: "g",
                                          options: [(value: "v", label: "V")], value: "v")
        var sample = WireMetricSample(ts: 1)
        sample.cpu = 1; sample.memoryMB = 1; sample.heapMB = 1; sample.fps = 1; sample.jankyFrames = 1
        sample.frameBuildMs = 1; sample.frameRasterMs = 1; sample.threads = 1
        let full: [(String, JSONValue)] = [
            ("SdkHello", WireMessage.hello(app: app, device: device, session: "s", actions: [action], sdkVersion: "1", ts: 1)),
            ("SdkLog", WireMessage.log(ts: 1, level: .error, tag: "t", message: "m", data: .null,
                                       error: WireErrorInfo(type: "T", message: "M", stack: "S"), kind: "crash", tid: 1)),
            ("SdkNetRequest", WireMessage.netRequest(id: "1", ts: 1, method: "GET", url: "u", headers: [], body: body)),
            ("SdkNetResponse", WireMessage.netResponse(id: "1", ts: 1, status: 200, statusText: "OK", headers: [], body: body,
                                                       protocolName: "h2", remoteAddress: "a", timings: WireTimings(dns: 1),
                                                       mocked: true, mockRuleId: "r")),
            ("SdkNetError", WireMessage.netError(id: "1", ts: 1, error: "e", cancelled: true, mocked: true, mockRuleId: "r")),
            ("SdkEvent", WireMessage.event(ts: 1, name: "n", props: .object([]))),
            ("SdkMetric", WireMessage.metric(sample)),
            ("SdkCommandResult", WireMessage.commandResult(id: "1", ok: true, data: .null, error: "e")),
            ("SdkActionsUpdate", WireMessage.actions([action])),
            ("SdkPong", WireMessage.pong(ts: 1)),
            ("WireBody", body.json),
            ("Timings", WireTimings(dns: 1, connect: 1, tls: 1, send: 1, wait: 1, receive: 1).json),
            ("ErrorInfo", WireErrorInfo(type: "a", message: "b", stack: "c").json),
            ("AppInfo", app.json),
            ("DeviceHints", WireDeviceHints(platform: "ios", model: "m", manufacturer: "Apple", name: "n", osVersion: "1",
                                            isPhysical: true, simulatorUdid: "u").json),
            ("AppActionDescriptor", action.json),
        ]
        var checkedApiLevel = false
        for (name, value) in full {
            guard let fields = tsFields(source, name) else { return XCTFail("interface \(name) not found in protocol file") }
            var expected = fields.all
            // DeviceHints.apiLevel is Android-only; the iOS SDK never sends it.
            if name == "DeviceHints" {
                expected.remove("apiLevel")
                checkedApiLevel = true
            }
            XCTAssertEqual(keys(value), expected, "\(name): emitted fields differ from the protocol interface")
        }
        XCTAssertTrue(checkedApiLevel)

        // Minimal messages still carry every required field.
        let minimal: [(String, JSONValue)] = [
            ("SdkLog", WireMessage.log(ts: 1, level: .info, tag: nil, message: "m")),
            ("SdkNetRequest", WireMessage.netRequest(id: "1", ts: 1, method: "GET", url: "u", headers: [], body: nil)),
            ("SdkNetResponse", WireMessage.netResponse(id: "1", ts: 1, status: 200, statusText: nil, headers: [], body: nil)),
            ("SdkNetError", WireMessage.netError(id: "1", ts: 1, error: "e")),
            ("SdkEvent", WireMessage.event(ts: 1, name: "n", props: nil)),
            ("SdkMetric", WireMessage.metric(WireMetricSample(ts: 1))),
            ("SdkCommandResult", WireMessage.commandResult(id: "1", ok: true, data: nil, error: nil)),
        ]
        for (name, value) in minimal {
            let fields = try XCTUnwrap(tsFields(source, name))
            XCTAssertTrue(fields.required.isSubset(of: keys(value)), "\(name): missing required \(fields.required.subtracting(keys(value)))")
        }

        // Fields the SDK reads from the server.
        XCTAssertEqual(tsFields(source, "SdkConfig")?.all, ["captureBodies", "maxBodyBytes", "metricsIntervalMs", "deviceLogsAvailable"])
        XCTAssertEqual(tsFields(source, "ServerWelcome")?.all, ["type", "protocol", "server", "appId", "config", "mocks"])
        XCTAssertEqual(tsFields(source, "MockRule")?.all, ["id", "enabled", "name", "method", "url", "match", "apps", "action", "createdAt"])
        XCTAssertTrue(source.contains("deviceSdkFirst: 9752"), "device listener range")
        XCTAssertTrue(source.contains("deviceSdkLast: 9755"), "device listener range")
        XCTAssertTrue(source.contains("sdk: 9751"), "SDK port")
    }
}
