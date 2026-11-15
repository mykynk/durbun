import Foundation

/// The desktop connection as the app can show it, for example in its own debug menu
/// (`Durbun.connectionStatus`, `Durbun.connectionStatusDidChangeNotification`).
public struct DurbunConnectionStatus: Sendable, Equatable, CustomStringConvertible {
    /// A desktop connection completed the handshake.
    public let isConnected: Bool
    /// How the live connection runs: `usb` (the Mac over the cable), `127.0.0.1:9751` (simulator) or the
    /// Mac's Wi-Fi address.
    public let via: String?
    /// The Wi-Fi address tried besides USB (`192.168.1.20:9751`), if any.
    public let desktopHost: String?
    /// Where `desktopHost` comes from: `runtime` (`Durbun.setDesktopHost` or the `-DurbunHost` launch
    /// argument, kept for the next launches), `options` (`DurbunOptions.host`), `environment`
    /// (`DURBUN_HOST` in the Xcode scheme) or `infoPlist` (the `DurbunHost` key).
    public let desktopHostSource: String?
    /// Why there is no connection: `desktopNotRunning`, `iosUsbWaiting`, `lanRefused`, `lanTimeout`,
    /// `lanUnreachable`, `lanBadAddress`, `permissionDenied`, `notDurbun`, `other`; `notStarted` when
    /// Dürbün is not running. Nil while connected or before the first attempt ended.
    public let issue: String?
    /// What to do next, in one or two English sentences (nil while connected).
    public let hint: String?
    /// Failed connection attempts since the last connection or address change.
    public let failedAttempts: Int

    public init(
        isConnected: Bool,
        via: String?,
        desktopHost: String?,
        desktopHostSource: String?,
        issue: String?,
        hint: String?,
        failedAttempts: Int
    ) {
        self.isConnected = isConnected
        self.via = via
        self.desktopHost = desktopHost
        self.desktopHostSource = desktopHostSource
        self.issue = issue
        self.hint = hint
        self.failedAttempts = failedAttempts
    }

    public var description: String {
        if isConnected { return "Connected to the Dürbün desktop via \(via ?? "?")" }
        if let hint { return "Not connected to the Dürbün desktop: \(hint)" }
        return "Connecting to the Dürbün desktop…"
    }

    static let notStarted = DurbunConnectionStatus(
        isConnected: false,
        via: nil,
        desktopHost: nil,
        desktopHostSource: nil,
        issue: "notStarted",
        hint: "Dürbün is not running: Durbun.start() was not called, or this build was compiled without DEBUG "
            + "(see DurbunOptions.allowInReleaseBuilds).",
        failedAttempts: 0
    )
}
