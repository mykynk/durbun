import CoreGraphics
import Foundation

/// Best-effort conversion of arbitrary user values (`data:` of a log, event props, command results)
/// into JSON. Never throws and never traps: unknown values fall back to their description.
enum JSONConversion {
    static let maxDepth = 12
    static let maxElements = 1000

    private static let iso8601: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let isoLock = UnfairLock()

    static func value(from any: Any?) -> JSONValue {
        convert(any, depth: 0)
    }

    /// Converts `props`-like dictionaries, keeping a stable (sorted) key order.
    static func object(from dictionary: [String: Any]) -> JSONValue {
        convert(dictionary, depth: 0)
    }

    private static func convert(_ input: Any?, depth: Int) -> JSONValue {
        guard let any = unwrapOptional(input) else { return .null }
        if depth > maxDepth { return .string("…") }

        if let value = any as? JSONValue { return value }

        let type = Swift.type(of: any)
        // Exact Swift scalar types first: `as? Bool` / `as? Int` would also succeed on NSNumber.
        if type == Bool.self { return .bool(any as! Bool) }
        if type == Int.self { return .int(Int64(any as! Int)) }
        if type == Int8.self { return .int(Int64(any as! Int8)) }
        if type == Int16.self { return .int(Int64(any as! Int16)) }
        if type == Int32.self { return .int(Int64(any as! Int32)) }
        if type == Int64.self { return .int(any as! Int64) }
        if type == UInt.self { return number(UInt64(any as! UInt)) }
        if type == UInt8.self { return .int(Int64(any as! UInt8)) }
        if type == UInt16.self { return .int(Int64(any as! UInt16)) }
        if type == UInt32.self { return .int(Int64(any as! UInt32)) }
        if type == UInt64.self { return number(any as! UInt64) }
        if type == Double.self { return .double(any as! Double) }
        if type == Float.self { return .double(Double(any as! Float)) }
        if type == CGFloat.self { return .double(Double(any as! CGFloat)) }
        if type == Decimal.self { return .double(NSDecimalNumber(decimal: any as! Decimal).doubleValue) }
        if let string = any as? String { return .string(string) }
        if let substring = any as? Substring { return .string(String(substring)) }
        if let character = any as? Character { return .string(String(character)) }

        if any is NSNull { return .null }
        if let number = any as? NSNumber, type is NSNumber.Type { return convert(number: number) }
        if let date = any as? Date { return .string(isoLock.withLock { iso8601.string(from: date) }) }
        if let url = any as? URL { return .string(url.absoluteString) }
        if let uuid = any as? UUID { return .string(uuid.uuidString) }
        if let data = any as? Data { return .string("<\(data.count) bytes>") }
        if let error = any as? Error { return errorObject(error) }

        if let dictionary = any as? [String: Any] { return object(dictionary.map { ($0.key, $0.value) }, depth: depth) }
        if let dictionary = any as? [AnyHashable: Any] {
            return object(dictionary.map { (String(describing: $0.key.base), $0.value) }, depth: depth)
        }
        if let array = any as? [Any] { return .array(array.prefix(maxElements).map { convert($0, depth: depth + 1) }) }
        if let set = any as? Set<AnyHashable> {
            return .array(set.prefix(maxElements).map { convert($0.base, depth: depth + 1) })
        }

        if let encodable = any as? Encodable, let encoded = encodeJSON(encodable) {
            return convert(encoded, depth: depth + 1)
        }

        return reflect(any, depth: depth)
    }

    private static func object(_ pairs: [(String, Any)], depth: Int) -> JSONValue {
        let sorted = pairs.sorted { $0.0 < $1.0 }.prefix(maxElements)
        return .object(sorted.map { ($0.0, convert($0.1, depth: depth + 1)) })
    }

    private static func number(_ value: UInt64) -> JSONValue {
        value <= UInt64(Int64.max) ? .int(Int64(value)) : .double(Double(value))
    }

    private static func convert(number: NSNumber) -> JSONValue {
        if CFGetTypeID(number) == CFBooleanGetTypeID() { return .bool(number.boolValue) }
        if CFNumberIsFloatType(number) { return .double(number.doubleValue) }
        let objCType = String(cString: number.objCType)
        if objCType == "Q" || objCType == "L" { return self.number(number.uint64Value) }
        return .int(number.int64Value)
    }

