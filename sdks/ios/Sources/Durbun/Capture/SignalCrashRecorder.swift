import Darwin
import Foundation

/// Last bytes written to stdout/stderr, plus the capture pipes, kept in plain memory so the
/// signal handler can (1) forward output that is still sitting in our pipes to the original console
/// — e.g. Swift's "Fatal error: …" line printed right before the trap — and (2) put it in the report.
enum ConsoleTail {
    static let capacity = 8192
    static let buffer: UnsafeMutablePointer<UInt8> = {
        let pointer = UnsafeMutablePointer<UInt8>.allocate(capacity: capacity)
        pointer.initialize(repeating: 0, count: capacity)
        return pointer
    }()

    static var writeIndex = 0
    static var filled = false
    /// (pipe read end, original console fd); -1 when not capturing.
    static var stdoutPipe: (read: Int32, original: Int32) = (-1, -1)
    static var stderrPipe: (read: Int32, original: Int32) = (-1, -1)
    fileprivate static let drainBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 4096)

    /// Touches the lazily initialized globals so the signal handler never initializes them.
    static func prepare() {
        _ = buffer
        _ = drainBuffer
        _ = writeIndex
        _ = stdoutPipe
        _ = stderrPipe
    }

    static func record(_ bytes: UnsafePointer<UInt8>, count: Int) {
        var offset = max(0, count - capacity)
        while offset < count {
            let chunk = min(count - offset, capacity - writeIndex)
            (buffer + writeIndex).update(from: bytes + offset, count: chunk)
            writeIndex += chunk
            offset += chunk
            if writeIndex == capacity {
                writeIndex = 0
                filled = true
            }
        }
    }

    /// Async-signal-safe.
    fileprivate static func write(to fd: Int32) {
        if filled { _ = Darwin.write(fd, buffer + writeIndex, capacity - writeIndex) }
        _ = Darwin.write(fd, buffer, writeIndex)
    }

    /// Async-signal-safe: moves pending pipe bytes to the original console and into the tail.
    fileprivate static func drainForCrash() {
        drain(stdoutPipe.read, stdoutPipe.original)
        drain(stderrPipe.read, stderrPipe.original)
    }

    private static func drain(_ readFd: Int32, _ originalFd: Int32) {
        guard readFd >= 0 else { return }
        for _ in 0..<64 {
            let n = Darwin.read(readFd, drainBuffer, 4096)
            if n <= 0 { return }
            if originalFd >= 0 {
                var written = 0
                while written < n {
                    let w = Darwin.write(originalFd, drainBuffer + written, n - written)
                    if w <= 0 { break }
                    written += w
                }
            }
            record(drainBuffer, count: n)
        }
    }
}

/// Fatal signal handler. Only async-signal-safe calls (open/write/close/backtrace_symbols_fd/
/// sigaction/raise) on memory allocated at install time.
enum SignalCrashRecorder {
    static let header = "DURBUN-SIGNAL-REPORT 1"
    static let fatalSignals: [Int32] = [SIGABRT, SIGBUS, SIGFPE, SIGILL, SIGSEGV, SIGTRAP, SIGSYS]

    fileprivate struct State {
        var reportPath: UnsafeMutablePointer<CChar>
        var frames: UnsafeMutablePointer<UnsafeMutableRawPointer?>
        var scratch: UnsafeMutablePointer<UInt8>
        /// Previous actions indexed by signal number.
        var previous: UnsafeMutablePointer<sigaction>
        var exceptionReported: Int32
        var active: Int32
    }

    fileprivate static let maxFrames: Int32 = 128
    fileprivate static let state: UnsafeMutablePointer<State> = {
        let pointer = UnsafeMutablePointer<State>.allocate(capacity: 1)
        let previous = UnsafeMutablePointer<sigaction>.allocate(capacity: 64)
        previous.initialize(repeating: sigaction(), count: 64)
        let frames = UnsafeMutablePointer<UnsafeMutableRawPointer?>.allocate(capacity: Int(maxFrames))
        frames.initialize(repeating: nil, count: Int(maxFrames))
        let scratch = UnsafeMutablePointer<UInt8>.allocate(capacity: 64)
        scratch.initialize(repeating: 0, count: 64)
        let path = UnsafeMutablePointer<CChar>.allocate(capacity: 1)
        path.initialize(to: 0)
        pointer.initialize(to: State(reportPath: path, frames: frames, scratch: scratch, previous: previous, exceptionReported: 0, active: 0))
        return pointer
    }()

    private static var altStack: UnsafeMutableRawPointer?

