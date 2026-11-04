// iOS side of package:durbun. Registering the plugin does nothing by itself: no hook, no socket.
// The Dart SDK starts the native core (Core/, a copy of sdks/ios/Sources/Durbun) over the method
// channel only when it runs (debug/profile, or a release built with --dart-define=DURBUN=true).
// From then on URLSession traffic, native crashes, stdout/stderr and Swift `Durbun.log` calls are
// reported through the Dart side's single desktop connection (one app session), and the desktop
// state (config, mock rules) and native commands (ios.* tools) arrive from Dart. The app's own
// os_log / Logger / NSLog lines (iOS 15+) go to Dart as `deviceLogs` while Dart asks for them: the
// in-app panel shows them, and Dart sends them on only when the desktop cannot read device logs.
import Flutter
import Foundation
import LinkPresentation
import UIKit

public final class DurbunFlutterPlugin: NSObject, FlutterPlugin {
    static let channelName = "dev.durbun/native"

    private static let ownerLock = NSLock()
    /// The plugin instance (engine) whose Dart side owns the hosted core.
    private static weak var owner: DurbunFlutterPlugin?

    private let channel: FlutterMethodChannel
    private var shake: DurbunShake?
    private var link: ChannelLink?
    private var attached = true

    init(channel: FlutterMethodChannel) {
        self.channel = channel
    }

    public static func register(with registrar: FlutterPluginRegistrar) {
        let channel = FlutterMethodChannel(name: channelName, binaryMessenger: registrar.messenger())
        let instance = DurbunFlutterPlugin(channel: channel)
        instance.shake = DurbunShake(messenger: registrar.messenger())
        registrar.addMethodCallDelegate(instance, channel: channel)
    }

    public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
        attached = false
        shake?.detach()
        shake = nil
        stopHosted()
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        switch call.method {
        case "start":
            result(start(call.arguments as? String))
        case "state":
            if isOwner, let json = call.arguments as? String { DurbunCore.shared.applyHostState(json) }
            result(nil)
        case "command":
            if isOwner, let json = call.arguments as? String { DurbunCore.shared.handleHostCommand(json) }
            result(nil)
        case "stop":
            stopHosted()
            result(nil)
        case "share":
            // The in-app panel's "Share…": the system share sheet with the report text.
            let args = call.arguments as? [String: Any]
            result(share(text: args?["text"] as? String, subject: args?["subject"] as? String))
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    /// Presents the system share sheet; false when there is no screen to present it from.
    private func share(text: String?, subject: String?) -> Bool {
        guard let text, !text.isEmpty, let top = Self.topViewController() else { return false }
        let sheet = UIActivityViewController(activityItems: [ShareText(text: text, subject: subject ?? "")],
                                             applicationActivities: nil)
        if let popover = sheet.popoverPresentationController {
            // iPad shows the sheet as a popover: anchor it at the bottom centre, without an arrow.
            popover.sourceView = top.view
            popover.sourceRect = CGRect(x: top.view.bounds.midX, y: top.view.bounds.maxY - 1, width: 1, height: 1)
            popover.permittedArrowDirections = []
        }
        top.present(sheet, animated: true)
        return true
    }

    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let active = scenes.filter { $0.activationState == .foregroundActive }
        let windows = (active.isEmpty ? scenes : active).flatMap(\.windows)
        var top = (windows.first(where: \.isKeyWindow) ?? windows.first)?.rootViewController
        while let presented = top?.presentedViewController, !presented.isBeingDismissed {
            top = presented
        }
        return top
    }

    private var isOwner: Bool {
        Self.ownerLock.lock()
        defer { Self.ownerLock.unlock() }
        return Self.owner === self
    }