    /// Short type label: the Swift type (`MyApp.APIError`) or, for Cocoa errors (which reach us
    /// bridged as NSError), the domain and code (`NSURLErrorDomain -1009`).
    static func typeName(of error: Error) -> String {
        let ns = error as NSError
        if Swift.type(of: error) is NSError.Type || error is URLError || error is CocoaError {
            return "\(ns.domain) \(ns.code)"
        }
        return String(reflecting: Swift.type(of: error))
    }

    static func errorObject(_ error: Error) -> JSONValue {
        let ns = error as NSError
        var builder = JSONObjectBuilder()
        builder.set("type", typeName(of: error))
        builder.set("message", describe(error))
        builder.set("domain", ns.domain)
        builder.set("code", ns.code)
        return builder.value
    }

    /// Readable one-line description of any Error: `LocalizedError` text, Cocoa error text, or the
    /// qualified Swift value (`MyApp.APIError.unauthorized`) instead of the unhelpful
    /// "The operation couldn’t be completed." of bridged Swift errors.
    static func describe(_ error: Error) -> String {
        if let localized = error as? LocalizedError, let description = localized.errorDescription {
            return description
        }
        let ns = error as NSError
        if Swift.type(of: error) is NSError.Type || error is URLError || error is CocoaError
            || ns.userInfo[NSLocalizedDescriptionKey] != nil
        {
            return ns.localizedDescription
        }
        return String(reflecting: error)
    }

    /// `Any` can hide an `Optional` (e.g. `["a": maybeNil as Any]`); a protocol cast finds it
    /// without the cost of a Mirror per value.
    private static func unwrapOptional(_ value: Any?) -> Any? {
        guard let value else { return nil }
        if let optional = value as? AnyOptional { return unwrapOptional(optional.wrappedAny) }
        return value
    }

    private static func encodeJSON(_ value: Encodable) -> Any? {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        guard let data = try? encoder.encode(AnyEncodable(value)) else { return nil }
        return try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])
    }

    private static func reflect(_ value: Any, depth: Int) -> JSONValue {
        let mirror = Mirror(reflecting: value)
        switch mirror.displayStyle {
        case .struct?, .class?:
            var entries: [(String, JSONValue)] = []
            for (index, child) in mirror.children.prefix(maxElements).enumerated() {
                entries.append((child.label ?? "_\(index)", convert(child.value, depth: depth + 1)))
            }
            if entries.isEmpty { return .string(String(describing: value)) }
            return .object(entries)
        case .tuple?:
            let children = Array(mirror.children.prefix(maxElements))
            if children.allSatisfy({ $0.label?.hasPrefix(".") ?? true }) {
                return .array(children.map { convert($0.value, depth: depth + 1) })
            }
            return .object(children.enumerated().map { ($0.element.label ?? "_\($0.offset)", convert($0.element.value, depth: depth + 1)) })
        case .collection?, .set?:
            return .array(mirror.children.prefix(maxElements).map { convert($0.value, depth: depth + 1) })
        case .dictionary?:
            var entries: [(String, JSONValue)] = []
            for child in mirror.children.prefix(maxElements) {
                let pair = Array(Mirror(reflecting: child.value).children)
                if pair.count == 2 {
                    entries.append((String(describing: pair[0].value), convert(pair[1].value, depth: depth + 1)))
                }
            }
            return .object(entries.sorted { $0.0 < $1.0 })
        default:
            return .string(String(describing: value))
        }
    }
}

private protocol AnyOptional {
    var wrappedAny: Any? { get }
}

extension Optional: AnyOptional {
    var wrappedAny: Any? { map { $0 as Any } }
}

/// Type-erasing wrapper so an existential `Encodable` can be handed to `JSONEncoder`.
private struct AnyEncodable: Encodable {
    let value: Encodable

    init(_ value: Encodable) {
        self.value = value
    }

    func encode(to encoder: Encoder) throws {
        try value.encode(to: encoder)
    }
}
