import Darwin
import Foundation
#if canImport(UIKit) && !os(watchOS)
import QuartzCore
import UIKit
#endif

/// Process-level samples via Mach APIs.
enum ProcessMetrics {
    /// `phys_footprint` (what Xcode's memory gauge and jetsam use), in MB.
    static func memoryFootprintMB() -> Double? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return round2(Double(info.phys_footprint) / 1_048_576)
    }

    /// Sum of `thread_basic_info.cpu_usage` over non-idle threads (percent of one core) and the
    /// thread count.
    static func cpuUsage() -> (percent: Double, threads: Int)? {
        var threadList: thread_act_array_t?
        var threadCount: mach_msg_type_number_t = 0
        guard task_threads(mach_task_self_, &threadList, &threadCount) == KERN_SUCCESS, let threads = threadList else {
            return nil
        }
        defer {
            let size = vm_size_t(Int(threadCount) * MemoryLayout<thread_t>.stride)
            vm_deallocate(mach_task_self_, vm_address_t(UInt(bitPattern: threads)), size)
        }
        var total = 0.0
        let infoCount = mach_msg_type_number_t(MemoryLayout<thread_basic_info_data_t>.size / MemoryLayout<integer_t>.size)
        for index in 0..<Int(threadCount) {
            var info = thread_basic_info_data_t()
            var count = infoCount
            let result = withUnsafeMutablePointer(to: &info) { pointer in
                pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                    thread_info(threads[index], thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
                }
            }
            if result == KERN_SUCCESS && (info.flags & TH_FLAGS_IDLE) == 0 {
                total += Double(info.cpu_usage) / Double(TH_USAGE_SCALE) * 100
            }
            mach_port_deallocate(mach_task_self_, threads[index])
        }
        return (round2(total), Int(threadCount))
    }

    static func round2(_ value: Double) -> Double {
        (value * 100).rounded() / 100
    }
}

/// Counts rendered frames and janky frames with a `CADisplayLink` on the main run loop (iOS only).
/// The display-link callback only bumps counters under a lock; sampling happens off the main thread.
final class FrameMonitor {
    struct Sample {
        var fps: Double
        var jankyFrames: Int
    }

    private let lock = UnfairLock()
    private var frames = 0
    private var janky = 0
    private var lastTimestamp: CFTimeInterval = 0
    private var windowStart: CFTimeInterval = 0
    private var running = false
    #if canImport(UIKit) && !os(watchOS)
    private var link: CADisplayLink?
    #endif

    static var isSupported: Bool {
        #if canImport(UIKit) && !os(watchOS)
        return true
        #else
        return false
        #endif
    }

    func start() {
        #if canImport(UIKit) && !os(watchOS)
        DispatchQueue.main.async {
            guard self.link == nil else { return }
            let link = CADisplayLink(target: DisplayLinkProxy(self), selector: #selector(DisplayLinkProxy.tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
            self.lock.withLock {
                self.running = true
                self.frames = 0
                self.janky = 0
                self.lastTimestamp = 0
                self.windowStart = CACurrentMediaTime()
            }
        }
        #endif
    }

    func stop() {
        #if canImport(UIKit) && !os(watchOS)
        DispatchQueue.main.async {
            self.link?.invalidate()
            self.link = nil
            self.lock.withLock { self.running = false }
        }
        #endif
    }

    /// FPS and janky frames since the previous sample; nil when no frame was rendered (background).
    func takeSample() -> Sample? {
        #if canImport(UIKit) && !os(watchOS)
        let now = CACurrentMediaTime()
        return lock.withLock {
            guard running else { return nil }
            defer {
                frames = 0
                janky = 0
                windowStart = now
            }
            let elapsed = now - windowStart
            guard frames > 0, elapsed > 0 else { return nil }
            return Sample(fps: ProcessMetrics.round2(min(Double(frames) / elapsed, 240)), jankyFrames: janky)
        }
        #else
        return nil
        #endif
    }

    #if canImport(UIKit) && !os(watchOS)
    /// Main thread.
    fileprivate func tick(_ link: CADisplayLink) {
        let timestamp = link.timestamp
        var expected = link.targetTimestamp - link.timestamp
        if expected <= 0 { expected = link.duration > 0 ? link.duration : 1.0 / 60 }
        lock.withLock {
            if lastTimestamp > 0 {
                let delta = timestamp - lastTimestamp
                // > 1.5 frames late is a dropped frame; > 1 s is a suspension, not jank.
                if delta > expected * 1.5 && delta < 1 { janky += 1 }
            }
            lastTimestamp = timestamp
            frames += 1
        }
    }
    #endif
}

#if canImport(UIKit) && !os(watchOS)
/// CADisplayLink retains its target; the proxy keeps the monitor itself free of that cycle.
private final class DisplayLinkProxy: NSObject {
    private weak var monitor: FrameMonitor?

    init(_ monitor: FrameMonitor) {
        self.monitor = monitor
    }

    @objc func tick(_ link: CADisplayLink) {
        guard let monitor else {
            link.invalidate()
            return
        }
        monitor.tick(link)
    }
}
#endif

/// Periodically sends `metric` messages while the desktop is connected.
final class MetricsReporter {
    private let queue = DispatchQueue(label: "dev.durbun.metrics", qos: .utility)
    private let frames = FrameMonitor()
    private let send: (JSONValue) -> Void
    private var timer: DispatchSourceTimer?
    private var intervalMs = 1000

    init(send: @escaping (JSONValue) -> Void) {
        self.send = send
    }

    /// Starts or re-times sampling.
    func start(intervalMs: Int) {
        queue.async { [weak self] in
            guard let self else { return }
            let interval = max(250, intervalMs)
            if self.timer != nil && interval == self.intervalMs { return }
            self.intervalMs = interval
            self.timer?.cancel()
            if self.timer == nil { self.frames.start() }
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + .milliseconds(interval), repeating: .milliseconds(interval), leeway: .milliseconds(interval / 10))
            timer.setEventHandler { [weak self] in self?.sample() }
            self.timer = timer
            timer.resume()
        }
    }

    func stop() {
        queue.async {
            guard let timer = self.timer else { return }
            timer.cancel()
            self.timer = nil
            self.frames.stop()
        }
    }

    private func sample() {
        var sample = WireMetricSample(ts: Clock.nowMs())
        if let cpu = ProcessMetrics.cpuUsage() {
            sample.cpu = cpu.percent
            sample.threads = cpu.threads
        }
        sample.memoryMB = ProcessMetrics.memoryFootprintMB()
        if let frame = frames.takeSample() {
            sample.fps = frame.fps
            sample.jankyFrames = frame.jankyFrames
        }
        send(WireMessage.metric(sample))
    }
}