    static func install(reportPath: String) {
        let state = self.state
        guard state.pointee.active == 0 else { return }
        ConsoleTail.prepare()
        // strdup'ed once; replaced only while not active.
        if let copy = strdup(reportPath) { state.pointee.reportPath = copy }
        state.pointee.exceptionReported = 0
        // backtrace() may lazily load libunwind and allocate on first use: warm it up now.
        _ = backtrace(state.pointee.frames, maxFrames)
        installAlternateStackIfNeeded()
        var action = sigaction()
        action.__sigaction_u.__sa_sigaction = durbunSignalHandler
        action.sa_flags = SA_SIGINFO | SA_ONSTACK
        sigemptyset(&action.sa_mask)
        for signal in fatalSignals {
            _ = sigaction(signal, &action, state.pointee.previous + Int(signal))
        }
        state.pointee.active = 1
    }

    static func uninstall() {
        let state = self.state
        guard state.pointee.active == 1 else { return }
        state.pointee.active = 0
        for signal in fatalSignals {
            var current = sigaction()
            guard sigaction(signal, nil, &current) == 0 else { continue }
            if isOurs(current) { _ = sigaction(signal, state.pointee.previous + Int(signal), nil) }
        }
    }

    static func markExceptionReported() {
        state.pointee.exceptionReported = 1
    }

    private static func isOurs(_ action: sigaction) -> Bool {
        guard let handler = action.__sigaction_u.__sa_sigaction else { return false }
        return unsafeBitCast(handler, to: UnsafeRawPointer.self)
            == unsafeBitCast(durbunSignalHandler as @convention(c) (Int32, UnsafeMutablePointer<__siginfo>?, UnsafeMutableRawPointer?) -> Void, to: UnsafeRawPointer.self)
    }

    /// Stack overflows run out of stack for the handler itself; give the main thread a spare one.
    private static func installAlternateStackIfNeeded() {
        guard altStack == nil else { return }
        var current = stack_t()
        guard sigaltstack(nil, &current) == 0, current.ss_flags & SS_DISABLE != 0 else { return }
        let size = 64 * 1024
        let memory = UnsafeMutableRawPointer.allocate(byteCount: size, alignment: 16)
        var stack = stack_t(ss_sp: memory, ss_size: size, ss_flags: 0)
        if sigaltstack(&stack, nil) == 0 {
            altStack = memory
        } else {
            memory.deallocate()
        }
    }

    /// Runs in the signal handler (internal so tests can drive the real writer with SIGSEGV,
    /// which only restores the previous disposition and returns when not in a fault context).
    static func handle(_ signal: Int32) {
        let state = self.state
        ConsoleTail.drainForCrash()
        if state.pointee.exceptionReported == 0, state.pointee.active == 1 {
            let fd = open(state.pointee.reportPath, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
            if fd >= 0 {
                writeStatic(fd, "DURBUN-SIGNAL-REPORT 1\nsignal=")
                writeDecimal(fd, Int(signal), state.pointee.scratch)
                writeStatic(fd, "\ntime=")
                writeDecimal(fd, Int(time(nil)), state.pointee.scratch)
                writeStatic(fd, "\n--- output ---\n")
                ConsoleTail.write(to: fd)
                writeStatic(fd, "\n--- backtrace ---\n")
                let count = backtrace(state.pointee.frames, maxFrames)
                backtrace_symbols_fd(state.pointee.frames, count, fd)
                close(fd)
            }
        }
        // Chain: restore the previous disposition (never "ignore" for a fatal signal).
        var previous = state.pointee.previous[Int(signal)]
        if unsafeBitCast(previous.__sigaction_u.__sa_handler, to: Int.self) == 1 { // SIG_IGN
            previous = sigaction()
        }
        _ = sigaction(signal, &previous, nil)
        if signal == SIGABRT {
            // abort() resets SIGABRT to default before retrying: deliver to the previous handler now.
            raise(signal)
        }
        // Hardware faults re-execute the faulting instruction on return and reach the previous
        // handler with the original crash location intact.
    }

    private static func writeStatic(_ fd: Int32, _ text: StaticString) {
        _ = Darwin.write(fd, text.utf8Start, text.utf8CodeUnitCount)
    }

    private static func writeDecimal(_ fd: Int32, _ value: Int, _ scratch: UnsafeMutablePointer<UInt8>) {
        var remaining = value.magnitude
        var index = 40
        repeat {
            index -= 1
            scratch[index] = UInt8(48 + remaining % 10)
            remaining /= 10
        } while remaining > 0 && index > 1
        if value < 0 {
            index -= 1
            scratch[index] = 45
        }
        _ = Darwin.write(fd, scratch + index, 40 - index)
    }
}

private func durbunSignalHandler(_ signal: Int32, _ info: UnsafeMutablePointer<__siginfo>?, _ context: UnsafeMutableRawPointer?) {
    SignalCrashRecorder.handle(signal)
}
