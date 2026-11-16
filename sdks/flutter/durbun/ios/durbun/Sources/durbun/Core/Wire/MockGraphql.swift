import Foundation

// Mock matching v2: rule conditions (`MockRule.when`) and the GraphQL operation of a request. Exact port of
// `graphqlOperationsOf` / `mockRuleMatchesRequest` / `findMockRuleForRequest` in the shared protocol
// (`packages/protocol/src/index.ts`); the shared vectors in `packages/protocol/vectors/mock-graphql.json` are the test.
// Everything works on UTF-16 code units like JavaScript strings (lengths, names, the GraphQL tokenizer), JSON is read
// strictly (RFC 8259, as `JSON.parse` reads it) and URL parameters are decoded like `decodeURIComponent`.

/// A `MockRule.when.graphql` condition that can be evaluated (name non-empty, type absent or known).
struct GraphqlCondition: Equatable {
    var operationName: String
    var operationType: String?
}

/// One GraphQL operation of a request: `name` nil = anonymous, `type` nil = not known.
struct GraphqlOperation: Equatable {
    var name: [UInt16]?
    var type: String?

    var nameString: String? { name.map { String(decoding: $0, as: UTF16.self) } }
}

/// The conditions of a rule as received: the keys used and the GraphQL condition when it is valid.
struct MockConditions {
    /// Keys of `when` holding a value; `when` itself when it is not an object (never matches).
    var usedKeys: [String]
    /// The `graphql` condition, nil when absent or malformed (a malformed one never matches).
    var graphql: GraphqlCondition?

    static let none = MockConditions(usedKeys: [], graphql: nil)

    /// Reads `rule.when` exactly like the reference's `mockRuleMatchersUsed` and condition check.
    init(json value: Any?) {
        guard let value, !(value is NSNull) else {
            self = .none
            return
        }
        guard let object = value as? [String: Any] else {
            self.init(usedKeys: ["when"], graphql: nil)
            return
        }
        let keys = object.filter { !($0.value is NSNull) }.map(\.key).sorted()
        var condition: GraphqlCondition?
        if let raw = object["graphql"] as? [String: Any], let name = raw["operationName"] as? String, !name.isEmpty {
            let type = raw["operationType"]
            if type == nil || type is NSNull {
                condition = GraphqlCondition(operationName: name, operationType: nil)
            } else if let type = type as? String, ["query", "mutation", "subscription"].contains(type) {
                condition = GraphqlCondition(operationName: name, operationType: type)
            }
        }
        self.init(usedKeys: keys, graphql: condition)
    }

    init(usedKeys: [String], graphql: GraphqlCondition?) {
        self.usedKeys = usedKeys
        self.graphql = graphql
    }
}

/// What a rule is matched against. `body` gives the body text (UTF-16 units) only when the SDK already holds it;
/// it is called at most once, and only when a rule with a condition matches method / URL / apps.
final class MockRequest {
    let method: String
    let url: String
    let appId: String?
    let contentType: String?
    private let body: (() -> [UInt16]?)?
    private var read = false
    private var text: [UInt16]?

    init(method: String, url: String, appId: String?, contentType: String? = nil, body: (() -> [UInt16]?)? = nil) {
        self.method = method
        self.url = url
        self.appId = appId
        self.contentType = contentType
        self.body = body
    }

    func bodyText() -> [UInt16]? {
        if !read {
            read = true
            text = body?()
        }
        return text
    }
}

enum GraphqlMatching {
    /// Longest text (UTF-16 code units: a body or a `query` URL parameter) the GraphQL reading looks at.
    static let maxChars = 64 * 1024
    /// Bodies longer than this many bytes have more than `maxChars` UTF-16 units and are never decoded.
    static let maxBodyBytes = 3 * maxChars
    /// The matcher keys this SDK evaluates (`hello.sdk.mockMatchers`).
    static let matchers = ["graphql"]

    /// Whether a rule (already matching method / URL / apps) holds; `operations` is read lazily.
    static func conditionsHold(_ conditions: MockConditions, operations: () -> [GraphqlOperation]?) -> Bool {
        if conditions.usedKeys.isEmpty { return true }
        if conditions.usedKeys.contains(where: { $0 != "graphql" }) { return false }
        guard let condition = conditions.graphql, let ops = operations() else { return false }
        let wanted = Array(condition.operationName.utf16)
        return ops.contains { op in
            op.name == wanted && (condition.operationType == nil || op.type == condition.operationType)
        }
    }

