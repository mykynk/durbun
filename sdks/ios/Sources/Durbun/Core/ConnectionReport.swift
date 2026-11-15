import Foundation
import Network

/// Why the app is not connected to the Dürbün desktop, in words a developer can act on. The diagnosis
/// table and the wording are shared by every Dürbün SDK (Flutter, Android, iOS).
enum AttemptKind {
    /// Nothing listens on that port (the host answered with a reset).
    static let refused = "refused"
    /// No answer within the connect timeout (wrong address, other network, firewall).
    static let timeout = "timeout"
    /// No route to the host or network.
    static let unreachable = "unreachable"
    /// The system did not allow the connection (the Local Network permission).
    static let denied = "denied"
    /// The host name could not be resolved.
    static let lookup = "lookup"
    /// The peer accepted the connection and closed it before the welcome.
    static let closed = "closed"
    /// The peer accepted the connection but sent no welcome in time.
    static let noWelcome = "no-welcome"
    /// Anything else.
    static let error = "error"

    /// `kDNSServiceErr_PolicyDenied` and `kDNSServiceErr_NoAuth`: the Local Network permission is off.
    private static let dnsDeniedCodes: Set<Int32> = [-65570, -65555]

    /// Sorts a Network.framework error into one of the kinds above.
    static func classify(_ error: NWError, localNetworkDenied: Bool = false) -> String {
        if localNetworkDenied { return denied }
        switch error {
        case let .posix(code):
            switch code {
            case .ECONNREFUSED: return refused
            case .ETIMEDOUT: return timeout
            case .EHOSTUNREACH, .ENETUNREACH, .EHOSTDOWN, .ENETDOWN: return unreachable
            case .EPERM, .EACCES: return denied
            default: return Self.error
            }
        case let .dns(code):
            return dnsDeniedCodes.contains(code) ? denied : lookup
        default:
            return Self.error
        }
    }
}

/// One failed client attempt: `host:port`, a kind from `AttemptKind`, the system's message.
struct ConnectAttempt: Equatable {
    var endpoint: String
    var kind: String
    var detail: String = ""

    var isLoopback: Bool { endpoint.hasPrefix("127.0.0.1:") }
}

/// What most likely keeps the app from the desktop. The raw values are the codes
/// `DurbunConnectionStatus.issue` uses.
enum ConnectIssue: String, CaseIterable {
    /// Simulator or Mac: nothing listens on this computer's SDK port.
    case desktopNotRunning
    /// Android phone without a Wi-Fi address: no `adb reverse` on the cable.
    case usbNotSetUp
    /// Android phone: `adb reverse` is set up but nothing answers on the Mac.
    case usbDesktopClosed
    /// iPhone without a Wi-Fi address: the Mac app connects over the cable; it has not come yet.
    case iosUsbWaiting
    /// The Mac answered but its SDK port is closed to the network.
    case lanRefused
    /// No answer from the address: wrong address, another network, firewall.
    case lanTimeout
    /// No route to the address (another network) or the Local Network permission.
    case lanUnreachable
    /// The address is not a name or IP the phone can resolve.
    case lanBadAddress
    /// The system did not allow the connection.
    case permissionDenied
    /// Something answered on the port, but not a Dürbün desktop that took this app.
    case notDurbun
    /// Any other failure.
    case other
}

enum ConnectionDiagnosis {
    /// Picks the most likely issue for the last failed attempts. `platform` is `android`, `ios` or
    /// anything else; `isPhysical` is false on simulators; `lanEndpoint` is the Wi-Fi endpoint, if any.
    static func diagnose(
        attempts: [ConnectAttempt],
        platform: String,
        isPhysical: Bool,
        lanEndpoint: String?
    ) -> ConnectIssue {
        if attempts.contains(where: { $0.kind == AttemptKind.denied }) { return .permissionDenied }
        if let lanEndpoint, let lan = attempts.first(where: { $0.endpoint == lanEndpoint }) {
            switch lan.kind {
            case AttemptKind.refused: return .lanRefused
            case AttemptKind.timeout: return .lanTimeout
            case AttemptKind.unreachable: return .lanUnreachable
            case AttemptKind.lookup: return .lanBadAddress
            case AttemptKind.closed, AttemptKind.noWelcome: return .notDurbun
            default: return .other
            }
        }
        let loopback = attempts.first(where: \.isLoopback)
        let android = platform == "android"
        if android && isPhysical {
            // adb reverse accepts on the phone and closes when nothing listens on the Mac.
            return loopback?.kind == AttemptKind.closed ? .usbDesktopClosed : .usbNotSetUp
        }
        if platform == "ios" && isPhysical { return .iosUsbWaiting }
        if let loopback, loopback.kind == AttemptKind.closed || loopback.kind == AttemptKind.noWelcome {
            return android ? .usbDesktopClosed : .notDurbun
        }
        if loopback == nil || loopback?.kind == AttemptKind.refused { return .desktopNotRunning }
        return .other
    }

