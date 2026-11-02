import Foundation

/// Crash reporting:
///  - uncaught Objective-C exceptions: `NSSetUncaughtExceptionHandler` (previous handler chained) —
///    reported immediately with a synchronous flush, and persisted in case the flush cannot finish;
///  - fatal signals (Swift runtime traps such as force-unwrapping nil, EXC_BAD_ACCESS, abort):
///    an async-signal-safe handler writes a small report file and re-raises to the previous handler;
///    the report (with the last console lines, e.g. Swift's "Fatal error: …") is sent on the next
///    launch. Nothing that allocates runs inside the signal handler.
enum CrashCapture {
    private static let lock = UnfairLock()
    private static var installed = false
    private static var previousExceptionHandler: (@convention(c) (NSException) -> Void)?

    /// Directory for pending reports; overridable by tests.
    static var reportsDirectory: URL = {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("dev.durbun", isDirectory: true)
    }()

    static var exceptionReportURL: URL { reportsDirectory.appendingPathComponent("pending-exception.json") }
    static var signalReportURL: URL { reportsDirectory.appendingPathComponent("pending-signal.txt") }

    /// Installs the handlers (no file I/O; safe on the main thread).
    static func install() {
        lock.withLock {
            guard !installed else { return }
            installed = true
            previousExceptionHandler = NSGetUncaughtExceptionHandler()
            NSSetUncaughtExceptionHandler(durbunUncaughtExceptionHandler)
            SignalCrashRecorder.install(reportPath: signalReportURL.path)
        }
    }

    /// Creates the report directory and returns the reports left by the previous launch.
    /// Does file I/O: call it off the main thread.
    static func prepareAndTakePendingReports() -> [JSONValue] {
        try? FileManager.default.createDirectory(at: reportsDirectory, withIntermediateDirectories: true)
        return takePendingReports()
    }

    static func uninstall() {
        lock.withLock {
            guard installed else { return }
            installed = false
            if let current = NSGetUncaughtExceptionHandler(),
               unsafeBitCast(current, to: UnsafeRawPointer.self) == unsafeBitCast(durbunUncaughtExceptionHandler as @convention(c) (NSException) -> Void, to: UnsafeRawPointer.self)
            {
                NSSetUncaughtExceptionHandler(previousExceptionHandler)
            }
            previousExceptionHandler = nil
            SignalCrashRecorder.uninstall()
        }
    }

    fileprivate static func chainPrevious(_ exception: NSException) {
        let previous = lock.withLock { previousExceptionHandler }
        previous?(exception)
    }

    // MARK: Uncaught exceptions

    static func crashMessage(for exception: NSException, ts: Double = Clock.nowMs()) -> JSONValue {
        let reason = exception.reason ?? "(no reason)"
        let name = exception.name.rawValue
        let stack = exception.callStackSymbols.joined(separator: "\n")
        var data: JSONValue?
        if let userInfo = exception.userInfo, !userInfo.isEmpty {
            data = JSONConversion.value(from: userInfo)
        }
        return WireMessage.log(
            ts: ts,
            level: .fatal,
            tag: "crash",
            message: "Uncaught exception \(name): \(reason)",
            data: data,
            error: WireErrorInfo(type: name, message: reason, stack: stack.isEmpty ? nil : stack),
            kind: "crash",
            tid: ThreadInfo.currentThreadId()
        )
    }

    /// Body of the uncaught-exception handler (internal for tests).
    static func handle(_ exception: NSException) {
        SignalCrashRecorder.markExceptionReported()
        let message = crashMessage(for: exception)
        let line = JSONWriter.line(message)
        try? line.write(to: exceptionReportURL, options: .atomic)
        let core = DurbunCore.shared
        guard core.isRunning else { return }
        core.send(message)
        if core.flush(timeout: 1.5) {
            try? FileManager.default.removeItem(at: exceptionReportURL)
        }
    }

    // MARK: Next launch