    /// The reference's `graphqlOperationsOf`: the operation(s) of a request, or nil when unknown.
    static func operations(method: String, url: String, contentType: String?, body: [UInt16]?) -> [GraphqlOperation]? {
        let raw = body ?? []
        let trimmed = trimAsciiWhitespace(raw)
        if !trimmed.isEmpty {
            if raw.count > maxChars { return nil }
            let ct = (contentType ?? "").lowercased()
            if ct.contains("application/graphql") && !ct.contains("json") {
                guard let first = documentOperations(trimmed).first else { return nil }
                return [first]
            }
            guard trimmed[0] == 0x7B || trimmed[0] == 0x5B else { return nil } // { or [
            guard let payloads = StrictJSON.payloads(trimmed) else { return nil }
            let ops = payloads.compactMap { payloadOperation(query: $0.query, operationName: $0.operationName) }
            return ops.isEmpty ? nil : ops
        }
        guard method.uppercased() == "GET" else { return nil }
        guard let params = urlQueryParams(Array(url.utf16)) else { return nil }
        let query = params.first { $0.key == Array("query".utf16) }?.value
        let name = params.first { $0.key == Array("operationName".utf16) }?.value
        guard let op = payloadOperation(query: query, operationName: name) else { return nil }
        return [op]
    }

    /// One `{ query?, operationName? }` payload (values that are not strings arrive as nil).
    private static func payloadOperation(query: [UInt16]?, operationName: [UInt16]?) -> GraphqlOperation? {
        let name = (operationName?.isEmpty ?? true) ? nil : operationName
        if let query {
            if query.count > maxChars { return nil }
            let ops = documentOperations(query)
            if let name { return GraphqlOperation(name: name, type: ops.first { $0.name == name }?.type) }
            return ops.first
        }
        return name.map { GraphqlOperation(name: $0, type: nil) }
    }

    private static func isNameStart(_ c: UInt16) -> Bool {
        (c >= 0x61 && c <= 0x7A) || (c >= 0x41 && c <= 0x5A) || c == 0x5F
    }

    private static func isNameChar(_ c: UInt16) -> Bool {
        isNameStart(c) || (c >= 0x30 && c <= 0x39)
    }

    private static func starts(_ doc: [UInt16], _ prefix: [UInt16], at i: Int) -> Bool {
        guard i + prefix.count <= doc.count else { return false }
        for k in 0..<prefix.count where doc[i + k] != prefix[k] { return false }
        return true
    }

    private static let tripleQuote: [UInt16] = [0x22, 0x22, 0x22]
    private static let escapedTripleQuote: [UInt16] = [0x5C, 0x22, 0x22, 0x22]
    private static let keywords: [[UInt16]: String] = [
        Array("query".utf16): "query", Array("mutation".utf16): "mutation", Array("subscription".utf16): "subscription",
    ]
    private static let fragmentWord = Array("fragment".utf16)

    /// Operation definitions of a GraphQL document, in order (fragments skipped); the reference's tokenizer.
    static func documentOperations(_ doc: [UInt16]) -> [GraphqlOperation] {
        var ops: [GraphqlOperation] = []
        let n = doc.count
        var i = 0
        var depth = 0
        var parens = 0
        // A definition word was read at depth 0 and its selection set has not started yet.
        var pending = false
        let lf: UInt16 = 0x0A, cr: UInt16 = 0x0D
        while i < n {
            let c = doc[i]
            if c == 0x23 { // #
                while i < n && doc[i] != lf && doc[i] != cr { i += 1 }
            } else if c == 0x22 { // "
                if starts(doc, tripleQuote, at: i) {
                    i += 3
                    while i < n && !starts(doc, tripleQuote, at: i) { i += starts(doc, escapedTripleQuote, at: i) ? 4 : 1 }
                    i = min(n, i + 3)
                } else {
                    i += 1
                    while i < n && doc[i] != 0x22 && doc[i] != lf { i += doc[i] == 0x5C ? 2 : 1 }
                    i = min(n, i + 1)
                }
            } else if c == 0x28 { // (
                parens += 1
                i += 1
            } else if c == 0x29 { // )
                parens = max(0, parens - 1)
                i += 1
            } else if c == 0x7B { // {
                if depth == 0 && parens == 0 {
                    if !pending { ops.append(GraphqlOperation(name: nil, type: "query")) }
                    pending = false
                }
                depth += 1
                i += 1
            } else if c == 0x7D { // }
                depth = max(0, depth - 1)
                i += 1
            } else if isNameStart(c) {
                let start = i
                while i < n && isNameChar(doc[i]) { i += 1 }
                if depth == 0 && parens == 0 && !pending {
                    let word = Array(doc[start..<i])
                    if let type = keywords[word] {
                        var j = i
                        while j < n {
                            let d = doc[j]
                            if d == 0x23 {
                                while j < n && doc[j] != lf && doc[j] != cr { j += 1 }
                            } else if d == 0x20 || d == 0x09 || d == lf || d == cr || d == 0x2C || d == 0xFEFF {
                                j += 1
                            } else {
                                break
                            }
                        }
                        if j < n && isNameStart(doc[j]) {
                            var k = j
                            while k < n && isNameChar(doc[k]) { k += 1 }
                            ops.append(GraphqlOperation(name: Array(doc[j..<k]), type: type))
                            i = k
                        } else {
                            ops.append(GraphqlOperation(name: nil, type: type))
                        }
                        pending = true
                    } else if word == fragmentWord {
                        pending = true
                    }
                }
            } else {
                i += 1
            }
        }
        return ops
    }