    /// What to do next, in one or two English sentences (the same table as the other SDKs).
    static func nextStep(_ issue: ConnectIssue?, port: UInt16, lanEndpoint: String?) -> String {
        let lan = lanEndpoint ?? "the Mac"
        switch issue {
        case .desktopNotRunning:
            return "Nothing answers on this computer's port \(port): open the Dürbün Mac app (or check its SDK port)."
        case .usbNotSetUp:
            return "No USB link to the Mac: connect the phone with USB debugging on and open the Dürbün Mac app "
                + "(it runs adb reverse tcp:\(port) by itself). For Wi-Fi, give the Mac's address with "
                + "Durbun.setDesktopHost(context, \"<Mac IP>\"), the launch extra durbun.host, the dev.durbun.host "
                + "manifest entry or DurbunOptions(host = \"<Mac IP>\")."
        case .usbDesktopClosed:
            return "adb reverse is set up, but nothing answers on the Mac: open the Dürbün Mac app."
        case .iosUsbWaiting:
            return "Waiting for the Mac over USB: open the Dürbün Mac app with this iPhone on the cable (and trusted). "
                + "For Wi-Fi, give the Mac's address with Durbun.setDesktopHost(\"<Mac IP>\"), the -DurbunHost "
                + "launch argument, the DurbunHost Info.plist key or DurbunOptions(host:)."
        case .lanRefused:
            return "The Mac at \(lan) refuses the connection: open Dürbün there and turn on Settings → "
                + "\"Allow local network (Wi-Fi) connections\"."
        case .lanTimeout:
            return "No answer from \(lan): check the address (Dürbün → Settings lists this Mac's addresses), "
                + "that the phone and the Mac are on the same Wi-Fi, and the Mac's firewall."
        case .lanUnreachable:
            return "No route to \(lan): the phone is on another network than the Mac, or (iOS) Local Network "
                + "access is off for this app (Settings → Privacy & Security → Local Network; Info.plist needs "
                + "NSLocalNetworkUsageDescription)."
        case .lanBadAddress:
            return "The address \(lan) cannot be resolved: use the Mac's IP address, e.g. 192.168.1.20."
        case .permissionDenied:
            return "The system did not allow the connection: on Android add <uses-permission "
                + "android:name=\"android.permission.INTERNET\"/> to the main AndroidManifest.xml and check firewall or "
                + "data saver apps; on iOS allow Local Network access."
        case .notDurbun:
            return "Something answered, but it is not a Dürbün desktop that accepted this app (another program on the "
                + "port, or a Dürbün version that does not match this SDK)."
        case .other, nil:
            return "The connection failed."
        }
    }

    /// One English paragraph for the developer console: what failed and what to do next.
    static func consoleHint(_ issue: ConnectIssue?, attempts: [ConnectAttempt], port: UInt16, lanEndpoint: String?) -> String {
        let tried = attempts.map { "\($0.endpoint) \($0.kind)" }.joined(separator: ", ")
        return "Dürbün: not connected to the desktop. \(nextStep(issue, port: port, lanEndpoint: lanEndpoint)) "
            + (tried.isEmpty ? "" : "Tried: \(tried). ")
            + "The app keeps working and keeps retrying; Durbun.connectionStatus says the same."
    }
}

/// A desktop address typed by a person: `192.168.1.20`, `192.168.1.20:9751`, `my-mac.local`,
/// `[fe80::1]:9751`; a leading `http://` and a trailing `/` are dropped. Same rules as the Flutter
/// SDK's in-app panel.
struct DesktopAddress: Equatable, CustomStringConvertible {
    var host: String
    var port: UInt16?

    /// `host` or `host:port` (IPv6 in brackets when a port follows).
    var description: String {
        guard let port else { return host }
        return host.contains(":") ? "[\(host)]:\(port)" : "\(host):\(port)"
    }

    static func parse(_ input: String?) -> DesktopAddress? {
        guard var v = input?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else { return nil }
        if let scheme = v.range(of: "^[a-zA-Z]+://", options: .regularExpression) { v.removeSubrange(scheme) }
        while v.hasSuffix("/") { v.removeLast() }
        if v.isEmpty || v.contains(where: { $0.isWhitespace || "/?#@".contains($0) }) { return nil }
        let host: String
        var port: String?
        if v.hasPrefix("[") {
            guard let end = v.firstIndex(of: "]"), v.distance(from: v.startIndex, to: end) >= 2 else { return nil }
            host = String(v[v.index(after: v.startIndex)..<end])
            let rest = v[v.index(after: end)...]
            if !rest.isEmpty {
                guard rest.hasPrefix(":") else { return nil }
                port = String(rest.dropFirst())
            }
            guard isIPv6Like(host), host.contains(":") else { return nil }
        } else if v.filter({ $0 == ":" }).count > 1 {
            host = v // a bare IPv6 address: no port
            guard isIPv6Like(host) else { return nil }
        } else {
            if let colon = v.firstIndex(of: ":") {
                host = String(v[..<colon])
                port = String(v[v.index(after: colon)...])
            } else {
                host = v
            }
            let labels = host.split(separator: ".", omittingEmptySubsequences: false)
            guard !host.isEmpty, host.count <= 253, labels.allSatisfy(isLabel) else { return nil }
            // All digits and dots: an IPv4 address, four parts of 0-255.
            if host.allSatisfy({ $0.isASCII && ($0.isNumber || $0 == ".") }),
               labels.count != 4 || labels.contains(where: { (Int($0) ?? 256) > 255 })
            {
                return nil
            }
        }
        if let port {
            guard let n = Int(port), (1...65535).contains(n) else { return nil }
            return DesktopAddress(host: host, port: UInt16(n))
        }
        return DesktopAddress(host: host, port: nil)
    }

    private static func isLabel(_ label: Substring) -> Bool {
        guard !label.isEmpty, label.count <= 63 else { return false }
        let ok = label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        return ok && label.first != "-" && label.last != "-"
    }

    private static func isIPv6Like(_ host: String) -> Bool {
        !host.isEmpty && host.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || ":.%".contains($0)) }
    }
}
