import Foundation
#if canImport(UIKit) && !os(watchOS)
import UIKit
#endif

/// Cold-start time as Dürbün reports it (event `durbun.launch`): from the process start to the first frame after
/// the app first became active. Nothing is sent when the number would not describe a launch: Dürbün started long
/// after the process (it did not see the launch), the app was launched in the background (a push, a background
/// fetch) or went to the background before its first frame, or the first frame came implausibly late. A prewarmed
/// launch (iOS 15+ may start the process before the user opens the app) is sent as `kind: "prewarmed"` without a
/// duration: its process start says nothing about how long the user waited.
enum LaunchTiming {
    static let event = "durbun.launch"

    /// Dürbün started later than this after the process: the launch was over before it looked.
    static let maxStartAgeMs: Double = 10_000

    /// A first frame later than this is not a launch the user waited for.
    static let maxLaunchMs: Double = 30_000

    static func props(
        processStartMs: Double?,
        sdkStartMs: Double,
        firstFrameMs: Double,
        prewarmed: Bool,
        screen: String?
    ) -> [String: Any]? {
        if prewarmed { return ["kind": "prewarmed", "to": "firstFrame"] }
        guard let processStartMs, processStartMs > 0, sdkStartMs >= processStartMs, firstFrameMs >= sdkStartMs else {
            return nil
        }
        guard sdkStartMs - processStartMs <= maxStartAgeMs else { return nil }
        let ms = (firstFrameMs - processStartMs).rounded()
        guard ms <= maxLaunchMs else { return nil }
        var props: [String: Any] = ["kind": "cold", "ms": Int(ms), "to": "firstFrame", "from": "processStart"]
        if let screen, !screen.isEmpty { props["screen"] = screen }
        return props
    }

    /// The process start (wall clock, ms since 1970) from the kernel's process table.
    static func processStartMs() -> Double? {
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let result = mib.withUnsafeMutableBufferPointer { sysctl($0.baseAddress, u_int($0.count), &info, &size, nil, 0) }
        guard result == 0 else { return nil }
        let start = info.kp_proc.p_un.__p_starttime
        let ms = Double(start.tv_sec) * 1000 + Double(start.tv_usec) / 1000
        return ms > 0 ? ms : nil
    }

    /// iOS sets `ActivePrewarm=1` in the environment of a process it started ahead of the user's tap.
    static func isPrewarmed(_ environment: [String: String] = ProcessInfo.processInfo.environment) -> Bool {
        environment["ActivePrewarm"] == "1"
    }
}

#if canImport(UIKit) && !os(watchOS)
/// Watches one launch: the first `didBecomeActive`, then the next display refresh (the first frame is on screen).
/// Runs only when Dürbün starts with metrics on; everything after `init` happens on the main thread.
final class LaunchTimer {
    private let report: ([String: Any]) -> Void
    private let sdkStartMs = Clock.nowMs()
    private let processStartMs = LaunchTiming.processStartMs()
    private let prewarmed = LaunchTiming.isPrewarmed()
    private let lock = NSLock()
    private var observers: [NSObjectProtocol] = []
    private var finished = false
    private var link: CADisplayLink?

    init(report: @escaping ([String: Any]) -> Void) {
        self.report = report
        if !prewarmed {
            guard let start = processStartMs, sdkStartMs - start <= LaunchTiming.maxStartAgeMs else {
                finished = true
                return
            }
        }
        let center = NotificationCenter.default
        let active = center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.becameActive()
        }
        let background = center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.finish()
        }
        lock.withLock { observers = [active, background] }
        DispatchQueue.main.async { [weak self] in self?.checkLaunchedInBackground() }
    }

    func stop() {
        if Thread.isMainThread {
            finish()
        } else {
            DispatchQueue.main.async { [self] in finish() }
        }
    }

    private var isFinished: Bool { lock.withLock { finished } }

    /// A process started for a push or a background fetch is not a launch the user saw.
    private func checkLaunchedInBackground() {
        guard !isFinished else { return }
        let state = MainActor.assumeIsolated { UIKitTools.application()?.applicationState }
        if state == nil || state == .background { finish() }
    }

    private func becameActive() {
        guard !isFinished, link == nil else { return }
        let link = CADisplayLink(target: LaunchLinkProxy(self), selector: #selector(LaunchLinkProxy.tick(_:)))
        link.add(to: .main, forMode: .common)
        self.link = link
    }

    fileprivate func firstFrame() {
        guard !isFinished else { return }
        let screen = MainActor.assumeIsolated { () -> String? in
            let windows = UIKitTools.windows()
            let window = windows.first(where: { $0.isKeyWindow }) ?? windows.first
            return window?.rootViewController.map { String(describing: type(of: $0)) }
        }
        let props = LaunchTiming.props(
            processStartMs: processStartMs,
            sdkStartMs: sdkStartMs,
            firstFrameMs: Clock.nowMs(),
            prewarmed: prewarmed,
            screen: screen
        )
        finish()
        if let props { report(props) }
    }

    private func finish() {
        let observers: [NSObjectProtocol] = lock.withLock {
            finished = true
            defer { self.observers = [] }
            return self.observers
        }
        observers.forEach(NotificationCenter.default.removeObserver)
        link?.invalidate()
        link = nil
    }
}

/// CADisplayLink retains its target; the proxy keeps the timer free of that cycle.
private final class LaunchLinkProxy: NSObject {
    private weak var timer: LaunchTimer?

    init(_ timer: LaunchTimer) {
        self.timer = timer
    }

    @objc func tick(_ link: CADisplayLink) {
        guard let timer else {
            link.invalidate()
            return
        }
        timer.firstFrame()
    }
}
#endif
