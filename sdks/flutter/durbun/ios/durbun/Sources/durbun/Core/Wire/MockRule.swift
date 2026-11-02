import Foundation

/// Swift mirror of the protocol's `MockRule` with matching semantics identical to the reference
/// `mockRuleMatches` (see `packages/protocol/src/index.ts`):
///  - method: `*` matches anything, otherwise case-insensitive equality;
///  - contains / exact / glob: case-insensitive; glob `*` = any run of characters (incl. `/`),
///    `?` = exactly one, matched against the WHOLE url;
///  - regex: pattern as-is (case-sensitive), searched anywhere in the url; invalid never matches;
///  - apps: empty/nil = every app, otherwise must contain the app id.
/// Comparisons work on UTF-16 code units like JavaScript strings do.
struct MockRule {
    enum Match: Equatable {
        case contains, exact, glob, regex
        case unknown(String)
    }

    enum FailKind: String {
        case timeout, connection, dns, tls, custom
    }

    enum Action {
        case respond(status: Int, headers: [(String, String)], body: String?, bodyEncoding: String?, delayMs: Double?)
        case delay(delayMs: Double)
        case fail(kind: FailKind, message: String?, delayMs: Double?)
        /// An action type this SDK version does not know: the request passes through untouched.
        case unsupported(String)
    }

    var id: String
    var enabled: Bool
    var name: String?
    var method: String
    var url: String
    var match: Match
    var apps: [String]?
    var action: Action
    var createdAt: Double

    // MARK: Matching

    func matches(method requestMethod: String, url requestURL: String, appId: String?) -> Bool {
        guard enabled else { return false }
        if let apps, !apps.isEmpty {
            guard let appId, apps.contains(where: { $0.utf16.elementsEqual(appId.utf16) }) else { return false }
        }
        if method != "*" && !method.uppercased().utf16.elementsEqual(requestMethod.uppercased().utf16) {
            return false
        }
        let u = requestURL.lowercased()
        let p = url.lowercased()
        switch match {
        case .contains:
            return !p.isEmpty && (u as NSString).range(of: p, options: .literal).location != NSNotFound
        case .exact:
            return u.utf16.elementsEqual(p.utf16)
        case .glob:
            return MockRule.globMatches(pattern: Array(p.utf16), text: Array(u.utf16))
        case .regex:
            // JavaScript's `new RegExp('')` matches everything; NSRegularExpression rejects "".
            if url.isEmpty { return true }
            guard let regex = RegexCache.shared.regex(for: url) else { return false }
            let range = NSRange(location: 0, length: (requestURL as NSString).length)
            return regex.firstMatch(in: requestURL, options: [], range: range) != nil
        case .unknown:
            return false
        }
    }

    /// First enabled matching rule; rules are ordered and the first match wins.
    static func first(in rules: [MockRule], method: String, url: String, appId: String?) -> MockRule? {
        rules.first { $0.matches(method: method, url: url, appId: appId) }
    }

    /// Whole-string glob over UTF-16 code units. Equivalent to the reference implementation's
    /// `^…$` regex where `*` → `.*` and `?` → `.`: in JavaScript `.` matches any code unit except
    /// the line terminators \n, \r, U+2028 and U+2029, so neither wildcard can consume those.
    static func globMatches(pattern: [UInt16], text: [UInt16]) -> Bool {
        let star: UInt16 = 0x2A
        let question: UInt16 = 0x3F
        let n = text.count
        // matched[j]: the pattern prefix processed so far matches text[0..<j].
        var matched = [Bool](repeating: false, count: n + 1)
        matched[0] = true
        var next = [Bool](repeating: false, count: n + 1)
        for c in pattern {
            if c == star {
                next[0] = matched[0]
                if n > 0 {
                    for j in 1...n {
                        next[j] = matched[j] || (next[j - 1] && !isLineTerminator(text[j - 1]))
                    }
                }
            } else {
                next[0] = false
                if n > 0 {
                    for j in 1...n {
                        let unit = text[j - 1]
                        let unitMatches = c == question ? !isLineTerminator(unit) : unit == c
                        next[j] = matched[j - 1] && unitMatches
                    }
                }
            }
            swap(&matched, &next)
            if !matched.contains(true) { return false }
        }
        return matched[n]
    }

    private static func isLineTerminator(_ unit: UInt16) -> Bool {
        unit == 0x0A || unit == 0x0D || unit == 0x2028 || unit == 0x2029
    }

    // MARK: Parsing

    static func parseList(_ value: Any?) -> [MockRule] {
        guard let list = value as? [Any] else { return [] }
        return list.compactMap { ($0 as? [String: Any]).flatMap(MockRule.init(json:)) }
    }

    init?(json: [String: Any]) {
        guard let id = json["id"] as? String,
              let method = json["method"] as? String,
              let url = json["url"] as? String,
              let match = json["match"] as? String,
              let action = json["action"] as? [String: Any],
              let actionType = action["type"] as? String
        else { return nil }
        self.id = id
        // Like JavaScript's `!rule.enabled`: only a true value enables the rule.
        enabled = (json["enabled"] as? NSNumber).map { CFGetTypeID($0) == CFBooleanGetTypeID() && $0.boolValue } ?? false
        name = json["name"] as? String
        self.method = method
        self.url = url
        switch match {
        case "contains": self.match = .contains
        case "exact": self.match = .exact
        case "glob": self.match = .glob
        case "regex": self.match = .regex
        default: self.match = .unknown(match)
        }
        apps = (json["apps"] as? [Any])?.compactMap { $0 as? String }
        createdAt = JSONRead.double(json["createdAt"]) ?? 0
        let delayMs = JSONRead.double(action["delayMs"]).map { max(0, $0) }
        switch actionType {
        case "respond":
            self.action = .respond(
                status: JSONRead.int(action["status"]) ?? 200,
                headers: JSONRead.headers(action["headers"]),
                body: action["body"] as? String,
                bodyEncoding: action["bodyEncoding"] as? String,
                delayMs: delayMs
            )
        case "delay":
            self.action = .delay(delayMs: delayMs ?? 0)
        case "fail":
            let kind = (action["error"] as? String).flatMap(FailKind.init(rawValue:)) ?? .custom
            self.action = .fail(kind: kind, message: action["message"] as? String, delayMs: delayMs)
        default:
            self.action = .unsupported(actionType)
        }
    }

    init(
        id: String,
        enabled: Bool = true,
        name: String? = nil,
        method: String = "*",
        url: String,
        match: Match,
        apps: [String]? = nil,
        action: Action,
        createdAt: Double = 0
    ) {
        self.id = id
        self.enabled = enabled
        self.name = name
        self.method = method
        self.url = url
        self.match = match
        self.apps = apps
        self.action = action
        self.createdAt = createdAt
    }
}

/// Compiled regex patterns shared by all rules (`nil` entry = invalid pattern).
final class RegexCache {
    static let shared = RegexCache()

    private let lock = UnfairLock()
    private var cache: [String: NSRegularExpression?] = [:]

    func regex(for pattern: String) -> NSRegularExpression? {
        if let cached = lock.withLock({ cache[pattern] }) { return cached }
        let compiled = try? NSRegularExpression(pattern: pattern, options: [])
        lock.withLock {
            if cache.count > 256 { cache.removeAll() }
            cache[pattern] = .some(compiled)
        }
        return compiled
    }
}
