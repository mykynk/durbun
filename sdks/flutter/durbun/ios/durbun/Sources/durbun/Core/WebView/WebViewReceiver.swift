import Foundation

/// Turns the messages of the web view bridge script (`WebViewBridgeScript`, source: `sdks/js/webview/bridge.ts`)
/// into the SDK's own `net.*` and `log` messages. One receiver per attached web view configuration.
///
/// Everything here comes from page content, which is untrusted: every field is type-checked and capped, the
/// message rate and size are limited, and requests in flight are bounded. What reaches the desktop is whatever the
/// page claims. `receive` is cheap to call from the main thread: the work runs on a serial background queue,
/// and messages beyond a bounded backlog are dropped.
final class WebViewReceiver: @unchecked Sendable {
    static let tag = "webview"
    static let sourceFetch = "webview:fetch"
    static let sourceXHR = "webview:xhr"
    static let sourceOther = "webview"

    /// Longest message taken from a page (a body at the script's 64 KB cap, base64-encoded, fits easily).
    static let maxMessageChars = 512 * 1024
    static let maxPending = 256
    static let maxHeaders = 100
    static let maxURLChars = 8 * 1024
    static let maxLogChars = 64 * 1024
    static let maxIdChars = 64
    static let burst = 400.0
    static let ratePerSecond = 150.0
    static let dropReportInterval: TimeInterval = 10
    static let maxBacklog = 512
    private static let maxClockSkewMs = 5 * 60_000.0
    private static let maxDurationMs = 24 * 3_600_000.0
    private static let maxClaimedSize = 1 << 40

    private struct Pending {
        let id: String
        let ts: Double
        let method: String
        let url: String
        let headers: [(String, String)]
        let source: String
    }

    private let core: DurbunCore
    private let nowMs: () -> Double
    private let monotonic: () -> TimeInterval
    private let queue = DispatchQueue(label: "dev.durbun.webview", qos: .utility)
    private let lock = NSLock()
    private var backlog = 0
    private var pending: [String: Pending] = [:]
    private var order: [String] = []
    private var tokens = WebViewReceiver.burst
    private var refilledAt: TimeInterval
    private var dropped = 0
    private var dropReportedAt: TimeInterval?

    init(
        core: DurbunCore = .shared,
        nowMs: @escaping () -> Double = { Clock.nowMs() },
        monotonic: @escaping () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    ) {
        self.core = core
        self.nowMs = nowMs
        self.monotonic = monotonic
        refilledAt = monotonic()
    }

    /// Hands one message to the background queue (any thread).
    func receive(_ body: Any) {
        guard let json = body as? String else { return }
        let accepted = lock.withLock { () -> Bool in
            guard backlog < Self.maxBacklog else { return false }
            backlog += 1
            return true
        }
        guard accepted else {
            noteDropped(1)
            return
        }
        queue.async { [self] in
            handle(json)
            lock.withLock { backlog -= 1 }
        }
    }

    /// Runs one message on the calling thread (tests, and the queue above).
    func handle(_ json: String) {
        guard core.isRunning else { return }
        guard json.utf16.count <= Self.maxMessageChars, takeToken() else {
            noteDropped(1)
            return
        }
        guard let data = json.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              JSONRead.int(message["v"]) == 1,
              let type = message["t"] as? String else { return }
        let network = core.networkPolicy.active
        switch type {
        case "req": if network { request(message) }
        case "reqbody": if network { requestBody(message) }
        case "res": if network { response(message) }
        case "err": if network { failure(message) }
        case "log": log(message)
        case "dropped":
            if let count = JSONRead.int(message["count"]), count > 0, count < 1_000_000_000 { noteDropped(count) }
        default: break
        }
    }

    // MARK: Messages

