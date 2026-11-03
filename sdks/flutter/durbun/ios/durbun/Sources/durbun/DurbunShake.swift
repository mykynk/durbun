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
    static func durbunInstallShakeHook() {
        guard !durbunHookInstalled else { return }
        durbunHookInstalled = true
        let original = #selector(UIResponder.motionEnded(_:with:))
        let replacement = #selector(UIWindow.durbun_motionEnded(_:with:))
        guard let originalMethod = class_getInstanceMethod(UIWindow.self, original),
              let replacementMethod = class_getInstanceMethod(UIWindow.self, replacement) else { return }
        if class_addMethod(UIWindow.self, original, method_getImplementation(replacementMethod), method_getTypeEncoding(replacementMethod)) {
            class_replaceMethod(UIWindow.self, replacement, method_getImplementation(originalMethod), method_getTypeEncoding(originalMethod))
        } else {
            method_exchangeImplementations(originalMethod, replacementMethod)
        }
    }

    @objc func durbun_motionEnded(_ motion: UIEvent.EventSubtype, with event: UIEvent?) {
        if motion == .motionShake {
            NotificationCenter.default.post(name: DurbunShake.notification, object: nil)
        }
        // After the swap this calls the original implementation.
        durbun_motionEnded(motion, with: event)
    }
}
