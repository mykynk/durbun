import Foundation
import ObjectiveC

/// Hooks `DurbunURLProtocol` into the URL loading system:
///  - `URLProtocol.registerClass` covers `URLSession.shared` (and NSURLConnection);
///  - swizzled `URLSessionConfiguration.default` / `.ephemeral` prepend the protocol class, so
///    custom sessions (Alamofire, your own `URLSession(configuration:)`) are captured too;
///  - swizzled `URLSession(configuration:…)` binds each session's final configuration to a
///    protocol subclass with its own forwarding session (`SessionBinding`), so the real request
///    runs with that session's cache, cookies, proxy, TLS and connectivity settings.
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
                exchangeClassMethod(
                    URLSession.self,
                    original: NSSelectorFromString("sessionWithConfiguration:"),
                    replacement: #selector(URLSession.durbun_session(with:))
                )
                exchangeClassMethod(
                    URLSession.self,
                    original: NSSelectorFromString("sessionWithConfiguration:delegate:delegateQueue:"),
                    replacement: #selector(URLSession.durbun_session(with:delegate:delegateQueue:))
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

extension URLSession {
    // After the exchange these names point at the original implementations.
    @objc(durbun_sessionWithConfiguration:)
    dynamic class func durbun_session(with configuration: URLSessionConfiguration) -> URLSession {
        durbun_session(with: SessionBinding.bind(configuration))
    }

    @objc(durbun_sessionWithConfiguration:delegate:delegateQueue:)
    dynamic class func durbun_session(
        with configuration: URLSessionConfiguration,
        delegate: URLSessionDelegate?,
        delegateQueue queue: OperationQueue?
    ) -> URLSession {
        durbun_session(with: SessionBinding.bind(configuration), delegate: delegate, delegateQueue: queue)
    }
}

/// Pairs app sessions with forwarding sessions. When an app session is created from a configuration
/// that carries `DurbunURLProtocol`, the class is replaced by a runtime subclass bound to a copy of
/// that configuration; the subclass's requests are forwarded by a session built from the copy.
/// Sessions with the same settings (same cache / cookie / credential storage objects and the same
/// values) share one subclass, so the number of classes stays small. After `maxBindings` distinct
/// configurations, new sessions are left uncaptured (their traffic is not shown, and runs exactly as
/// without Dürbün) instead of creating more classes and sessions.
enum SessionBinding {
    static let maxBindings = 32

    private struct Binding {
        let key: SettingsKey
        let protocolClass: AnyClass
        let forwarding: ForwardingSession
    }

    private static let lock = UnfairLock()
    private static var bindings: [Binding] = []
    private static var serial = 0
    private static var limitNoted = false

    /// Protocol classes without Dürbün's (the base class and its bound subclasses).
    static func withoutDurbun(_ classes: [AnyClass]?) -> [AnyClass] {
        (classes ?? []).filter { !isDurbun($0) }
    }

    static func isDurbun(_ cls: AnyClass) -> Bool {
        let base = ObjectIdentifier(DurbunURLProtocol.self)
        var current: AnyClass? = cls
        while let type = current {
            if ObjectIdentifier(type) == base { return true }
            current = class_getSuperclass(type)
        }
        return false
    }

    static func forwarding(for protocolClass: AnyClass) -> ForwardingSession? {
        let id = ObjectIdentifier(protocolClass)
        return lock.withLock { bindings.first { ObjectIdentifier($0.protocolClass) == id }?.forwarding }
    }

    /// The configuration the app session is really created with (a copy; the app's object is not
    /// changed). Unchanged when it carries no Dürbün protocol class.
    static func bind(_ configuration: URLSessionConfiguration) -> URLSessionConfiguration {
        guard let classes = configuration.protocolClasses, classes.contains(where: isDurbun),
              let inner = configuration.copy() as? URLSessionConfiguration,
              let outer = configuration.copy() as? URLSessionConfiguration
        else { return configuration }
        let others = withoutDurbun(classes)
        inner.protocolClasses = others
        guard let bound = protocolClass(for: inner) else {
            outer.protocolClasses = others
            return outer
        }
        var replaced = false
        outer.protocolClasses = classes.compactMap { cls -> AnyClass? in
            guard isDurbun(cls) else { return cls }
            if replaced { return nil }
            replaced = true
            return bound
        }
        return outer
    }

    private static func protocolClass(for inner: URLSessionConfiguration) -> AnyClass? {
        let key = SettingsKey(inner)
        return lock.withLock { () -> AnyClass? in
            if let existing = bindings.first(where: { $0.key == key }) { return existing.protocolClass }
            guard bindings.count < maxBindings else {
                if !limitNoted {
                    limitNoted = true
                    Diagnostics.info("Dürbün: more than \(maxBindings) distinct URLSession configurations; new sessions are not captured.")
                }
                return nil
            }
            guard let subclass = makeSubclass() else { return nil }
            bindings.append(Binding(key: key, protocolClass: subclass, forwarding: ForwardingSession(configuration: inner)))
            return subclass
        }
    }

    /// A subclass that only differs from `DurbunURLProtocol` by identity. Runs under `lock`.
    private static func makeSubclass() -> AnyClass? {
        while serial < 10_000 {
            serial += 1
            let name = "DurbunURLProtocol_Session\(serial)"
            if objc_getClass(name) != nil { continue }
            guard let cls = objc_allocateClassPair(DurbunURLProtocol.self, name, 0) else { return nil }
            objc_registerClassPair(cls)
            return cls
        }
        return nil
    }
}

/// The settings that make two configurations behave differently for a request. Storage objects are
/// compared by identity (the binding keeps them alive through its configuration copy).
private struct SettingsKey: Equatable {
    let cache: ObjectIdentifier?
    let cookies: ObjectIdentifier?
    let credentials: ObjectIdentifier?
    let protocols: [ObjectIdentifier]
    let values: [String]

    init(_ c: URLSessionConfiguration) {
        cache = c.urlCache.map { ObjectIdentifier($0) }
        cookies = c.httpCookieStorage.map { ObjectIdentifier($0) }
        credentials = c.urlCredentialStorage.map { ObjectIdentifier($0) }
        protocols = (c.protocolClasses ?? []).map { ObjectIdentifier($0) }
        var values: [String] = [
            "cache:\(c.requestCachePolicy.rawValue)",
            "cookies:\(c.httpCookieAcceptPolicy.rawValue):\(c.httpShouldSetCookies)",
            "pipelining:\(c.httpShouldUsePipelining)",
            "connections:\(c.httpMaximumConnectionsPerHost)",
            "cellular:\(c.allowsCellularAccess)",
            "expensive:\(c.allowsExpensiveNetworkAccess)",
            "constrained:\(c.allowsConstrainedNetworkAccess)",
            "waits:\(c.waitsForConnectivity)",
            "discretionary:\(c.isDiscretionary)",
            "service:\(c.networkServiceType.rawValue)",
            "tls:\(c.tlsMinimumSupportedProtocolVersion.rawValue)-\(c.tlsMaximumSupportedProtocolVersion.rawValue)",
            "idle:\(c.shouldUseExtendedBackgroundIdleMode)",
            "proxy:\(Self.describe(c.connectionProxyDictionary))",
            "headers:\(Self.describe(c.httpAdditionalHeaders))",
        ]
        if #available(iOS 16.0, macOS 13.0, tvOS 16.0, watchOS 9.0, *) {
            values.append("dnssec:\(c.requiresDNSSECValidation)")
        }
        self.values = values
    }

    private static func describe(_ dictionary: [AnyHashable: Any]?) -> String {
        guard let dictionary else { return "-" }
        return dictionary.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: ";")
    }
}
