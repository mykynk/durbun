import Foundation

/// Turns captured bytes into a `WireBody`, honoring `maxBodyBytes` (keep the real `size`, set
/// `truncated`). Text-like content types go out as UTF-8, everything else as base64.
enum BodyCapture {
    /// Same rule as the protocol's `isTextContentType`.
    static func isTextContentType(_ contentType: String?) -> Bool {
        guard let contentType else { return false }
        let ct = contentType.lowercased()
        return ct.hasPrefix("text/")
            || ct.contains("json")
            || ct.contains("xml")
            || ct.contains("html")
            || ct.contains("javascript")
            || ct.contains("x-www-form-urlencoded")
            || ct.contains("graphql")
            || ct.contains("yaml")
            || ct.contains("csv")
    }

    /// - Parameters:
    ///   - captured: the first bytes of the body (may already be longer than `limit`).
    ///   - totalSize: the full decoded size of the body.
    static func wireBody(captured: Data, totalSize: Int, contentType: String?, limit: Int) -> WireBody? {
        let size = max(totalSize, captured.count)
        guard size > 0 else { return nil }
        let kept = captured.count > limit ? captured.prefix(max(0, limit)) : captured
        let truncated = kept.count < size
        let wantsText: Bool
        if let contentType, !contentType.isEmpty {
            wantsText = isTextContentType(contentType)
        } else {
            // No Content-Type (common for hand-built requests): sniff instead of hiding text as base64.
            wantsText = !kept.prefix(1024).contains(0)
        }
        if wantsText, let text = decodeUTF8(Data(kept), allowTrimmingPartialCharacter: truncated) {
            return WireBody(encoding: .utf8, data: text, size: size, truncated: truncated)
        }
        return WireBody(encoding: .base64, data: Data(kept).base64EncodedString(), size: size, truncated: truncated)
    }

    /// Strict UTF-8 decoding; a character cut in half by truncation is dropped instead of failing.
    static func decodeUTF8(_ data: Data, allowTrimmingPartialCharacter: Bool) -> String? {
        if let text = String(data: data, encoding: .utf8) { return text }
        guard allowTrimmingPartialCharacter else { return nil }
        for trim in 1...3 where data.count > trim {
            if let text = String(data: data.dropLast(trim), encoding: .utf8) { return text }
        }
        return nil
    }
}

/// Bounded accumulator for response bytes (tee: the app still receives every chunk).
struct BodyAccumulator {
    private(set) var data = Data()
    private(set) var totalSize = 0
    var limit: Int

    init(limit: Int) {
        self.limit = max(0, limit)
    }

    mutating func append(_ chunk: Data) {
        totalSize += chunk.count
        let room = limit - data.count
        if room > 0 { data.append(chunk.prefix(room)) }
    }
}

enum HTTPHeaders {
    /// Headers sorted by name (case-insensitive) for a stable, readable order.
    static func sorted(_ fields: [String: String]?) -> [(String, String)] {
        guard let fields else { return [] }
        return fields.map { ($0.key, $0.value) }.sorted { $0.0.lowercased() < $1.0.lowercased() }
    }

    static func sorted(_ fields: [AnyHashable: Any]) -> [(String, String)] {
        fields.map { (String(describing: $0.key.base), String(describing: $0.value)) }
            .sorted { $0.0.lowercased() < $1.0.lowercased() }
    }

    static func value(_ name: String, in headers: [(String, String)]) -> String? {
        let lower = name.lowercased()
        return headers.first { $0.0.lowercased() == lower }?.1
    }
}

enum HTTPStatusText {
    private static let texts: [Int: String] = [
        100: "Continue", 101: "Switching Protocols", 103: "Early Hints",
        200: "OK", 201: "Created", 202: "Accepted", 203: "Non-Authoritative Information", 204: "No Content",
        205: "Reset Content", 206: "Partial Content", 207: "Multi-Status",
        300: "Multiple Choices", 301: "Moved Permanently", 302: "Found", 303: "See Other", 304: "Not Modified",
        307: "Temporary Redirect", 308: "Permanent Redirect",
        400: "Bad Request", 401: "Unauthorized", 402: "Payment Required", 403: "Forbidden", 404: "Not Found",
        405: "Method Not Allowed", 406: "Not Acceptable", 407: "Proxy Authentication Required",
        408: "Request Timeout", 409: "Conflict", 410: "Gone", 411: "Length Required", 412: "Precondition Failed",
        413: "Content Too Large", 414: "URI Too Long", 415: "Unsupported Media Type", 416: "Range Not Satisfiable",
        417: "Expectation Failed", 418: "I'm a teapot", 421: "Misdirected Request", 422: "Unprocessable Content",
        423: "Locked", 424: "Failed Dependency", 425: "Too Early", 426: "Upgrade Required",
        428: "Precondition Required", 429: "Too Many Requests", 431: "Request Header Fields Too Large",
        451: "Unavailable For Legal Reasons",
        500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable",
        504: "Gateway Timeout", 505: "HTTP Version Not Supported", 507: "Insufficient Storage",
        508: "Loop Detected", 511: "Network Authentication Required",
    ]

