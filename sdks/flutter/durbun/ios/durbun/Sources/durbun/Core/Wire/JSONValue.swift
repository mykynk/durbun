import Foundation

/// A JSON tree with ordered object keys, so wire messages serialize deterministically and in the
/// field order of the protocol file.
enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int64)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([(String, JSONValue)])

    static func == (lhs: JSONValue, rhs: JSONValue) -> Bool {
        switch (lhs, rhs) {
        case (.null, .null): return true
        case let (.bool(a), .bool(b)): return a == b
        case let (.int(a), .int(b)): return a == b
        case let (.double(a), .double(b)): return a == b || (a.isNaN && b.isNaN)
        case let (.int(a), .double(b)), let (.double(b), .int(a)): return Double(a) == b
        case let (.string(a), .string(b)): return a == b
        case let (.array(a), .array(b)): return a == b
        case let (.object(a), .object(b)):
            return a.count == b.count && zip(a, b).allSatisfy { $0.0 == $1.0 && $0.1 == $1.1 }
        default: return false
        }
    }

    /// Value of `key` when this is an object.
    subscript(key: String) -> JSONValue? {
        guard case let .object(entries) = self else { return nil }
        return entries.first(where: { $0.0 == key })?.1
    }

    var stringValue: String? {
        if case let .string(s) = self { return s }
        return nil
    }

    var doubleValue: Double? {
        switch self {
        case let .double(d): return d
        case let .int(i): return Double(i)
        default: return nil
        }
    }

    var boolValue: Bool? {
        if case let .bool(b) = self { return b }
        return nil
    }

    var arrayValue: [JSONValue]? {
        if case let .array(a) = self { return a }
        return nil
    }

    var objectKeys: [String] {
        guard case let .object(entries) = self else { return [] }
        return entries.map { $0.0 }
    }
}

extension JSONValue: ExpressibleByStringLiteral, ExpressibleByIntegerLiteral, ExpressibleByFloatLiteral,
    ExpressibleByBooleanLiteral, ExpressibleByArrayLiteral, ExpressibleByNilLiteral
{
    init(stringLiteral value: String) { self = .string(value) }
    init(integerLiteral value: Int64) { self = .int(value) }
    init(floatLiteral value: Double) { self = .double(value) }
    init(booleanLiteral value: Bool) { self = .bool(value) }
    init(arrayLiteral elements: JSONValue...) { self = .array(elements) }
    init(nilLiteral: ()) { self = .null }
}

/// Builder for ordered JSON objects; `nil` values are omitted (optional protocol fields).
struct JSONObjectBuilder {
    private(set) var entries: [(String, JSONValue)] = []

    mutating func set(_ key: String, _ value: JSONValue?) {
        guard let value else { return }
        entries.append((key, value))
    }

    mutating func set(_ key: String, _ value: String?) {
        set(key, value.map(JSONValue.string))
    }

    mutating func set(_ key: String, _ value: Double?) {
        set(key, value.map(JSONValue.double))
    }

    mutating func set(_ key: String, _ value: Int?) {
        set(key, value.map { JSONValue.int(Int64($0)) })
    }

    mutating func set(_ key: String, _ value: Bool?) {
        set(key, value.map(JSONValue.bool))
    }

    var value: JSONValue { .object(entries) }
}

/// Fast UTF-8 JSON serializer (no Foundation round trip). Non-finite numbers become `null`.
enum JSONWriter {
    /// One NDJSON line (`<json>\n`).
    static func line(_ value: JSONValue) -> Data {
        var out: [UInt8] = []
        out.reserveCapacity(256)
        write(value, into: &out)
        out.append(0x0A)
        return Data(out)
    }

    static func string(_ value: JSONValue) -> String {
        var out: [UInt8] = []
        write(value, into: &out)
        return String(decoding: out, as: UTF8.self)
    }

    static func write(_ value: JSONValue, into out: inout [UInt8]) {
        switch value {
        case .null:
            out.append(contentsOf: [0x6E, 0x75, 0x6C, 0x6C]) // null
        case let .bool(b):
            out.append(contentsOf: b ? Array("true".utf8) : Array("false".utf8))
        case let .int(i):
            out.append(contentsOf: String(i).utf8)
        case let .double(d):
            writeNumber(d, into: &out)
        case let .string(s):
            writeString(s, into: &out)
        case let .array(items):
            out.append(0x5B) // [
            for (index, item) in items.enumerated() {
                if index > 0 { out.append(0x2C) }
                write(item, into: &out)
            }
            out.append(0x5D)
        case let .object(entries):
            out.append(0x7B) // {
            for (index, entry) in entries.enumerated() {
                if index > 0 { out.append(0x2C) }
                writeString(entry.0, into: &out)
                out.append(0x3A)
                write(entry.1, into: &out)
            }
            out.append(0x7D)
        }
    }

    static func writeNumber(_ d: Double, into out: inout [UInt8]) {
        guard d.isFinite else {
            out.append(contentsOf: Array("null".utf8))
            return
        }
        if d == d.rounded(.towardZero), abs(d) < 9_007_199_254_740_992 {
            out.append(contentsOf: String(Int64(d)).utf8)
        } else {
            // Swift's shortest round-trip form ("0.1", "1730540000123.456", "1e-07") is valid JSON.
            out.append(contentsOf: d.description.utf8)
        }
    }

    private static let hex: [UInt8] = Array("0123456789abcdef".utf8)

    static func writeString(_ s: String, into out: inout [UInt8]) {
        out.append(0x22)
        var copy = s
        copy.withUTF8 { bytes in
            let count = bytes.count
            var runStart = 0
            var i = 0
            while i < count {
                let b = bytes[i]
                var escape: [UInt8]?
                var consumed = 1
                switch b {
                case 0x22: escape = [0x5C, 0x22]
                case 0x5C: escape = [0x5C, 0x5C]
                case 0x0A: escape = [0x5C, 0x6E]
                case 0x0D: escape = [0x5C, 0x72]
                case 0x09: escape = [0x5C, 0x74]
                case 0x08: escape = [0x5C, 0x62]
                case 0x0C: escape = [0x5C, 0x66]
                case 0x00..<0x20:
                    escape = [0x5C, 0x75, 0x30, 0x30, hex[Int(b >> 4)], hex[Int(b & 0xF)]]
                case 0xE2 where i + 2 < count && bytes[i + 1] == 0x80 && (bytes[i + 2] == 0xA8 || bytes[i + 2] == 0xA9):
                    // U+2028 / U+2029: legal JSON but line terminators for older JS parsers.
                    escape = Array((bytes[i + 2] == 0xA8 ? "\\u2028" : "\\u2029").utf8)
                    consumed = 3
                default:
                    break
                }
                if let escape {
                    if runStart < i { out.append(contentsOf: UnsafeBufferPointer(rebasing: bytes[runStart..<i])) }
                    out.append(contentsOf: escape)
                    i += consumed
                    runStart = i
                } else {
                    i += 1
                }
            }
            if runStart < count { out.append(contentsOf: UnsafeBufferPointer(rebasing: bytes[runStart..<count])) }
        }
        out.append(0x22)
    }
}
