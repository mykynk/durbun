import Foundation

/// Dürbün iOS SDK.
///
/// ```swift
/// import Durbun
///
/// #if DEBUG
/// Durbun.start()                                        // simulator + USB: automatic
/// // Durbun.start(options: .init(host: "192.168.1.20"))  // Wi-Fi
/// #endif
///
/// Durbun.log("Logged in", level: .info, tag: "auth", data: ["userId": 42])
/// Durbun.error("Payment failed", error: error, tag: "payment")
/// Durbun.event("purchase", ["amount": 49.9])
/// ```
///
/// Every call is thread-safe, never blocks the calling thread on I/O and is a cheap no-op while the
/// SDK is not running (for example in release builds).
public enum Durbun {
    public typealias Level = DurbunLogLevel

    /// SDK version reported to the desktop in `hello.sdk.version`.
    public static let version = "0.1.0"

    /// Starts capturing and connecting to the Dürbün desktop app. Calling it again restarts the SDK
    /// with the new options. Does nothing in non-DEBUG builds unless `allowInReleaseBuilds` is set.
    public static func start(options: DurbunOptions = DurbunOptions()) {
        DurbunCore.shared.start(options: options)
    }

    /// Stops capturing and closes the desktop connection. Restores stdout/stderr and the previous
    /// crash handlers.
    public static func stop() {
        DurbunCore.shared.stop()
    }

    /// True between `start` and `stop`.
    public static var isRunning: Bool { DurbunCore.shared.isRunning }

    /// True while a desktop connection completed the hello/welcome handshake.
    public static var isConnected: Bool { DurbunCore.shared.isConnected }

    // MARK: Logging

    /// Sends a structured log line. `data` may be a dictionary, array, `Encodable` value or any
    /// other value (converted to JSON on a best-effort basis).
    public static func log(
        _ message: @autoclosure () -> String,
        level: DurbunLogLevel = .info,
        tag: String? = nil,
        data: Any? = nil,
        error: Error? = nil
    ) {
        let core = DurbunCore.shared
        guard core.isRunning else { return }
        core.log(message(), level: level, tag: tag, data: data, error: error)
    }

    public static func verbose(_ message: @autoclosure () -> String, tag: String? = nil, data: Any? = nil) {
        log(message(), level: .verbose, tag: tag, data: data)
    }

    public static func debug(_ message: @autoclosure () -> String, tag: String? = nil, data: Any? = nil) {
        log(message(), level: .debug, tag: tag, data: data)
    }

    public static func info(_ message: @autoclosure () -> String, tag: String? = nil, data: Any? = nil) {
        log(message(), level: .info, tag: tag, data: data)
    }

    public static func warning(
        _ message: @autoclosure () -> String,
        tag: String? = nil,
        data: Any? = nil,
        error: Error? = nil
    ) {
        log(message(), level: .warning, tag: tag, data: data, error: error)
    }

    public static func error(
        _ message: @autoclosure () -> String,
        error: Error? = nil,
        tag: String? = nil,
        data: Any? = nil
    ) {
        log(message(), level: .error, tag: tag, data: data, error: error)
    }

    // MARK: Events

    /// Sends a custom analytics-style event (shown as an event row in the log stream).
    public static func event(_ name: String, _ props: [String: Any]? = nil) {
        let core = DurbunCore.shared
        guard core.isRunning else { return }
        core.event(name, props: props)
    }

    // MARK: App tools

    /// Registers a custom tool for this app in Dürbün's device panel. The handler runs on the main
    /// thread; toggles and pickers receive their new value in `params["value"]`. Return a value to
    /// send it back as the result, or throw (e.g. `DurbunActionError("…")`) to report a failure.
    /// Registering an existing id replaces it.
    public static func registerAction(_ action: DurbunAction, handler: @escaping @MainActor ([String: Any]) throws -> Any?) {
        DurbunCore.shared.commands.register(action, handler: handler)
    }

    /// Removes a tool registered with `registerAction`.
    public static func removeAction(id: String) {
        DurbunCore.shared.commands.remove(id: id)
    }
}
