import Foundation
import ObjectiveC

/// Hooks `DurbunURLProtocol` into the URL loading system:
///  - `URLProtocol.registerClass` covers `URLSession.shared` (and NSURLConnection);
///  - swizzled `URLSessionConfiguration.default` / `.ephemeral` prepend the protocol class, so
///    custom sessions (Alamofire, your own `URLSession(configuration:)`) are captured too.
/// The swizzle is installed once and stays; the protocol itself declines everything while the SDK
/// is stopped. Background sessions run out of process and cannot be intercepted.
enum NetworkCapture {
    private static let lock = UnfairLock()
    private static var swizzled = false
    private static var registered = false

    static func install() {
        lock.withLock {
            if !swizzled {
                swizzled = true
                exchangeClassMethod(
                    URLSessionConfiguration.self,
                    original: NSSelectorFromString("defaultSessionConfiguration"),
                    replacement: #selector(URLSessionConfiguration.durbun_defaultSessionConfiguration)
                )
                exchangeClassMethod(
                    URLSessionConfiguration.self,
                    original: NSSelectorFromString("ephemeralSessionConfiguration"),
                    replacement: #selector(URLSessionConfiguration.durbun_ephemeralSessionConfiguration)
                )
            }
            if !registered {
                registered = URLProtocol.registerClass(DurbunURLProtocol.self)
            }
        }
    }

    static func uninstall() {
        lock.withLock {
            if registered {
                URLProtocol.unregisterClass(DurbunURLProtocol.self)
                registered = false
            }
        }
    }

    /// Puts the protocol first in `protocolClasses` (idempotent).
    static func inject(into configuration: URLSessionConfiguration) {
        var classes = configuration.protocolClasses ?? []
        guard !classes.contains(where: { ObjectIdentifier($0) == ObjectIdentifier(DurbunURLProtocol.self) }) else { return }
        classes.insert(DurbunURLProtocol.self, at: 0)
        configuration.protocolClasses = classes
    }

    private static func exchangeClassMethod(_ cls: AnyClass, original: Selector, replacement: Selector) {
        guard let originalMethod = class_getClassMethod(cls, original),
              let replacementMethod = class_getClassMethod(cls, replacement)
        else { return }
        method_exchangeImplementations(originalMethod, replacementMethod)
    }
}

extension URLSessionConfiguration {
    // After the exchange these names point at the original implementations.
    @objc dynamic class func durbun_defaultSessionConfiguration() -> URLSessionConfiguration {
        let configuration = durbun_defaultSessionConfiguration()
        NetworkCapture.inject(into: configuration)
        return configuration
    }

    @objc dynamic class func durbun_ephemeralSessionConfiguration() -> URLSessionConfiguration {
        let configuration = durbun_ephemeralSessionConfiguration()
        NetworkCapture.inject(into: configuration)
        return configuration
    }
}