    private func request(_ message: [String: Any]) {
        guard let pageId = string(message["id"], Self.maxIdChars),
              let url = string(message["url"], Self.maxURLChars),
              let parsed = URL(string: url), let scheme = parsed.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = parsed.host else { return }
        if core.networkPolicy.ignores(host: host) { return }
        var method = "GET"
        if let claimed = string(message["method"], 16)?.uppercased(),
           claimed.range(of: "^[A-Z][A-Z0-9_-]{0,15}$", options: .regularExpression) != nil {
            method = claimed
        }
        let source: String
        switch message["api"] as? String {
        case "fetch": source = Self.sourceFetch
        case "xhr": source = Self.sourceXHR
        default: source = Self.sourceOther
        }
        let entry = Pending(
            id: core.nextWebViewRequestId(),
            ts: timestamp(message["ts"]),
            method: method,
            url: url,
            headers: headers(message["headers"]),
            source: source
        )
        lock.withLock {
            if pending.removeValue(forKey: pageId) != nil { order.removeAll { $0 == pageId } }
            pending[pageId] = entry
            order.append(pageId)
            if order.count > Self.maxPending { pending.removeValue(forKey: order.removeFirst()) }
        }
        core.send(WireMessage.netRequest(
            id: entry.id, ts: entry.ts, method: method, url: url, headers: entry.headers, body: body(message["body"]), source: source
        ))
    }

    /// A `Request` object's body, read by the page after the request was reported: the same entry again.
    private func requestBody(_ message: [String: Any]) {
        guard let pageId = string(message["id"], Self.maxIdChars),
              let entry = lock.withLock({ pending[pageId] }),
              let body = body(message["body"]) else { return }
        core.send(WireMessage.netRequest(
            id: entry.id, ts: entry.ts, method: entry.method, url: entry.url, headers: entry.headers, body: body, source: entry.source
        ))
    }

    private func response(_ message: [String: Any]) {
        guard let entry = take(message) else { return }
        let status = JSONRead.int(message["status"]).flatMap { (0...999).contains($0) ? $0 : nil } ?? 0
        let timings = WireTimings(wait: duration(message["wait"]), receive: duration(message["receive"]))
        core.send(WireMessage.netResponse(
            id: entry.id,
            ts: timestamp(message["ts"]),
            status: status,
            statusText: string(message["statusText"], 256),
            headers: headers(message["headers"]),
            body: body(message["body"]),
            timings: timings
        ))
    }

    private func failure(_ message: [String: Any]) {
        guard let entry = take(message) else { return }
        let text = string(message["error"], 1024).flatMap { $0.trimmingCharacters(in: .whitespaces).isEmpty ? nil : $0 } ?? "Error"
        core.send(WireMessage.netError(
            id: entry.id, ts: timestamp(message["ts"]), error: text, cancelled: isTrue(message["cancelled"])
        ))
    }

    private func take(_ message: [String: Any]) -> Pending? {
        guard let pageId = string(message["id"], Self.maxIdChars) else { return nil }
        return lock.withLock {
            guard let entry = pending.removeValue(forKey: pageId) else { return nil }
            order.removeAll { $0 == pageId }
            return entry
        }
    }

    private func log(_ message: [String: Any]) {
        guard let text = string(message["message"], Self.maxLogChars) else { return }
        let level: DurbunLogLevel
        switch message["level"] as? String {
        case "debug": level = .debug
        case "warn": level = .warning
        case "error": level = .error
        default: level = .info
        }
        var data: JSONValue?
        if let page = string(message["page"], 2048), !page.isEmpty {
            var b = JSONObjectBuilder()
            b.set("page", page)
            data = b.value
        }
        var error: WireErrorInfo?
        if let raw = message["error"] as? [String: Any] {
            let info = WireErrorInfo(
                type: string(raw["type"], 256),
                message: string(raw["message"], 4096),
                stack: string(raw["stack"], 32 * 1024)
            )
            if info.type != nil || info.message != nil || info.stack != nil { error = info }
        }
        core.send(WireMessage.log(ts: timestamp(message["ts"]), level: level, tag: Self.tag, message: text, data: data, error: error, kind: "text"))
    }

    // MARK: Limits

