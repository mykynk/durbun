import Foundation

/// Severity of a log line. Raw values are the wire names used by the Dürbün protocol.
public enum DurbunLogLevel: String, CaseIterable, Sendable {
    case verbose
    case debug
    case info
    case warning = "warn"
    case error
    case fatal

    /// Alias for `.warning` (matches the protocol's `warn`).
    public static let warn = DurbunLogLevel.warning
}