    private static func isAsciiSpace(_ c: UInt16) -> Bool { c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D }

    private static func trimAsciiWhitespace(_ s: [UInt16]) -> [UInt16] {
        var a = 0
        var b = s.count
        while a < b && isAsciiSpace(s[a]) { a += 1 }
        while b > a && isAsciiSpace(s[b - 1]) { b -= 1 }
        return Array(s[a..<b])
    }

    /// `name=value` pairs of a URL's query string, in order; nil when one cannot be decoded.
    static func urlQueryParams(_ url: [UInt16]) -> [(key: [UInt16], value: [UInt16])]? {
        guard let q = url.firstIndex(of: 0x3F) else { return [] } // ?
        let hash = url[(q + 1)...].firstIndex(of: 0x23) ?? url.count // #
        let query = Array(url[(q + 1)..<hash])
        var params: [(key: [UInt16], value: [UInt16])] = []
        for part in query.split(separator: 0x26, omittingEmptySubsequences: true) { // &
            let eq = part.firstIndex(of: 0x3D) // =
            let rawKey = eq.map { Array(part[part.startIndex..<$0]) } ?? Array(part)
            let rawValue = eq.map { Array(part[($0 + 1)...]) } ?? []
            guard let key = decodeURIComponent(rawKey.map { $0 == 0x2B ? 0x20 : $0 }),
                  let value = decodeURIComponent(rawValue.map { $0 == 0x2B ? 0x20 : $0 })
            else { return nil }
            if !params.contains(where: { $0.key == key }) { params.append((key, value)) }
        }
        return params
    }

    private static func hexValue(_ c: UInt16) -> Int? {
        switch c {
        case 0x30...0x39: return Int(c - 0x30)
        case 0x41...0x46: return Int(c - 0x41 + 10)
        case 0x61...0x66: return Int(c - 0x61 + 10)
        default: return nil
        }
    }

    /// JavaScript's `decodeURIComponent`: `%XX` runs decoded as strict UTF-8; nil where it would throw.
    static func decodeURIComponent(_ s: [UInt16]) -> [UInt16]? {
        guard s.contains(0x25) else { return s }
        var out: [UInt16] = []
        out.reserveCapacity(s.count)
        var i = 0
        let n = s.count
        while i < n {
            if s[i] != 0x25 {
                out.append(s[i])
                i += 1
                continue
            }
            var bytes: [UInt8] = []
            while i < n && s[i] == 0x25 {
                guard i + 2 < n, let hi = hexValue(s[i + 1]), let lo = hexValue(s[i + 2]) else { return nil }
                bytes.append(UInt8(hi * 16 + lo))
                i += 3
            }
            guard let decoded = StrictUTF8.decode(bytes[...]) else { return nil }
            out.append(contentsOf: decoded)
        }
        return out
    }
}

/// Strict UTF-8 (no overlong forms, no encoded surrogates, nothing above U+10FFFF), producing UTF-16 units.
enum StrictUTF8 {
    static func decode<C: Collection>(_ bytes: C) -> [UInt16]? where C.Element == UInt8, C.Index == Int {
        var out: [UInt16] = []
        out.reserveCapacity(bytes.count)
        var i = bytes.startIndex
        let end = bytes.endIndex
        while i < end {
            let b0 = UInt32(bytes[i])
            if b0 < 0x80 {
                out.append(UInt16(b0))
                i += 1
                continue
            }
            var need = 0
            var lower: UInt32 = 0x80
            var upper: UInt32 = 0xBF
            var cp: UInt32
            switch b0 {
            case 0xC2...0xDF:
                need = 1
                cp = b0 & 0x1F
            case 0xE0...0xEF:
                need = 2
                cp = b0 & 0x0F
                if b0 == 0xE0 { lower = 0xA0 }
                if b0 == 0xED { upper = 0x9F }
            case 0xF0...0xF4:
                need = 3
                cp = b0 & 0x07
                if b0 == 0xF0 { lower = 0x90 }
                if b0 == 0xF4 { upper = 0x8F }
            default:
                return nil
            }
            if i + need >= end { return nil }
            for k in 1...need {
                let b = UInt32(bytes[i + k])
                if b < lower || b > upper { return nil }
                lower = 0x80
                upper = 0xBF
                cp = (cp << 6) | (b & 0x3F)
            }
            if cp >= 0x10000 {
                let v = cp - 0x10000
                out.append(UInt16(0xD800 + (v >> 10)))
                out.append(UInt16(0xDC00 + (v & 0x3FF)))
            } else {
                out.append(UInt16(cp))
            }
            i += need + 1
        }
        return out
    }

