import Foundation

// Swift mirror of the SDK → server half of `packages/protocol/src/index.ts`. Field names and value
// spellings must stay byte-identical to the protocol file.

enum Wire {
    static let protocolVersion = 1
    static let sdkName = "durbun-ios"
    static let networkSource = "urlsession"
    static let capabilities = ["logs", "network", "mocks", "metrics", "events", "crash", "commands"]
}

/// `WireBody`: `size` is the full decoded size even when `data` was truncated.
struct WireBody: Equatable {
    enum Encoding: String { case utf8, base64 }
    var encoding: Encoding
    var data: String
    var size: Int
    var truncated: Bool

    var json: JSONValue {
        var b = JSONObjectBuilder()
        b.set("encoding", encoding.rawValue)
        b.set("data", data)
        b.set("size", size)
        if truncated { b.set("truncated", true) }
        return b.value
    }
}

/// `Timings` (milliseconds; unknown phases omitted).
struct WireTimings: Equatable {
    var dns: Double?
    var connect: Double?
    var tls: Double?
    var send: Double?
    var wait: Double?
    var receive: Double?

    var isEmpty: Bool { [dns, connect, tls, send, wait, receive].allSatisfy { $0 == nil } }

    var json: JSONValue {
        var b = JSONObjectBuilder()
        b.set("dns", dns)
        b.set("connect", connect)
        b.set("tls", tls)
        b.set("send", send)
        b.set("wait", wait)
        b.set("receive", receive)
        return b.value
    }
}

/// `ErrorInfo`.
struct WireErrorInfo: Equatable {
    var type: String?
    var message: String?
    var stack: String?

    var json: JSONValue {
        var b = JSONObjectBuilder()
        b.set("type", type)
        b.set("message", message)
        b.set("stack", stack)
        return b.value
    }
}

/// `AppInfo`.
struct WireAppInfo: Equatable {
    var name: String
    var id: String
    var version: String?
    var build: String?
    var pid: Int?
    var processName: String?
    var debug: Bool?

    var json: JSONValue {
        var b = JSONObjectBuilder()
        b.set("name", name)
        b.set("id", id)
        b.set("version", version)
        b.set("build", build)
        b.set("pid", pid)
        b.set("processName", processName)
        b.set("debug", debug)
        return b.value
    }
}

/// `DeviceHints`.
struct WireDeviceHints: Equatable {
    /// 'android' | 'ios' | 'other'
    var platform: String
    var model: String?
    var manufacturer: String?
    var name: String?
    var osVersion: String?
    var isPhysical: Bool?
    var simulatorUdid: String?

    var json: JSONValue {
        var b = JSONObjectBuilder()
        b.set("platform", platform)
        b.set("model", model)
        b.set("manufacturer", manufacturer)
        b.set("name", name)
        b.set("osVersion", osVersion)
        b.set("isPhysical", isPhysical)
        b.set("simulatorUdid", simulatorUdid)
        return b.value
    }
}

/// `AppActionDescriptor`.
struct WireActionDescriptor: Equatable {
    var id: String
    /// 'toggle' | 'select' | 'button'
    var kind: String
    var label: String
    var labelKey: String?
    var group: String?
    var options: [(value: String, label: String)]?
    var value: JSONValue?

    static func == (lhs: WireActionDescriptor, rhs: WireActionDescriptor) -> Bool {
        lhs.json == rhs.json
    }

    var json: JSONValue {
        var b = JSONObjectBuilder()
        b.set("id", id)
        b.set("kind", kind)
        b.set("label", label)
        b.set("labelKey", labelKey)
        b.set("group", group)
        if let options {
            b.set("options", .array(options.map { option in
                var o = JSONObjectBuilder()
                o.set("value", option.value)
                o.set("label", option.label)
                return o.value
            }))
        }
        b.set("value", value)
        return b.value
    }
}

/// `SdkMetric` payload.
struct WireMetricSample: Equatable {
    var ts: Double
    var cpu: Double?
    var memoryMB: Double?
    var heapMB: Double?
    var fps: Double?
    var jankyFrames: Int?
    var frameBuildMs: Double?
    var frameRasterMs: Double?
    var threads: Int?
}

/// Builders for every `SdkToServer` message.
enum WireMessage {
    static func hello(
        app: WireAppInfo,
        device: WireDeviceHints,
        session: String,
        capabilities: [String] = Wire.capabilities,
        actions: [WireActionDescriptor],
        sdkVersion: String,
        ts: Double
    ) -> JSONValue {
        var sdk = JSONObjectBuilder()
        sdk.set("name", Wire.sdkName)
        sdk.set("version", sdkVersion)
        sdk.set("platform", "ios")
        var b = JSONObjectBuilder()
        b.set("type", "hello")
        b.set("protocol", Wire.protocolVersion)
        b.set("sdk", sdk.value)
        b.set("app", app.json)
        b.set("device", device.json)
        b.set("session", session)
        b.set("capabilities", .array(capabilities.map(JSONValue.string)))
        b.set("actions", .array(actions.map(\.json)))
        b.set("ts", ts)
        return b.value
    }

