import Foundation
#if canImport(OSLog)
import OSLog
#endif

/// Reads this app's own unified-log lines (`os_log`, `Logger`, `NSLog`, third-party SDKs) through
/// `OSLogStore(scope: .currentProcessIdentifier)`, iOS 15+ / macOS 12+.
///
/// The system offers no live stream of one's own process, so the store is polled on a background
/// queue. A read waits ~0.8 s in the system log service while the app itself spends almost no CPU,
/// and a date predicate keeps every read after the first one incremental. The first read starts at
/// process launch, so lines logged before the capture started are not lost. The system does not keep
/// `.debug` messages: they never show up here.
///
/// Every OSLog symbol is used behind `@available`, so the framework is weak-linked and apps that also
/// run on iOS 13/14 still launch there (the capture is simply unavailable).
final class OSLogCapture {
    enum Mode: Equatable {
        case off
        /// Someone may look later (in-app panel closed): read now and then.
        case slow
        /// Someone is looking (panel open, or a desktop without device logs): read often.
        case fast
    }

    struct Entry: Equatable {
        var ts: Double
        var level: DurbunLogLevel
        var tag: String
        var message: String
        var tid: Int?
    }

    /// What one `OSLogEntryLog` carries, so the filtering is testable without a log store.
    struct Record {
        var date: Date
        /// `OSLogEntryLog.Level` raw value: 0 undefined, 1 debug, 2 info, 3 notice, 4 error, 5 fault.
        var level: Int
        var subsystem: String
        var sender: String
        var message: String
        var threadId: UInt64
    }

    static var isAvailable: Bool {
        if #available(iOS 15.0, macOS 12.0, *) { return true }
        return false
    }

    /// Lines handed over per read at most (the first read covers everything since launch).
    static let maxEntriesPerRead = 2000

    private let queue = DispatchQueue(label: "dev.durbun.oslog", qos: .utility)
    private let lock = UnfairLock()
    private let onEntries: ([Entry]) -> Void
    private let fastInterval: TimeInterval
    private let slowInterval: TimeInterval
    private var mode: Mode = .off
    private var generation = 0
    private var disabled = false
    // Touched on `queue` only.
    private var store: AnyObject?
    private var cursor: Date?
    private var seenAtCursor: Set<Int> = []
    private var failures = 0

    init(fastInterval: TimeInterval = 1, slowInterval: TimeInterval = 5, onEntries: @escaping ([Entry]) -> Void) {
        self.fastInterval = fastInterval
        self.slowInterval = slowInterval
        self.onEntries = onEntries
    }

    var currentMode: Mode { lock.withLock { mode } }

    /// Changing the mode reads right away (opening the panel shows what is new at once).
    func setMode(_ newMode: Mode) {
        guard Self.isAvailable else { return }
        let start: Int? = lock.withLock {
            guard mode != newMode, !disabled || newMode == .off else { return nil }
            mode = newMode
            generation += 1
            return newMode == .off ? nil : generation
        }
        if let generation = start {
            queue.async { [weak self] in self?.tick(generation) }
        }
    }

    func stop() {
        lock.withLock {
            mode = .off
            generation += 1
        }
    }

    private func tick(_ scheduled: Int) {
        guard lock.withLock({ generation == scheduled && mode != .off }) else { return }
        readOnce()
        let next: TimeInterval? = lock.withLock {
            guard generation == scheduled, !disabled else { return nil }
            switch mode {
            case .off: return nil
            case .slow: return slowInterval
            case .fast: return fastInterval
            }
        }
        guard let next else { return }
        queue.asyncAfter(deadline: .now() + next) { [weak self] in self?.tick(scheduled) }
    }