    /// The body text a matcher may read: well-formed UTF-8 (one leading BOM dropped, as `TextDecoder` does).
    static func bodyText(_ data: Data) -> [UInt16]? {
        let bytes = [UInt8](data)
        if bytes.count >= 3 && bytes[0] == 0xEF && bytes[1] == 0xBB && bytes[2] == 0xBF {
            return decode(bytes[3...])
        }
        return decode(bytes[...])
    }
}

/// Strict JSON reading for GraphQL payloads (RFC 8259 as `JSON.parse` accepts it: no comments, single quotes,
/// trailing commas, leading zeros or raw control characters; lone surrogate escapes allowed; any nesting depth,
/// without recursion). Only the `query` and `operationName` members of the payload objects (the top-level object, or
/// the objects directly inside a top-level array) are kept; the last duplicate key wins, like `JSON.parse`.
enum StrictJSON {
    /// A payload's members: a string value, or nil (absent, or a value that is not a string).
    final class Payload {
        var query: [UInt16]?
        var operationName: [UInt16]?
    }

    private final class Frame {
        let isObject: Bool
        let isTopArray: Bool
        let payload: Payload?
        /// The member of `payload` the current value goes to: 1 = query, 2 = operationName, 0 = none.
        var member = 0

        init(isObject: Bool, isTopArray: Bool, payload: Payload?) {
            self.isObject = isObject
            self.isTopArray = isTopArray
            self.payload = payload
        }
    }

    private struct Invalid: Error {}

    private static let queryKey = Array("query".utf16)
    private static let operationNameKey = Array("operationName".utf16)

    /// The payloads of a JSON document whose top-level value is an object or array; nil when it is not valid JSON.
    static func payloads(_ text: [UInt16]) -> [Payload]? {
        var reader = Reader(s: text)
        return try? reader.read()
    }

    private struct Reader {
        let s: [UInt16]
        var pos = 0
        var stack: [Frame] = []
        var payloads: [Payload] = []

        init(s: [UInt16]) {
            self.s = s
        }

        mutating func read() throws -> [Payload] {
            let n = s.count
            var expectValue = true
            while true {
                if expectValue {
                    expectValue = false
                    if try openValue() {
                        expectValue = true
                        continue
                    }
                }
                // A value just ended: continue or close the enclosing container.
                guard let top = stack.last else { break }
                skipWs()
                guard pos < n else { throw Invalid() }
                let c = s[pos]
                pos += 1
                if top.isObject {
                    if c == 0x2C { // ,
                        try readKey(top)
                        expectValue = true
                    } else if c == 0x7D { // }
                        close()
                    } else {
                        throw Invalid()
                    }
                } else {
                    if c == 0x2C {
                        expectValue = true
                    } else if c == 0x5D { // ]
                        close()
                    } else {
                        throw Invalid()
                    }
                }
            }
            skipWs()
            guard pos == n else { throw Invalid() }
            return payloads
        }

        private mutating func close() {
            let frame = stack.removeLast()
            if let payload = frame.payload { payloads.append(payload) }
        }

        private mutating func skipWs() {
            while pos < s.count {
                let c = s[pos]
                if c == 0x20 || c == 0x09 || c == 0x0A || c == 0x0D { pos += 1 } else { break }
            }
        }

        /// Sets the current member of the enclosing payload object (if any) to `value`.
        private func assign(_ value: [UInt16]?) {
            guard let top = stack.last, let payload = top.payload else { return }
            switch top.member {
            case 1: payload.query = value
            case 2: payload.operationName = value
            default: break
            }
        }