    /// `kind`: 'text' | 'crash' | 'flutter-error' (nil = text).
    static func log(
        ts: Double,
        level: DurbunLogLevel,
        tag: String?,
        message: String,
        data: JSONValue? = nil,
        error: WireErrorInfo? = nil,
        kind: String? = nil,
        tid: Int? = nil
    ) -> JSONValue {
        var b = JSONObjectBuilder()
        b.set("type", "log")
        b.set("ts", ts)
        b.set("level", level.rawValue)
        b.set("tag", tag)
        b.set("message", message)
        b.set("data", data)
        b.set("error", error?.json)
        b.set("kind", kind)
        b.set("tid", tid)
        return b.value
    }

    static func netRequest(
        id: String,
        ts: Double,
        method: String,
        url: String,
        headers: [(String, String)],
        body: WireBody?,
        source: String = Wire.networkSource
    ) -> JSONValue {
        var b = JSONObjectBuilder()
        b.set("type", "net.request")
        b.set("id", id)
        b.set("ts", ts)
        b.set("method", method)
        b.set("url", url)
        b.set("headers", headersJSON(headers))
        b.set("body", body?.json)
        b.set("source", source)
        return b.value
    }

    static func netResponse(
        id: String,
        ts: Double,
        status: Int,
        statusText: String?,
        headers: [(String, String)],
        body: WireBody?,
        protocolName: String? = nil,
        remoteAddress: String? = nil,
        timings: WireTimings? = nil,
        mocked: Bool = false,
        mockRuleId: String? = nil
    ) -> JSONValue {
        var b = JSONObjectBuilder()
        b.set("type", "net.response")
        b.set("id", id)
        b.set("ts", ts)
        b.set("status", status)
        b.set("statusText", statusText)
        b.set("headers", headersJSON(headers))
        b.set("body", body?.json)
        b.set("protocol", protocolName)
        b.set("remoteAddress", remoteAddress)
        if let timings, !timings.isEmpty { b.set("timings", timings.json) }
        if mocked { b.set("mocked", true) }
        b.set("mockRuleId", mockRuleId)
        return b.value
    }

    static func netError(
        id: String,
        ts: Double,
        error: String,
        cancelled: Bool = false,
        mocked: Bool = false,
        mockRuleId: String? = nil
    ) -> JSONValue {
        var b = JSONObjectBuilder()
        b.set("type", "net.error")
        b.set("id", id)
        b.set("ts", ts)
        b.set("error", error)
        if cancelled { b.set("cancelled", true) }
        if mocked { b.set("mocked", true) }
        b.set("mockRuleId", mockRuleId)
        return b.value
    }

    static func event(ts: Double, name: String, props: JSONValue?) -> JSONValue {
        var b = JSONObjectBuilder()
        b.set("type", "event")
        b.set("ts", ts)
        b.set("name", name)
        b.set("props", props)
        return b.value
    }

    static func metric(_ sample: WireMetricSample) -> JSONValue {
        var b = JSONObjectBuilder()
        b.set("type", "metric")
        b.set("ts", sample.ts)
        b.set("cpu", sample.cpu)
        b.set("memoryMB", sample.memoryMB)
        b.set("heapMB", sample.heapMB)
        b.set("fps", sample.fps)
        b.set("jankyFrames", sample.jankyFrames)
        b.set("frameBuildMs", sample.frameBuildMs)
        b.set("frameRasterMs", sample.frameRasterMs)
        b.set("threads", sample.threads)
        return b.value
    }

    static func commandResult(id: String, ok: Bool, data: JSONValue?, error: String?) -> JSONValue {
        var b = JSONObjectBuilder()
        b.set("type", "command.result")
        b.set("id", id)
        b.set("ok", ok)
        b.set("data", data)
        b.set("error", error)
        return b.value
    }

    static func actions(_ actions: [WireActionDescriptor]) -> JSONValue {
        var b = JSONObjectBuilder()
        b.set("type", "actions")
        b.set("actions", .array(actions.map(\.json)))
        return b.value
    }

    static func pong(ts: Double) -> JSONValue {
        var b = JSONObjectBuilder()
        b.set("type", "pong")
        b.set("ts", ts)
        return b.value
    }

    /// `Header[]` = `[name, value][]`.
    static func headersJSON(_ headers: [(String, String)]) -> JSONValue {
        .array(headers.map { .array([.string($0.0), .string($0.1)]) })
    }
}
