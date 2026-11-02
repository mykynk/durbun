import XCTest
@testable import Durbun

/// Parity with the reference `mockRuleMatches` / `findMockRule` (packages/protocol/src/index.ts).
/// The vectors are produced by running the TypeScript implementation itself:
/// `node sdks/ios/scripts/generate-mock-vectors.mjs`.
final class MockMatchingTests: XCTestCase {
    private struct Vectors {
        var rules: [[String: Any]]
        var urls: [String]
        var cases: [[String: Any]]
        var lists: [[Int]]
        var finds: [[String: Any]]
    }

    private func loadVectors() throws -> Vectors {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "mock-vectors", withExtension: "json", subdirectory: "Fixtures"))
        let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        return Vectors(
            rules: try XCTUnwrap(object["rules"] as? [[String: Any]]),
            urls: try XCTUnwrap(object["urls"] as? [String]),
            cases: try XCTUnwrap(object["cases"] as? [[String: Any]]),
            lists: try XCTUnwrap(object["lists"] as? [[Int]]),
            finds: try XCTUnwrap(object["finds"] as? [[String: Any]])
        )
    }

    func testMatchesReferenceImplementation() throws {
        let vectors = try loadVectors()
        let rules = vectors.rules.map { MockRule(json: $0) }
        XCTAssertTrue(rules.allSatisfy { $0 != nil }, "every reference rule parses")
        XCTAssertGreaterThan(vectors.cases.count, 2000)
        var failures: [String] = []
        for testCase in vectors.cases {
            let ruleIndex = testCase["r"] as! Int
            let url = vectors.urls[testCase["u"] as! Int]
            let method = testCase["m"] as! String
            let appId = testCase["a"] as? String
            let expected = testCase["e"] as! Bool
            let actual = rules[ruleIndex]!.matches(method: method, url: url, appId: appId)
            if actual != expected {
                let rule = vectors.rules[ruleIndex]
                failures.append("\(rule["match"]!) \(String(reflecting: rule["url"]!)) method=\(rule["method"]!) vs \(method) \(String(reflecting: url)) app=\(appId ?? "nil"): expected \(expected)")
            }
        }
        XCTAssertTrue(failures.isEmpty, "\(failures.count) mismatches:\n" + failures.prefix(20).joined(separator: "\n"))
    }

    func testFirstMatchWinsLikeReference() throws {
        let vectors = try loadVectors()
        let rules = vectors.rules.map { MockRule(json: $0)! }
        for find in vectors.finds {
            let list = vectors.lists[find["l"] as! Int].map { rules[$0] }
            let url = vectors.urls[find["u"] as! Int]
            let hit = MockRule.first(in: list, method: find["m"] as! String, url: url, appId: find["a"] as? String)
            XCTAssertEqual(hit?.id, find["id"] as? String, "list \(find["l"]!) url \(String(reflecting: url))")
        }
    }

    func testGlobEdgeCases() {
        func glob(_ pattern: String, _ text: String) -> Bool {
            MockRule.globMatches(pattern: Array(pattern.utf16), text: Array(text.utf16))
        }
        XCTAssertTrue(glob("", ""))
        XCTAssertFalse(glob("", "a"))
        XCTAssertTrue(glob("*", ""))
        XCTAssertTrue(glob("a*b*c", "aXXbYYc"))
        XCTAssertFalse(glob("a*b*c", "aXXbYY"))
        XCTAssertTrue(glob("?", "x"))
        XCTAssertFalse(glob("?", ""))
        XCTAssertFalse(glob("a*c", "a\nc"), "JS '.' never matches a line terminator")
        XCTAssertFalse(glob("a?c", "a\u{2028}c"))
        XCTAssertTrue(glob("a\nc", "a\nc"), "literal line terminators still match themselves")
        XCTAssertFalse(glob("?", "😀"), "JavaScript strings are UTF-16: one emoji is two code units")
        XCTAssertTrue(glob("??", "😀"))
        let long = String(repeating: "a", count: 2000)
        XCTAssertFalse(glob(String(repeating: "*a", count: 30) + "b", long), "no exponential backtracking")
    }

    func testParsesActions() {
        let respond = MockRule(json: [
            "id": "1", "enabled": true, "method": "GET", "url": "/x", "match": "contains", "createdAt": 1,
            "action": ["type": "respond", "status": 503, "body": "eyJhIjoxfQ==", "bodyEncoding": "base64"],
        ])
        guard case let .respond(status, headers, body, encoding, respondDelay)? = respond?.action else { return XCTFail("respond") }
        XCTAssertEqual(status, 503)
        XCTAssertTrue(headers.isEmpty)
        XCTAssertEqual(body, "eyJhIjoxfQ==")
        XCTAssertEqual(encoding, "base64")
        XCTAssertNil(respondDelay)

        let fail = MockRule(json: [
            "id": "2", "enabled": true, "method": "*", "url": "x", "match": "glob", "createdAt": 1,
            "action": ["type": "fail", "error": "dns", "delayMs": 250],
        ])
        guard case let .fail(kind, message, failDelay)? = fail?.action else { return XCTFail("fail") }
        XCTAssertEqual(kind, .dns)
        XCTAssertNil(message)
        XCTAssertEqual(failDelay, 250)

        let delay = MockRule(json: [
            "id": "3", "enabled": true, "method": "*", "url": "x", "match": "exact", "createdAt": 1,
            "action": ["type": "delay", "delayMs": 1500],
        ])
        guard case let .delay(ms)? = delay?.action else { return XCTFail("delay") }
        XCTAssertEqual(ms, 1500)

        let future = MockRule(json: [
            "id": "4", "enabled": true, "method": "*", "url": "x", "match": "exact", "createdAt": 1,
            "action": ["type": "teleport"],
        ])
        guard case .unsupported("teleport")? = future?.action else { return XCTFail("unsupported") }

        XCTAssertNil(MockRule(json: ["id": "5", "enabled": true]), "incomplete rules are rejected")
        let disabledByNumber = MockRule(json: [
            "id": "6", "enabled": 1, "method": "*", "url": "x", "match": "contains", "createdAt": 1,
            "action": ["type": "delay", "delayMs": 1],
        ])
        XCTAssertEqual(disabledByNumber?.enabled, false, "only a JSON true enables a rule")
    }

    func testInvalidRegexNeverMatchesAndIsCached() {
        let rule = MockRule(id: "r", url: "([", match: .regex, action: .delay(delayMs: 0))
        XCTAssertFalse(rule.matches(method: "GET", url: "https://example.com/([", appId: nil))
        XCTAssertNil(RegexCache.shared.regex(for: "(["))
        XCTAssertNotNil(RegexCache.shared.regex(for: "users/\\d+"))
    }
}