    /// Runs on `queue`.
    private func readOnce() {
        #if canImport(OSLog)
        guard #available(iOS 15.0, macOS 12.0, *) else { return }
        do {
            let store: OSLogStore
            if let existing = self.store as? OSLogStore {
                store = existing
            } else {
                store = try OSLogStore(scope: .currentProcessIdentifier)
                self.store = store
            }
            let predicate = cursor.map { NSPredicate(format: "date >= %@", $0 as NSDate) }
            var entries: [Entry] = []
            var newest = cursor
            var newestKeys: Set<Int> = []
            for item in try store.getEntries(at: nil, matching: predicate) {
                guard let log = item as? OSLogEntryLog else { continue }
                let date = log.date
                let message = log.composedMessage
                let key = Self.key(date: date, message: message)
                if date == cursor, seenAtCursor.contains(key) { continue }
                if newest.map({ date > $0 }) ?? true {
                    newest = date
                    newestKeys = [key]
                } else if date == newest {
                    newestKeys.insert(key)
                }
                let record = Record(
                    date: date,
                    level: Int(log.level.rawValue),
                    subsystem: log.subsystem,
                    sender: log.sender,
                    message: message,
                    threadId: log.threadIdentifier
                )
                if let entry = Self.entry(from: record) { entries.append(entry) }
            }
            if let newest {
                if newest == cursor {
                    seenAtCursor.formUnion(newestKeys)
                } else {
                    cursor = newest
                    seenAtCursor = newestKeys
                }
            }
            failures = 0
            if entries.count > Self.maxEntriesPerRead {
                entries.removeFirst(entries.count - Self.maxEntriesPerRead)
            }
            if !entries.isEmpty { onEntries(entries) }
        } catch {
            failures += 1
            if failures == 1 { Diagnostics.info("Dürbün cannot read this app's os_log lines: \(error)") }
            if failures >= 3 {
                // The store keeps failing (e.g. a sandbox without log access): stop asking.
                lock.withLock { disabled = true }
            }
        }
        #endif
    }

    private static func key(date: Date, message: String) -> Int {
        var hasher = Hasher()
        hasher.combine(date)
        hasher.combine(message)
        return hasher.finalize()
    }

    /// The line to send for one record, or nil when it is Apple's own, the SDK's, or Dart's `print`.
    static func entry(from record: Record) -> Entry? {
        let message = record.message
        guard !message.isEmpty else { return nil }
        let subsystem = record.subsystem
        if subsystem.hasPrefix("com.apple.") || subsystem == Diagnostics.subsystem { return nil }
        // Flutter echoes Dart's print() as "flutter: …"; the Dart side sends those itself.
        if message.hasPrefix("flutter: ") { return nil }
        // Same tag as the desktop's own iOS log readers: subsystem, else the logging library or binary.
        let tag = !subsystem.isEmpty ? subsystem : (!record.sender.isEmpty ? record.sender : "os_log")
        return Entry(
            ts: Clock.ms(record.date),
            level: level(record.level),
            tag: tag,
            message: message,
            tid: record.threadId > 0 && record.threadId <= UInt64(Int.max) ? Int(record.threadId) : nil
        )
    }

    /// Unified-log levels as the desktop maps them (`fault` is a serious record, not a crash).
    static func level(_ raw: Int) -> DurbunLogLevel {
        switch raw {
        case 1: return .debug
        case 4, 5: return .error
        default: return .info
        }
    }
}

/// Console lines seen on stdout/stderr, so their unified-log copy (`NSLog` writes to both) is sent once.
final class RecentConsoleLines {
    private let lock = UnfairLock()
    private var seen: [String: Double] = [:]
    private var order: [String] = []
    private let capacity: Int
    private let windowMs: Double

    init(capacity: Int = 512, windowMs: Double = 3000) {
        self.capacity = capacity
        self.windowMs = windowMs
    }

    func remember(_ text: String, ts: Double) {
        let key = Self.normalized(text)
        guard !key.isEmpty else { return }
        lock.withLock {
            if seen.updateValue(ts, forKey: key) == nil { order.append(key) }
            if order.count > capacity {
                let drop = order.count - capacity
                for old in order.prefix(drop) { seen[old] = nil }
                order.removeFirst(drop)
            }
        }
    }

    func contains(_ text: String, near ts: Double) -> Bool {
        let key = Self.normalized(text)
        return lock.withLock {
            guard let seenAt = seen[key] else { return false }
            return abs(seenAt - ts) <= windowMs
        }
    }

    private static func normalized(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
