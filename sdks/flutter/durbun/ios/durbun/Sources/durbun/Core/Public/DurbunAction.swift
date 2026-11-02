import Foundation

/// A custom tool shown for your app in Dürbün's device panel (button, toggle or picker).
///
/// ```swift
/// Durbun.registerAction(DurbunAction(id: "app.clearCache", label: "Clear image cache")) { _ in
///     ImageCache.shared.removeAll()
///     return nil
/// }
/// Durbun.registerAction(DurbunAction(id: "app.mockLogin", label: "Mock login", kind: .toggle(false))) { params in
///     FeatureFlags.mockLogin = params["value"] as? Bool ?? false
///     return nil
/// }
/// ```
public struct DurbunAction: Sendable {
    public struct Option: Sendable {
        public let value: String
        public let label: String

        public init(value: String, label: String) {
            self.value = value
            self.label = label
        }
    }

    public enum Kind: Sendable {
        case button
        /// A switch with its initial state. The handler receives `params["value"]` as `Bool`.
        case toggle(Bool)
        /// A picker with its initial value. The handler receives `params["value"]` as `String`.
        case select(options: [Option], value: String?)
    }

    /// Unique id, e.g. `"app.clearCache"`. Ids starting with `ios.` are reserved for built-in tools.
    public let id: String
    public let label: String
    /// Optional group name used by the desktop to cluster tools (default "app").
    public let group: String?
    public let kind: Kind

    public init(id: String, label: String, group: String? = nil, kind: Kind = .button) {
        self.id = id
        self.label = label
        self.group = group
        self.kind = kind
    }
}

/// Error type a custom action handler can throw to report a readable failure message.
public struct DurbunActionError: Error, CustomStringConvertible, Sendable {
    public let message: String

    public init(_ message: String) {
        self.message = message
    }

    public var description: String { message }
}