    private func takeToken() -> Bool {
        lock.withLock {
            let now = monotonic()
            tokens = min(Self.burst, tokens + (now - refilledAt) * Self.ratePerSecond)
            refilledAt = now
            guard tokens >= 1 else { return false }
            tokens -= 1
            return true
        }
    }

    /// Counts dropped messages; one warning line per `dropReportInterval` says how many.
    private func noteDropped(_ count: Int) {
        let report: Int? = lock.withLock {
            dropped += count
            let now = monotonic()
            if let last = dropReportedAt, now - last < Self.dropReportInterval { return nil }
            dropReportedAt = now
            defer { dropped = 0 }
            return dropped
        }
        guard let report, core.isRunning else { return }
        core.send(WireMessage.log(
            ts: nowMs(),
            level: .warning,
            tag: Self.tag,
            message: "Dürbün dropped \(report) message(s) from a web view: the page sent too many, or too large ones.",
            kind: "text"
        ))
    }

    // MARK: Field checks

    private func string(_ value: Any?, _ max: Int) -> String? {
        guard let text = value as? String else { return nil }
        guard text.utf16.count > max else { return text }
        // Never split a surrogate pair.
        return String(text.utf16.prefix(max)) ?? String(text.utf16.prefix(max - 1)) ?? ""
    }

    private func isTrue(_ value: Any?) -> Bool {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else { return false }
        return number.boolValue
    }

    /// The page's wall clock time when it is close to the device's (same clock), otherwise now.
    private func timestamp(_ value: Any?) -> Double {
        let now = nowMs()
        guard let ts = JSONRead.double(value), abs(ts - now) <= Self.maxClockSkewMs else { return now }
        return ts
    }

    private func duration(_ value: Any?) -> Double? {
        guard let ms = JSONRead.double(value), ms >= 0, ms <= Self.maxDurationMs else { return nil }
        return (ms * 10).rounded() / 10
    }

    private func headers(_ value: Any?) -> [(String, String)] {
        guard let list = value as? [Any] else { return [] }
        var out: [(String, String)] = []
        for item in list {
            if out.count >= Self.maxHeaders { break }
            guard let pair = item as? [Any], pair.count >= 2,
                  let name = string(pair[0], 256), !name.trimmingCharacters(in: .whitespaces).isEmpty,
                  let raw = string(pair[1], 8 * 1024) else { continue }
            out.append((name, raw))
        }
        return core.redacting(out)
    }

    /// The page's body, cut to the SDK's capture settings (`captureBodies`, `maxBodyBytes`).
    private func body(_ value: Any?) -> WireBody? {
        guard let map = value as? [String: Any],
              let encoding = (map["encoding"] as? String).flatMap(WireBody.Encoding.init(rawValue:)) else { return nil }
        let data = map["data"] as? String ?? ""
        let claimed = JSONRead.int(map["size"]).flatMap { (0...Self.maxClaimedSize).contains($0) ? $0 : nil } ?? 0
        let config = core.sdkConfig
        guard config.captureBodies else {
            return claimed > 0 ? WireBody(encoding: .utf8, data: "", size: claimed, truncated: true) : nil
        }
        let limit = min(max(0, config.maxBodyBytes), DurbunCore.maxBodyBytesCap)
        var truncated = isTrue(map["truncated"])
        var kept = data
        switch encoding {
        case .utf8:
            if data.utf16.count > limit {
                kept = string(data, limit) ?? ""
                truncated = true
            }
        case .base64:
            guard data.range(of: "^[A-Za-z0-9+/]*={0,2}$", options: .regularExpression) != nil else {
                return claimed > 0 ? WireBody(encoding: .utf8, data: "", size: claimed, truncated: true) : nil
            }
            let maxChars = limit / 3 * 4
            if data.count > maxChars {
                kept = String(data.prefix(maxChars))
                truncated = true
            }
        }
        let keptBytes = encoding == .utf8 ? kept.utf8.count : kept.count / 4 * 3
        if kept.isEmpty && claimed == 0 { return nil }
        return WireBody(encoding: encoding, data: kept, size: max(claimed, keptBytes), truncated: truncated)
    }
}