    /// Reports left behind by a previous launch, converted into `log` messages (files removed).
    static func takePendingReports() -> [JSONValue] {
        var messages: [JSONValue] = []
        let fm = FileManager.default
        if let data = try? Data(contentsOf: exceptionReportURL) {
            try? fm.removeItem(at: exceptionReportURL)
            if var object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] {
                let message = object["message"] as? String ?? "Uncaught exception"
                object["message"] = "Crash in previous launch: " + message
                var info = object["data"] as? [String: Any] ?? [:]
                info["previousLaunch"] = true
                object["data"] = info
                messages.append(JSONConversion.value(from: object))
                // The exception's SIGABRT may also have left a signal report: it is the same crash.
                try? fm.removeItem(at: signalReportURL)
            }
        }
        if let data = try? Data(contentsOf: signalReportURL) {
            try? fm.removeItem(at: signalReportURL)
            if let report = SignalReport(data: data) { messages.append(report.message()) }
        }
        return messages
    }
}

/// The installed handler: report, then chain to whatever handler was installed before us.
func durbunUncaughtExceptionHandler(_ exception: NSException) {
    CrashCapture.handle(exception)
    CrashCapture.chainPrevious(exception)
}

/// Parsed signal report written by `SignalCrashRecorder`.
struct SignalReport {
    var signal: Int32
    var time: Double
    var output: String
    var backtrace: String

    init?(data: Data) {
        let text = String(decoding: data, as: UTF8.self)
        guard text.hasPrefix(SignalCrashRecorder.header) else { return nil }
        var signal: Int32?
        var time: Double?
        var output = ""
        var backtrace = ""
        var section = ""
        for rawLine in text.components(separatedBy: "\n").dropFirst() {
            if rawLine == "--- output ---" || rawLine == "--- backtrace ---" {
                section = rawLine
                continue
            }
            switch section {
            case "--- output ---": output += rawLine + "\n"
            case "--- backtrace ---": backtrace += rawLine + "\n"
            default:
                if rawLine.hasPrefix("signal=") { signal = Int32(rawLine.dropFirst(7)) }
                if rawLine.hasPrefix("time=") { time = Double(rawLine.dropFirst(5)) }
            }
        }
        guard let signal else { return nil }
        self.signal = signal
        self.time = time ?? Date().timeIntervalSince1970
        self.output = output.trimmingCharacters(in: .whitespacesAndNewlines)
        self.backtrace = backtrace.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func name(of signal: Int32) -> String {
        switch signal {
        case SIGABRT: return "SIGABRT"
        case SIGBUS: return "SIGBUS"
        case SIGFPE: return "SIGFPE"
        case SIGILL: return "SIGILL"
        case SIGSEGV: return "SIGSEGV"
        case SIGTRAP: return "SIGTRAP"
        case SIGSYS: return "SIGSYS"
        default: return "signal \(signal)"
        }
    }

    static func explanation(of signal: Int32) -> String {
        switch signal {
        case SIGABRT: return "abort() — often an uncaught exception or a failed assertion"
        case SIGBUS, SIGSEGV: return "EXC_BAD_ACCESS — invalid memory access"
        case SIGFPE: return "arithmetic error"
        case SIGILL: return "illegal instruction"
        case SIGTRAP: return "EXC_BREAKPOINT — Swift runtime trap (force unwrap of nil, index out of range, fatalError…)"
        default: return "fatal signal"
        }
    }

    /// The most telling console line, e.g. "MyApp/File.swift:12: Fatal error: Unexpectedly found nil…".
    var reason: String? {
        let markers = ["Fatal error", "Precondition failed", "Assertion failed", "*** Terminating app", "Unexpectedly found nil"]
        let lines = output.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        return lines.last(where: { line in markers.contains { line.contains($0) } })
    }

    func message() -> JSONValue {
        let name = Self.name(of: signal)
        let headline = reason ?? "\(name) (\(Self.explanation(of: signal)))"
        var data = JSONObjectBuilder()
        data.set("previousLaunch", true)
        data.set("signal", Int(signal))
        data.set("signalName", name)
        data.set("explanation", Self.explanation(of: signal))
        if !output.isEmpty { data.set("consoleTail", String(output.suffix(4000))) }
        return WireMessage.log(
            ts: (time * 1000).rounded(),
            level: .fatal,
            tag: "crash",
            message: "Crash in previous launch: \(headline)",
            data: data.value,
            error: WireErrorInfo(type: name, message: reason ?? Self.explanation(of: signal), stack: backtrace.isEmpty ? nil : backtrace),
            kind: "crash"
        )
    }
}
