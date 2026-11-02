import Foundation
import os

/// `os_unfair_lock` on a stable heap address (taking `&` of a stored lock property is unsafe in Swift).
final class UnfairLock {
    private let pointer: os_unfair_lock_t

    init() {
        pointer = .allocate(capacity: 1)
        pointer.initialize(to: os_unfair_lock())
    }

    deinit {
        pointer.deinitialize(count: 1)
        pointer.deallocate()
    }

    @inline(__always)
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        os_unfair_lock_lock(pointer)
        defer { os_unfair_lock_unlock(pointer) }
        return try body()
    }
}

/// Epoch milliseconds on the device clock (fractional, rounded to microseconds).
enum Clock {
    static func nowMs() -> Double {
        (Date().timeIntervalSince1970 * 1_000_000).rounded() / 1000
    }

    static func ms(_ date: Date) -> Double {
        (date.timeIntervalSince1970 * 1_000_000).rounded() / 1000
    }
}

/// The SDK's own diagnostics. Never written to stdout/stderr (that would loop through the stdio
/// capture); debug-level messages are invisible unless explicitly enabled in Console.app.
enum Diagnostics {
    private static let log = OSLog(subsystem: "dev.durbun.sdk", category: "Durbun")

    static func debug(_ message: @autoclosure () -> String) {
        os_log("%{public}@", log: log, type: .debug, message())
    }

    static func info(_ message: @autoclosure () -> String) {
        os_log("%{public}@", log: log, type: .info, message())
    }
}

/// Current thread id as shown by NSLog / Xcode (`pthread_threadid_np`).
enum ThreadInfo {
    static func currentThreadId() -> Int {
        var tid: UInt64 = 0
        pthread_threadid_np(nil, &tid)
        return Int(truncatingIfNeeded: tid)
    }
}
