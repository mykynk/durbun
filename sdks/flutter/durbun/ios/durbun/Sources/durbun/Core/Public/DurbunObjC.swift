import Foundation

/// Dürbün for Objective-C code (`@import Durbun;`). The same SDK as `Durbun`, with Objective-C names:
///
/// ```objc
/// [DURDurbun start];
/// [DURDurbun info:@"Logged in" tag:@"auth"];
/// [DURDurbun log:@"Cache miss" level:@"debug" tag:@"cache" data:@{@"key": key}];
/// [DURDurbun event:@"purchase" properties:@{@"amount": @49.9}];
/// [DURDurbun addButtonWithId:@"app.logout" label:@"Log out" handler:^{ [session logout]; }];
/// ```
///
/// Every call is safe from any thread and does nothing while the SDK is not running.
@objc(DURDurbun)
public final class DurbunObjC: NSObject {
    private override init() {}

    /// `Durbun.start()` with the default options (simulator and USB need nothing else).
    @objc public static func start() {
        Durbun.start()
    }

    /// `Durbun.start(options:)` with the Mac's address for Wi-Fi; nil behaves like `start`.
    @objc(startWithHost:)
    public static func start(host: String?) {
        Durbun.start(options: DurbunOptions(host: host))
    }

    @objc public static func stop() {
        Durbun.stop()
    }

    @objc public static var isRunning: Bool { Durbun.isRunning }

    @objc public static var isConnected: Bool { Durbun.isConnected }

    /// `Durbun.connectionStatus.description`: why the app is (not) connected, with the next step.
    @objc public static var connectionStatusDescription: String { Durbun.connectionStatus.description }

    /// `Durbun.setDesktopHost(_:)`: the Mac's address at run time, kept for the next launches.
    @objc(setDesktopHost:)
    @discardableResult
    public static func setDesktopHost(_ address: String?) -> Bool {
        Durbun.setDesktopHost(address)
    }

    /// A log line. `level` is a protocol name (`verbose`, `debug`, `info`, `warn`, `error`, `fatal`;
    /// anything else is `info`); `data` is shown as a JSON tree (dictionaries, arrays, strings, numbers).
    @objc(log:level:tag:data:)
    public static func log(_ message: String, level: String?, tag: String?, data: Any?) {
        Durbun.log(message, level: logLevel(level), tag: tag, data: data)
    }

    @objc(debug:tag:)
    public static func debug(_ message: String, tag: String?) {
        Durbun.log(message, level: .debug, tag: tag)
    }

    @objc(info:tag:)
    public static func info(_ message: String, tag: String?) {
        Durbun.log(message, level: .info, tag: tag)
    }

    @objc(warning:tag:)
    public static func warning(_ message: String, tag: String?) {
        Durbun.log(message, level: .warning, tag: tag)
    }

    /// An error line; `error` (an `NSError`) adds its type, message and the caller's stack.
    @objc(error:tag:error:)
    public static func error(_ message: String, tag: String?, error: NSError?) {
        Durbun.log(message, level: .error, tag: tag, error: error)
    }

    @objc(event:properties:)
    public static func event(_ name: String, properties: [String: Any]?) {
        Durbun.event(name, properties)
    }

    /// A button in the desktop's Device panel; `handler` runs on the main thread.
    @objc(addButtonWithId:label:handler:)
    public static func addButton(id: String, label: String, handler: @escaping () -> Void) {
        Durbun.registerAction(DurbunAction(id: id, label: label)) { _ in
            handler()
            return nil
        }
    }

    /// A switch in the desktop's Device panel; `handler` gets the new state on the main thread.
    @objc(addToggleWithId:label:initialValue:handler:)
    public static func addToggle(id: String, label: String, initialValue: Bool, handler: @escaping (Bool) -> Void) {
        Durbun.registerAction(DurbunAction(id: id, label: label, kind: .toggle(initialValue))) { params in
            handler(params["value"] as? Bool ?? false)
            return nil
        }
    }

    @objc(removeActionWithId:)
    public static func removeAction(id: String) {
        Durbun.removeAction(id: id)
    }

    static func logLevel(_ name: String?) -> DurbunLogLevel {
        guard let name = name?.lowercased() else { return .info }
        if name == "warning" { return .warning }
        return DurbunLogLevel(rawValue: name) ?? .info
    }
}
