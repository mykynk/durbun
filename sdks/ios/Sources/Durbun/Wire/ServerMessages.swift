import Foundation

/// `SdkConfig` pushed by the desktop in `welcome` / `config`.
struct SdkConfig: Equatable {
    var captureBodies: Bool = true
    var maxBodyBytes: Int = 1_048_576
    var metricsIntervalMs: Int = 1000
    var deviceLogsAvailable: Bool = false

    static let defaults = SdkConfig()

    /// Missing or malformed fields keep the value from `fallback`.
    init(json: [String: Any], fallback: SdkConfig = .defaults) {
        captureBodies = JSONRead.bool(json["captureBodies"]) ?? fallback.captureBodies
        maxBodyBytes = max(0, JSONRead.int(json["maxBodyBytes"]) ?? fallback.maxBodyBytes)
        metricsIntervalMs = max(100, JSONRead.int(json["metricsIntervalMs"]) ?? fallback.metricsIntervalMs)
        deviceLogsAvailable = JSONRead.bool(json["deviceLogsAvailable"]) ?? fallback.deviceLogsAvailable
    }

    init() {}
}

/// `ServerWelcome`.
struct ServerWelcome {
    var protocolVersion: Int
    var server: String
    var appId: String
    var config: SdkConfig
    var mocks: [MockRule]
}

/// Every `ServerToSdk` message the SDK understands.
enum ServerMessage {
    case welcome(ServerWelcome)
    case mocks([MockRule])
    case config(SdkConfig)
    case command(id: String, name: String, params: [String: Any])
    case ping(ts: Double)

    /// Parses one NDJSON line; returns nil for invalid JSON or unknown/malformed messages
    /// (the protocol says those are ignored).
    static func parse(_ line: Data) -> ServerMessage? {
        guard let object = (try? JSONSerialization.jsonObject(with: line, options: [])) as? [String: Any],
              let type = object["type"] as? String
        else { return nil }
        switch type {
        case "welcome":
            let config = (object["config"] as? [String: Any]).map { SdkConfig(json: $0) } ?? .defaults
            return .welcome(ServerWelcome(
                protocolVersion: JSONRead.int(object["protocol"]) ?? 0,
                server: object["server"] as? String ?? "",
                appId: object["appId"] as? String ?? "",
                config: config,
                mocks: MockRule.parseList(object["mocks"])
            ))
        case "mocks":
            return .mocks(MockRule.parseList(object["rules"]))
        case "config":
            guard let config = object["config"] as? [String: Any] else { return nil }
            return .config(SdkConfig(json: config))
        case "command":
            guard let id = object["id"] as? String, let name = object["name"] as? String else { return nil }
            return .command(id: id, name: name, params: object["params"] as? [String: Any] ?? [:])
        case "ping":
            return .ping(ts: JSONRead.double(object["ts"]) ?? 0)
        default:
            return nil
        }
    }
}

/// Lenient readers for `JSONSerialization` output (numbers arrive as NSNumber).
enum JSONRead {
    static func bool(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber else { return nil }
        return number.boolValue
    }

    static func int(_ value: Any?) -> Int? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        guard double.isFinite, abs(double) < 9.0e15 else { return nil }
        return Int(double.rounded(.towardZero))
    }

    static func double(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let double = number.doubleValue
        return double.isFinite ? double : nil
    }

    /// `Header[]` → pairs; malformed entries are skipped.
    static func headers(_ value: Any?) -> [(String, String)] {
        guard let list = value as? [Any] else { return [] }
        return list.compactMap { entry in
            guard let pair = entry as? [Any], pair.count == 2,
                  let name = pair[0] as? String, let value = pair[1] as? String
            else { return nil }
            return (name, value)
        }
    }
}
