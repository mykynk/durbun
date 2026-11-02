import Foundation

/// Executes `command` messages (capability `commands`) and describes the available app actions
/// (`hello.actions` / `actions` updates). Built-in iOS tools plus actions registered by the app.
/// Unknown commands answer `ok: false`.
final class CommandCenter {
    struct Result: Sendable {
        var ok: Bool
        var data: JSONValue?
        var error: String?

        static func success(_ data: JSONValue? = nil) -> Result { Result(ok: true, data: data, error: nil) }
        static func failure(_ message: String) -> Result { Result(ok: false, data: nil, error: message) }
    }

    private struct CustomAction {
        var action: DurbunAction
        var value: JSONValue?
        var handler: @MainActor ([String: Any]) throws -> Any?
    }

    private let lock = UnfairLock()
    private var custom: [String: CustomAction] = [:]
    private var order: [String] = []
    private let builtins: BuiltinActions

    /// Called whenever the descriptor list or a value changed (sends an `actions` update).
    var onChange: (() -> Void)?

    init(builtins: BuiltinActions = BuiltinActions()) {
        self.builtins = builtins
    }

    func register(_ action: DurbunAction, handler: @escaping @MainActor ([String: Any]) throws -> Any?) {
        let initial: JSONValue?
        switch action.kind {
        case .button: initial = nil
        case let .toggle(value): initial = .bool(value)
        case let .select(_, value): initial = value.map(JSONValue.string)
        }
        lock.withLock {
            if custom[action.id] == nil { order.append(action.id) }
            custom[action.id] = CustomAction(action: action, value: initial, handler: handler)
        }
        onChange?()
    }

    func remove(id: String) {
        let removed: Bool = lock.withLock {
            guard custom.removeValue(forKey: id) != nil else { return false }
            order.removeAll { $0 == id }
            return true
        }
        if removed { onChange?() }
    }

    func descriptors() -> [WireActionDescriptor] {
        let customDescriptors: [WireActionDescriptor] = lock.withLock {
            order.compactMap { id in
                guard let entry = custom[id] else { return nil }
                return Self.descriptor(for: entry.action, value: entry.value)
            }
        }
        return builtins.descriptors() + customDescriptors
    }

    /// Runs a command; `completion` may be called on any thread.
    func handle(name: String, params: [String: Any], completion: @escaping (Result) -> Void) {
        if builtins.handles(name) {
            builtins.run(name, params: params) { result in
                completion(result)
                if result.ok && self.builtins.changesState(name) { self.onChange?() }
            }
            return
        }
        guard let entry = lock.withLock({ custom[name] }) else {
            completion(.failure("Unknown command '\(name)'"))
            return
        }
        // App handlers usually touch UI or app state: run them on the main thread.
        DispatchQueue.main.async {
            let result: Result = MainActor.assumeIsolated {
                do {
                    let output = try entry.handler(params)
                    return .success(output.map { JSONConversion.value(from: $0) })
                } catch {
                    return .failure(JSONConversion.describe(error))
                }
            }
            completion(result)
            if result.ok, let newValue = Self.newValue(for: entry.action, params: params) {
                self.lock.withLock { self.custom[name]?.value = newValue }
                self.onChange?()
            }
        }
    }

    /// The new state of a toggle/select after a successful command (`params.value`).
    static func newValue(for action: DurbunAction, params: [String: Any]) -> JSONValue? {
        switch action.kind {
        case .button:
            return nil
        case .toggle:
            return (BuiltinActions.boolParam(params)).map(JSONValue.bool)
        case .select:
            return (params["value"] as? String).map(JSONValue.string)
        }
    }

    static func descriptor(for action: DurbunAction, value: JSONValue?) -> WireActionDescriptor {
        switch action.kind {
        case .button:
            return WireActionDescriptor(id: action.id, kind: "button", label: action.label, group: action.group ?? "app")
        case .toggle:
            return WireActionDescriptor(id: action.id, kind: "toggle", label: action.label, group: action.group ?? "app", value: value)
        case let .select(options, _):
            return WireActionDescriptor(
                id: action.id,
                kind: "select",
                label: action.label,
                group: action.group ?? "app",
                options: options.map { (value: $0.value, label: $0.label) },
                value: value
            )
        }
    }
}