    /// Starts (or, after a hot restart, restarts) the hosted core; returns the JSON reply for Dart.
    private func start(_ argsJSON: String?) -> String {
        let args = argsJSON.flatMap { $0.data(using: .utf8) }
            .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
        let opts = args["options"] as? [String: Any] ?? [:]

        Self.ownerLock.lock()
        if let current = Self.owner, current !== self, current.attached {
            Self.ownerLock.unlock()
            return Self.encode(["attached": false, "platform": "ios",
                                "reason": "another Flutter engine in this process already runs Dürbün"])
        }
        Self.ownerLock.unlock()

        // Hot restart (same engine, new Dart isolate) or a second start: begin a fresh native session.
        stopHosted()

        let captureNetwork = opts["captureNetwork"] as? Bool ?? true
        let captureCrashes = opts["captureErrors"] as? Bool ?? true
        let options = DurbunOptions(
            captureStdout: (opts["capturePrint"] as? String) != "never",
            captureNetwork: captureNetwork,
            captureCrashes: captureCrashes,
            // Flutter reports frames and memory itself.
            collectMetrics: false,
            maxBufferedMessages: (opts["maxBufferedMessages"] as? Int) ?? 5000,
            // Dart already decided that Dürbün runs in this build (release only with DURBUN=true).
            allowInReleaseBuilds: true
        )
        let redacted = Set((opts["redactHeaders"] as? [Any] ?? []).compactMap { ($0 as? String)?.lowercased() })
        let link = ChannelLink(channel: channel)
        let core = DurbunCore.shared
        guard core.startHosted(options: options, link: link, redactedHeaders: redacted) else {
            return Self.encode(["attached": false, "platform": "ios", "reason": "the native layer is disabled"])
        }
        self.link = link
        Self.ownerLock.lock()
        Self.owner = self
        Self.ownerLock.unlock()
        if let state = args["state"],
           let data = try? JSONSerialization.data(withJSONObject: state),
           let json = String(data: data, encoding: .utf8)
        {
            core.applyHostState(json)
        }

        let actions = core.describeActionsJSON().data(using: .utf8)
            .flatMap { try? JSONSerialization.jsonObject(with: $0) } ?? []
        var reply: [String: Any] = [
            "attached": true,
            "platform": "ios",
            "sdk": ["name": "durbun-ios", "version": Durbun.version],
            "capabilities": core.hostedCapabilities(options: options),
            "actions": actions,
            "commands": [String](),
            "app": core.hostedAppInfo,
            "urlSession": captureNetwork,
        ]
        // This app's own os_log lines, read while Dart asks for them (`state.deviceLogs.read`; iOS 15+).
        if options.captureStdout && OSLogCapture.isAvailable { reply["deviceLogs"] = "os_log" }
        return Self.encode(reply)
    }

    private func stopHosted() {
        Self.ownerLock.lock()
        let wasOwner = Self.owner === self
        if wasOwner { Self.owner = nil }
        Self.ownerLock.unlock()
        guard wasOwner else { return }
        link = nil
        DurbunCore.shared.stop()
    }

    private static func encode(_ object: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: object),
              let text = String(data: data, encoding: .utf8)
        else { return "{\"attached\":false}" }
        return text
    }
}

/// Hands native messages to Dart on the main thread (Flutter channels are main-thread only).
final class ChannelLink: HostLink {
    private weak var channel: FlutterMethodChannel?

    init(channel: FlutterMethodChannel) {
        self.channel = channel
    }

    func deliver(_ lines: [String]) {
        DispatchQueue.main.async { [weak self] in
            self?.channel?.invokeMethod("events", arguments: lines)
        }
    }

    func deliverDeviceLogs(_ lines: [String]) {
        DispatchQueue.main.async { [weak self] in
            self?.channel?.invokeMethod("deviceLogs", arguments: lines)
        }
    }

    func actionsChanged(_ descriptorsJSON: String) {
        DispatchQueue.main.async { [weak self] in
            self?.channel?.invokeMethod("actions", arguments: descriptorsJSON)
        }
    }

    func flush(timeout: TimeInterval) -> Bool {
        // The answer comes on the main thread: waiting there would deadlock.
        if Thread.isMainThread { return false }
        let done = DispatchSemaphore(value: 0)
        let outcome = FlushOutcome()
        DispatchQueue.main.async { [weak self] in
            guard let channel = self?.channel else {
                done.signal()
                return
            }
            channel.invokeMethod("flush", arguments: nil) { reply in
                outcome.set((reply as? Bool) == true)
                done.signal()
            }
        }
        _ = done.wait(timeout: .now() + timeout)
        return outcome.value
    }
}

private final class FlushOutcome {
    private let lock = NSLock()
    private var ok = false

    func set(_ value: Bool) {
        lock.lock()
        ok = value
        lock.unlock()
    }

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return ok
    }
}

/// The share sheet's text, with a subject for Mail and similar targets.
private final class ShareText: NSObject, UIActivityItemSource {
    private let text: String
    private let subject: String

    init(text: String, subject: String) {
        self.text = text
        self.subject = subject
    }

    func activityViewControllerPlaceholderItem(_ activityViewController: UIActivityViewController) -> Any {
        text
    }

    func activityViewController(_ activityViewController: UIActivityViewController,
                                itemForActivityType activityType: UIActivity.ActivityType?) -> Any? {
        text
    }

    func activityViewController(_ activityViewController: UIActivityViewController,
                                subjectForActivityType activityType: UIActivity.ActivityType?) -> String {
        subject
    }

    /// The sheet's header: "POST /v1/login → 401" instead of a blank icon.
    func activityViewControllerLinkMetadata(_ activityViewController: UIActivityViewController) -> LPLinkMetadata? {
        guard !subject.isEmpty else { return nil }
        let metadata = LPLinkMetadata()
        metadata.title = subject
        return metadata
    }
}
