import XCTest
@testable import Durbun

/// Mock matching v2 (rules limited to a GraphQL operation). `Fixtures/mock-graphql.json` is a copy of the shared
/// vectors (`packages/protocol/vectors/mock-graphql.json`, generated from the protocol's reference functions; copied
/// by `scripts/generate-mock-vectors.mjs`), so these assertions are the TypeScript results.
final class MockGraphqlTests: XCTestCase {
    private static let repositoryVectors = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("../../packages/protocol/vectors/mock-graphql.json").standardizedFileURL

    private func fixtureData() throws -> Data {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "mock-graphql", withExtension: "json", subdirectory: "Fixtures"))
        return try Data(contentsOf: url)
    }

    private func vectors() throws -> [String: Any] {
        try XCTUnwrap(try JSONSerialization.jsonObject(with: fixtureData()) as? [String: Any])
    }

    private final class Counter {
        var value = 0
    }

    private struct VectorRequest {
        var method: String
        var url: String
        var appId: String?
        var contentType: String?
        var body: String?

        init(_ json: [String: Any]) {
            method = json["method"] as! String
            url = json["url"] as! String
            appId = json["appId"] as? String
            contentType = json["contentType"] as? String
            if let pattern = json["bodyPattern"] as? [[Any]] {
                body = pattern.map { String(repeating: $0[0] as! String, count: ($0[1] as! NSNumber).intValue) }.joined()
            } else {
                body = json["body"] as? String
            }
        }

        /// The body as UTF-16 units, exactly as JavaScript holds it (lone surrogates included).
        var units: [UInt16]? { body.map { Array($0.utf16) } }

        func input(reads: Counter? = nil) -> MockRequest {
            let units = self.units
            return MockRequest(method: method, url: url, appId: appId, contentType: contentType) {
                reads?.value += 1
                return units
            }
        }
    }

    private func expected(_ value: Any?) -> [GraphqlOperation]? {
        guard let list = value as? [[String: Any]] else { return nil }
        return list.map { GraphqlOperation(name: ($0["name"] as? String).map { Array($0.utf16) }, type: $0["type"] as? String) }
    }

    func testTheCopyOfTheSharedVectorsIsCurrent() throws {
        guard let original = try? Data(contentsOf: Self.repositoryVectors) else {
            throw XCTSkip("shared vectors not found (package used outside the repository)")
        }
        XCTAssertEqual(try fixtureData(), original, "stale copy: run node --import tsx sdks/ios/scripts/generate-mock-vectors.mjs")
    }

    func testOperationsAreReadExactlyLikeTheReference() throws {
        let vectors = try vectors()
        XCTAssertEqual((vectors["maxChars"] as? NSNumber)?.intValue, GraphqlMatching.maxChars)
        let cases = try XCTUnwrap(vectors["operations"] as? [[String: Any]])
        XCTAssertGreaterThan(cases.count, 80)
        var failures: [String] = []
        for testCase in cases {
            let request = VectorRequest(try XCTUnwrap(testCase["request"] as? [String: Any]))
            let actual = GraphqlMatching.operations(method: request.method, url: request.url, contentType: request.contentType, body: request.units)
            let want = expected(testCase["expected"])
            if actual != want {
                failures.append("\(testCase["description"] ?? ""): expected \(String(describing: want)), got \(String(describing: actual))")
            }
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }

    func testRulesMatchExactlyLikeTheReference() throws {
        let cases = try XCTUnwrap(try vectors()["matches"] as? [[String: Any]])
        var failures: [String] = []
        for testCase in cases {
            let rule = try XCTUnwrap(MockRule(json: try XCTUnwrap(testCase["rule"] as? [String: Any])), "\(testCase["rule"] ?? "")")
            let request = VectorRequest(try XCTUnwrap(testCase["request"] as? [String: Any]))
            let actual = rule.matches(request.input())
            if actual != (testCase["expected"] as? Bool) { failures.append("\(testCase["rule"] ?? ""): expected \(testCase["expected"] ?? "")") }
            let noBody = rule.matches(method: request.method, url: request.url, appId: request.appId)
            if noBody != (testCase["matchesNoBody"] as? Bool) { failures.append("no body \(testCase["rule"] ?? "")") }
        }
        XCTAssertTrue(failures.isEmpty, failures.joined(separator: "\n"))
    }

    func testFirstMatchingRuleWinsAndTheBodyIsReadOnce() throws {
        let finds = try XCTUnwrap(try vectors()["finds"] as? [String: Any])
        let rules = MockRule.parseList(finds["rules"])
        XCTAssertEqual(rules.count, 4)
        for testCase in try XCTUnwrap(finds["cases"] as? [[String: Any]]) {
            let request = VectorRequest(try XCTUnwrap(testCase["request"] as? [String: Any]))
            let reads = Counter()
            let hit = MockRule.first(in: rules, request: request.input(reads: reads))
            XCTAssertEqual(hit?.id, testCase["expectedId"] as? String, "\(request.method) \(request.url)")
            XCTAssertLessThanOrEqual(reads.value, 1)
        }
    }

    func testBodyBytesAreStrictUTF8() {
        XCTAssertEqual(StrictUTF8.bodyText(Data([0xEF, 0xBB, 0xBF, 0x7B, 0x7D])), Array("{}".utf16), "one BOM is dropped")
        XCTAssertNil(StrictUTF8.bodyText(Data([0x7B, 0xC3, 0x7D])), "a truncated sequence is not text")
        XCTAssertNil(StrictUTF8.bodyText(Data([0xED, 0xA0, 0x80])), "an encoded surrogate is not text")
        XCTAssertEqual(StrictUTF8.bodyText(Data("😀ş".utf8)), Array("😀ş".utf16))
    }
}
