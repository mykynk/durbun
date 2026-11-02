import Foundation
#if canImport(UIKit) && !os(watchOS)
import UIKit
#endif

/// Built-in debug tools advertised to the desktop (iOS only; empty on macOS):
/// appearance override, slow animations, view hierarchy dump and UserDefaults dump.
final class BuiltinActions {
    static let appearance = "ios.appearance"
    static let slowAnimations = "ios.slowAnimations"
    static let dumpViewHierarchy = "ios.dumpViewHierarchy"
    static let dumpUserDefaults = "ios.dumpUserDefaults"

    /// Sends a log line on behalf of a tool (message, tag, data).
    var log: ((String, String, JSONValue?) -> Void)?

    private let lock = UnfairLock()
    private var appearanceValue = "system"
    private var slowAnimationsValue = false

    static var isSupported: Bool {
        #if canImport(UIKit) && !os(watchOS)
        return true
        #else
        return false
        #endif
    }

    func descriptors() -> [WireActionDescriptor] {
        guard Self.isSupported else { return [] }
        let (appearance, slow) = lock.withLock { (appearanceValue, slowAnimationsValue) }
        return [
            WireActionDescriptor(
                id: Self.appearance,
                kind: "select",
                label: "Appearance",
                group: "ios",
                options: [(value: "system", label: "System"), (value: "light", label: "Light"), (value: "dark", label: "Dark")],
                value: .string(appearance)
            ),
            WireActionDescriptor(id: Self.slowAnimations, kind: "toggle", label: "Slow animations", group: "ios", value: .bool(slow)),
            WireActionDescriptor(id: Self.dumpViewHierarchy, kind: "button", label: "Dump view hierarchy", group: "ios"),
            WireActionDescriptor(id: Self.dumpUserDefaults, kind: "button", label: "Dump UserDefaults", group: "ios"),
        ]
    }

    func handles(_ name: String) -> Bool {
        Self.isSupported && [Self.appearance, Self.slowAnimations, Self.dumpViewHierarchy, Self.dumpUserDefaults].contains(name)
    }

    func changesState(_ name: String) -> Bool {
        name == Self.appearance || name == Self.slowAnimations
    }

    /// Accepts `{ value: Bool }` or `{ enabled: Bool }`.
    static func boolParam(_ params: [String: Any]) -> Bool? {
        for key in ["value", "enabled"] {
            if let number = params[key] as? NSNumber { return number.boolValue }
            if let text = params[key] as? String { return ["true", "1", "on", "yes"].contains(text.lowercased()) }
        }
        return nil
    }

    func run(_ name: String, params: [String: Any], completion: @escaping (CommandCenter.Result) -> Void) {
        #if canImport(UIKit) && !os(watchOS)
        switch name {
        case Self.appearance:
            let mode = (params["value"] as? String ?? params["mode"] as? String ?? "system").lowercased()
            guard ["system", "light", "dark"].contains(mode) else {
                completion(.failure("Unknown appearance '\(mode)' (use system, light or dark)"))
                return
            }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { UIKitTools.setAppearance(mode) }
                self.lock.withLock { self.appearanceValue = mode }
                completion(.success(.string(mode)))
            }
        case Self.slowAnimations:
            guard let enabled = Self.boolParam(params) else {
                completion(.failure("Missing boolean 'value'"))
                return
            }
            DispatchQueue.main.async {
                MainActor.assumeIsolated { UIKitTools.setSlowAnimations(enabled) }
                self.lock.withLock { self.slowAnimationsValue = enabled }
                completion(.success(.bool(enabled)))
            }
        case Self.dumpViewHierarchy:
            DispatchQueue.main.async {
                let dump = MainActor.assumeIsolated { UIKitTools.viewHierarchy() }
                var data = JSONObjectBuilder()
                data.set("windows", dump.windows)
                data.set("views", dump.views)
                self.log?("View hierarchy — \(dump.views) views in \(dump.windows) windows\n" + dump.text, "ui", data.value)
                completion(.success(data.value))
            }
        case Self.dumpUserDefaults:
            let domain = Bundle.main.bundleIdentifier.flatMap { UserDefaults.standard.persistentDomain(forName: $0) } ?? [:]
            let values = JSONConversion.object(from: domain)
            log?("UserDefaults — \(domain.count) keys", "userdefaults", values)
            completion(.success(values))
        default:
            completion(.failure("Unknown command '\(name)'"))
        }
        #else
        completion(.failure("Unknown command '\(name)'"))
        #endif
    }
}

#if canImport(UIKit) && !os(watchOS)
@MainActor
enum UIKitTools {
    /// `UIApplication.shared` without the compile-time "unavailable in app extensions" error.
    static func application() -> UIApplication? {
        UIApplication.perform(NSSelectorFromString("sharedApplication"))?.takeUnretainedValue() as? UIApplication
    }

    static func windows() -> [UIWindow] {
        guard let application = application() else { return [] }
        return application.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    }

    static func setAppearance(_ mode: String) {
        let style: UIUserInterfaceStyle = mode == "dark" ? .dark : mode == "light" ? .light : .unspecified
        for window in windows() { window.overrideUserInterfaceStyle = style }
    }

    static func setSlowAnimations(_ enabled: Bool) {
        for window in windows() { window.layer.speed = enabled ? 0.1 : 1 }
    }

    static func viewHierarchy() -> (text: String, windows: Int, views: Int) {
        var lines: [String] = []
        var count = 0
        let windows = windows()
        for window in windows { describe(window, depth: 0, lines: &lines, count: &count) }
        if count >= 5000 { lines.append("… (truncated at 5000 views)") }
        return (lines.joined(separator: "\n"), windows.count, count)
    }

    private static func describe(_ view: UIView, depth: Int, lines: inout [String], count: inout Int) {
        guard count < 5000 else { return }
        count += 1
        let f = view.frame
        var parts = [
            String(describing: type(of: view)),
            "(\(Int(f.origin.x)) \(Int(f.origin.y)); \(Int(f.size.width))×\(Int(f.size.height)))",
        ]
        if view.isHidden { parts.append("hidden") }
        if view.alpha < 1 { parts.append("alpha=\((view.alpha * 100).rounded() / 100)") }
        if let id = view.accessibilityIdentifier, !id.isEmpty { parts.append("id=\"\(id)\"") }
        if let label = view as? UILabel, let text = label.text, !text.isEmpty { parts.append("text=\"\(text.prefix(40))\"") }
        if let controller = view.next as? UIViewController { parts.append("← \(type(of: controller))") }
        lines.append(String(repeating: "  ", count: depth) + parts.joined(separator: " "))
        for subview in view.subviews { describe(subview, depth: depth + 1, lines: &lines, count: &count) }
    }
}
#endif