        private mutating func readKey(_ frame: Frame) throws {
            skipWs()
            guard pos < s.count, s[pos] == 0x22 else { throw Invalid() }
            let key = try readString(decode: frame.payload != nil)
            frame.member = key == StrictJSON.queryKey ? 1 : key == StrictJSON.operationNameKey ? 2 : 0
            skipWs()
            guard pos < s.count, s[pos] == 0x3A else { throw Invalid() } // :
            pos += 1
        }

        /// Reads one value. A container is opened (pushed); returns true when its first member is due next (no
        /// recursion: nesting depth costs heap, not stack). Scalars and empty containers are read whole.
        private mutating func openValue() throws -> Bool {
            skipWs()
            guard pos < s.count else { throw Invalid() }
            let c = s[pos]
            switch c {
            case 0x7B, 0x5B: // { [
                assign(nil)
                pos += 1
                let isObject = c == 0x7B
                let isPayload = isObject && (stack.isEmpty || (stack.count == 1 && stack[0].isTopArray))
                let frame = Frame(isObject: isObject, isTopArray: !isObject && stack.isEmpty, payload: isPayload ? Payload() : nil)
                stack.append(frame)
                skipWs()
                if pos < s.count && s[pos] == (isObject ? 0x7D : 0x5D) {
                    pos += 1
                    close()
                    return false
                }
                if isObject { try readKey(frame) }
                return true
            case 0x22:
                let wanted = stack.last.map { $0.payload != nil && $0.member != 0 } ?? false
                let value = try readString(decode: wanted)
                assign(wanted ? value : nil)
            case 0x74: try literal("true")
            case 0x66: try literal("false")
            case 0x6E: try literal("null")
            case 0x2D, 0x30...0x39:
                try number()
                assign(nil)
            default:
                throw Invalid()
            }
            return false
        }

        private mutating func literal(_ word: String) throws {
            let units = Array(word.utf16)
            guard pos + units.count <= s.count, Array(s[pos..<(pos + units.count)]) == units else { throw Invalid() }
            pos += units.count
            assign(nil)
        }

        private mutating func digits() -> Int {
            let start = pos
            while pos < s.count && s[pos] >= 0x30 && s[pos] <= 0x39 { pos += 1 }
            return pos - start
        }

        private mutating func number() throws {
            if s[pos] == 0x2D { pos += 1 }
            guard pos < s.count else { throw Invalid() }
            if s[pos] == 0x30 {
                pos += 1
            } else if s[pos] >= 0x31 && s[pos] <= 0x39 {
                _ = digits()
            } else {
                throw Invalid()
            }
            if pos < s.count && s[pos] == 0x2E { // .
                pos += 1
                if digits() == 0 { throw Invalid() }
            }
            if pos < s.count && (s[pos] == 0x65 || s[pos] == 0x45) { // e E
                pos += 1
                if pos < s.count && (s[pos] == 0x2B || s[pos] == 0x2D) { pos += 1 }
                if digits() == 0 { throw Invalid() }
            }
        }

        /// Reads a string starting at the opening quote; decodes it only when `decode` (else returns []).
        private mutating func readString(decode: Bool) throws -> [UInt16] {
            pos += 1
            var out: [UInt16] = []
            let n = s.count
            while true {
                guard pos < n else { throw Invalid() }
                let c = s[pos]
                if c == 0x22 {
                    pos += 1
                    return out
                } else if c == 0x5C {
                    guard pos + 1 < n else { throw Invalid() }
                    let e = s[pos + 1]
                    var unit: UInt16
                    switch e {
                    case 0x22, 0x5C, 0x2F: unit = e
                    case 0x62: unit = 0x08
                    case 0x66: unit = 0x0C
                    case 0x6E: unit = 0x0A
                    case 0x72: unit = 0x0D
                    case 0x74: unit = 0x09
                    case 0x75:
                        guard pos + 5 < n else { throw Invalid() }
                        var code = 0
                        for k in 2...5 {
                            guard let v = GraphqlMatchingHex.value(s[pos + k]) else { throw Invalid() }
                            code = code * 16 + v
                        }
                        unit = UInt16(code)
                        pos += 4
                    default:
                        throw Invalid()
                    }
                    if decode { out.append(unit) }
                    pos += 2
                } else if c < 0x20 {
                    throw Invalid()
                } else {
                    if decode { out.append(c) }
                    pos += 1
                }
            }
        }
    }
}

private enum GraphqlMatchingHex {
    static func value(_ c: UInt16) -> Int? {
        switch c {
        case 0x30...0x39: return Int(c - 0x30)
        case 0x41...0x46: return Int(c - 0x41 + 10)
        case 0x61...0x66: return Int(c - 0x61 + 10)
        default: return nil
        }
    }
}