    static func text(for status: Int) -> String? { texts[status] }
}

enum NetworkErrorText {
    private static let urlErrorNames: [Int: String] = [
        NSURLErrorUnknown: "unknown",
        NSURLErrorCancelled: "cancelled",
        NSURLErrorBadURL: "badURL",
        NSURLErrorTimedOut: "timedOut",
        NSURLErrorUnsupportedURL: "unsupportedURL",
        NSURLErrorCannotFindHost: "cannotFindHost",
        NSURLErrorCannotConnectToHost: "cannotConnectToHost",
        NSURLErrorNetworkConnectionLost: "networkConnectionLost",
        NSURLErrorDNSLookupFailed: "dnsLookupFailed",
        NSURLErrorHTTPTooManyRedirects: "httpTooManyRedirects",
        NSURLErrorResourceUnavailable: "resourceUnavailable",
        NSURLErrorNotConnectedToInternet: "notConnectedToInternet",
        NSURLErrorRedirectToNonExistentLocation: "redirectToNonExistentLocation",
        NSURLErrorBadServerResponse: "badServerResponse",
        NSURLErrorUserCancelledAuthentication: "userCancelledAuthentication",
        NSURLErrorUserAuthenticationRequired: "userAuthenticationRequired",
        NSURLErrorZeroByteResource: "zeroByteResource",
        NSURLErrorCannotDecodeRawData: "cannotDecodeRawData",
        NSURLErrorCannotDecodeContentData: "cannotDecodeContentData",
        NSURLErrorCannotParseResponse: "cannotParseResponse",
        NSURLErrorInternationalRoamingOff: "internationalRoamingOff",
        NSURLErrorCallIsActive: "callIsActive",
        NSURLErrorDataNotAllowed: "dataNotAllowed",
        NSURLErrorRequestBodyStreamExhausted: "requestBodyStreamExhausted",
        NSURLErrorAppTransportSecurityRequiresSecureConnection: "appTransportSecurityRequiresSecureConnection",
        NSURLErrorFileDoesNotExist: "fileDoesNotExist",
        NSURLErrorDataLengthExceedsMaximum: "dataLengthExceedsMaximum",
        NSURLErrorSecureConnectionFailed: "secureConnectionFailed",
        NSURLErrorServerCertificateHasBadDate: "serverCertificateHasBadDate",
        NSURLErrorServerCertificateUntrusted: "serverCertificateUntrusted",
        NSURLErrorServerCertificateHasUnknownRoot: "serverCertificateHasUnknownRoot",
        NSURLErrorServerCertificateNotYetValid: "serverCertificateNotYetValid",
        NSURLErrorClientCertificateRejected: "clientCertificateRejected",
        NSURLErrorClientCertificateRequired: "clientCertificateRequired",
        NSURLErrorCannotLoadFromNetwork: "cannotLoadFromNetwork",
    ]

    /// e.g. "The request timed out. [URLError.timedOut -1001]"
    static func describe(_ error: Error) -> String {
        let ns = error as NSError
        let text = ns.localizedDescription
        if ns.domain == NSURLErrorDomain {
            let name = urlErrorNames[ns.code].map { "URLError.\($0) " } ?? "NSURLErrorDomain "
            return "\(text) [\(name)\(ns.code)]"
        }
        return "\(text) [\(ns.domain) \(ns.code)]"
    }
}

/// Maps URLSessionTaskMetrics to protocol `Timings` (+ negotiated protocol, remote address).
enum NetworkTimings {
    struct Result {
        var timings: WireTimings?
        var protocolName: String?
        var remoteAddress: String?
    }

    static func from(_ metrics: URLSessionTaskMetrics?) -> Result {
        guard let metrics else { return Result() }
        let transactions = metrics.transactionMetrics
        guard let t = transactions.last(where: { $0.resourceFetchType == .networkLoad }) ?? transactions.last else {
            return Result()
        }
        var timings = WireTimings()
        timings.dns = span(t.domainLookupStartDate, t.domainLookupEndDate)
        if let secureStart = t.secureConnectionStartDate {
            timings.connect = span(t.connectStartDate, secureStart)
            timings.tls = span(secureStart, t.secureConnectionEndDate)
        } else {
            timings.connect = span(t.connectStartDate, t.connectEndDate)
        }
        timings.send = span(t.requestStartDate, t.requestEndDate)
        timings.wait = span(t.requestEndDate, t.responseStartDate)
        timings.receive = span(t.responseStartDate, t.responseEndDate)
        var remote: String?
        if let address = t.remoteAddress {
            let host = address.contains(":") ? "[\(address)]" : address
            remote = t.remotePort.map { "\(host):\($0)" } ?? address
        }
        return Result(timings: timings.isEmpty ? nil : timings, protocolName: t.networkProtocolName, remoteAddress: remote)
    }

    private static func span(_ start: Date?, _ end: Date?) -> Double? {
        guard let start, let end else { return nil }
        let ms = end.timeIntervalSince(start) * 1000
        guard ms >= 0, ms.isFinite else { return nil }
        return (ms * 1000).rounded() / 1000
    }
}
