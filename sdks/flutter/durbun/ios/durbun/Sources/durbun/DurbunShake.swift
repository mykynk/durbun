// Shake to open the in-app inspector on iOS. Uses the system shake gesture (the same one
// "Device → Shake" sends in the simulator): UIWindow's motionEnded is extended once, and the
// event reaches Dart only while Dart listens (an inspector is mounted, the app in front).
// No motion permission is needed and nothing runs while nobody listens.
import Flutter
import UIKit

final class DurbunShake: NSObject {
    static let channelName = "dev.durbun/shake"
    static let notification = Notification.Name("dev.durbun.shake")

    private let channel: FlutterMethodChannel
    private var observer: NSObjectProtocol?
    private var lastShake = Date.distantPast

    init(messenger: FlutterBinaryMessenger) {
        channel = FlutterMethodChannel(name: Self.channelName, binaryMessenger: messenger)
        super.init()
        channel.setMethodCallHandler { [weak self] call, result in
            guard call.method == "listen" else { return result(FlutterMethodNotImplemented) }
            if (call.arguments as? Bool) == true { self?.start() } else { self?.stop() }
            result(call.arguments as? Bool == true)
        }
    }

    private func start() {
        guard observer == nil else { return }
        UIWindow.durbunInstallShakeHook()
        observer = NotificationCenter.default.addObserver(forName: Self.notification, object: nil, queue: .main) { [weak self] _ in
            guard let self else { return }
            // One gesture, one panel (a shake can repeat while the phone keeps moving).
            if Date().timeIntervalSince(self.lastShake) < 1.5 { return }
            self.lastShake = Date()
            self.channel.invokeMethod("shake", arguments: nil)
        }
    }

    func stop() {
        if let observer { NotificationCenter.default.removeObserver(observer) }
        observer = nil
    }

    func detach() {
        stop()
        channel.setMethodCallHandler(nil)
    }
}

extension UIWindow {
    private static var durbunHookInstalled = false

    /// Adds the shake hook to `motionEnded(_:with:)` once; the original behaviour is kept.
    ///
    /// The original implementation is called with its own selector: UIResponder's version
    /// forwards the event to the next responder with the selector it was called with, and a
    /// swapped `durbun_…` selector made the window scene raise "unrecognized selector".
    static func durbunInstallShakeHook() {
        guard !durbunHookInstalled else { return }
        durbunHookInstalled = true
        let selector = #selector(UIResponder.motionEnded(_:with:))
        guard let method = class_getInstanceMethod(UIWindow.self, selector) else { return }
        typealias MotionEnded = @convention(c) (UIWindow, Selector, UIEvent.EventSubtype, UIEvent?) -> Void
        let original = unsafeBitCast(method_getImplementation(method), to: MotionEnded.self)
        let hook: @convention(block) (UIWindow, UIEvent.EventSubtype, UIEvent?) -> Void = { window, motion, event in
            if motion == .motionShake {
                NotificationCenter.default.post(name: DurbunShake.notification, object: nil)
            }
            original(window, selector, motion, event)
        }
        let imp = imp_implementationWithBlock(hook)
        // UIWindow usually inherits motionEnded: override it on UIWindow only; if UIWindow
        // has its own, replace that (its old implementation is `original`).
        if !class_addMethod(UIWindow.self, selector, imp, method_getTypeEncoding(method)) {
            method_setImplementation(method, imp)
        }
    }
}
