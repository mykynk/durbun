import Darwin
import Foundation

/// Captures stdout/stderr (`print`, `debugPrint`, `NSLog` mirrors, C `printf`) with the dup2 pipe
/// technique. Every byte is written through to the original descriptors first, so Xcode's console
/// keeps working. Native iOS `print` never reaches the device syslog, hence this capture.
final class StdioCapture {
    enum Stream: String {
        case stdout
        case stderr

        var fd: Int32 { self == .stdout ? STDOUT_FILENO : STDERR_FILENO }
    }

    struct Entry {
        var stream: Stream
        var text: String
        var ts: Double
    }

    private final class Redirect {
        let stream: Stream
        let originalFd: Int32
        let readFd: Int32
        var source: DispatchSourceRead?
        var assembler = OutputAssembler()
        var flushWork: DispatchWorkItem?
        var finished = false

        init(stream: Stream, originalFd: Int32, readFd: Int32) {
            self.stream = stream
            self.originalFd = originalFd
            self.readFd = readFd
        }
    }

    private let queue = DispatchQueue(label: "dev.durbun.stdio", qos: .utility)
    private let onEntries: ([Entry]) -> Void
    private var redirects: [Redirect] = []
    private let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: 64 * 1024)

    init(onEntries: @escaping ([Entry]) -> Void) {
        self.onEntries = onEntries
    }

    deinit {
        buffer.deallocate()
    }

    /// Starts capturing; returns false if neither stream could be redirected.
    @discardableResult
    func start() -> Bool {
        guard redirects.isEmpty else { return true }
        for stream in [Stream.stdout, .stderr] {
            if let redirect = redirectStream(stream) { redirects.append(redirect) }
        }
        return !redirects.isEmpty
    }

    /// Restores the original descriptors immediately, then drains what is left in the pipes.
    func stop() {
        let active = redirects
        redirects.removeAll()
        guard !active.isEmpty else { return }
        fflush(stdout)
        fflush(stderr)
        for redirect in active {
            // Closes the pipe's write end, so the reader sees EOF after the remaining bytes.
            dup2(redirect.originalFd, redirect.stream.fd)
            setTail(redirect.stream, read: -1, original: -1)
        }
        queue.async {
            for redirect in active { self.drain(redirect, final: true) }
        }
    }

    private func redirectStream(_ stream: Stream) -> Redirect? {
        let fd = stream.fd
        fflush(stream == .stdout ? stdout : stderr)
        let original = dup(fd)
        guard original >= 0 else { return nil }
        var fds: [Int32] = [-1, -1]
        guard pipe(&fds) == 0 else {
            close(original)
            return nil
        }
        let readFd = fds[0]
        let writeFd = fds[1]
        // A closed console must not kill the app with SIGPIPE when we write through.
        _ = fcntl(original, F_SETNOSIGPIPE, 1)
        _ = fcntl(original, F_SETFD, FD_CLOEXEC)
        _ = fcntl(readFd, F_SETFD, FD_CLOEXEC)
        _ = fcntl(readFd, F_SETFL, fcntl(readFd, F_GETFL) | O_NONBLOCK)
        guard dup2(writeFd, fd) >= 0 else {
            close(readFd)
            close(writeFd)
            close(original)
            return nil
        }
        close(writeFd)
        if stream == .stdout {
            setvbuf(stdout, nil, _IOLBF, 0)
        } else {
            setvbuf(stderr, nil, _IONBF, 0)
        }
        let redirect = Redirect(stream: stream, originalFd: original, readFd: readFd)
        setTail(stream, read: readFd, original: original)
        let source = DispatchSource.makeReadSource(fileDescriptor: readFd, queue: queue)
        source.setEventHandler { [weak self, weak redirect] in
            guard let self, let redirect else { return }
            self.drain(redirect, final: false)
        }
        source.setCancelHandler {
            close(readFd)
            close(original)
        }
        redirect.source = source
        source.resume()
        return redirect
    }

    private func setTail(_ stream: Stream, read: Int32, original: Int32) {
        if stream == .stdout {
            ConsoleTail.stdoutPipe = (read, original)
        } else {
            ConsoleTail.stderrPipe = (read, original)
        }
    }

    /// Runs on `queue`.
    private func drain(_ redirect: Redirect, final: Bool) {
        guard !redirect.finished else { return }
        var reachedEOF = false
        while true {
            let n = read(redirect.readFd, buffer, 64 * 1024)
            if n > 0 {
                writeThrough(redirect.originalFd, count: n)
                ConsoleTail.record(buffer, count: n)
                let entries = redirect.assembler.push(UnsafeBufferPointer(start: buffer, count: n), now: Clock.nowMs())
                emit(entries, from: redirect.stream)
            } else if n == 0 {
                reachedEOF = true
                break
            } else if errno == EINTR {
                continue
            } else {
                break
            }
        }
        if reachedEOF || final {
            redirect.finished = true
            redirect.flushWork?.cancel()
            emit(redirect.assembler.flush(now: Clock.nowMs(), includePartial: true), from: redirect.stream)
            redirect.source?.cancel()
            redirect.source = nil
            return
        }
        scheduleFlush(redirect)
    }

    /// Ends the pending (possibly multi-line) entry once no continuation arrived in time.
    private func scheduleFlush(_ redirect: Redirect) {
        redirect.flushWork?.cancel()
        guard redirect.assembler.hasPending else { return }
        let work = DispatchWorkItem { [weak self, weak redirect] in
            guard let self, let redirect, !redirect.finished else { return }
            self.emit(redirect.assembler.flush(now: Clock.nowMs(), includePartial: false), from: redirect.stream)
        }
        redirect.flushWork = work
        queue.asyncAfter(deadline: .now() + .milliseconds(Int(OutputAssembler.groupingWindow)), execute: work)
    }

    private func emit(_ entries: [OutputAssembler.Entry], from stream: Stream) {
        guard !entries.isEmpty else { return }
        onEntries(entries.map { Entry(stream: stream, text: $0.lines.joined(separator: "\n"), ts: $0.ts) })
    }

    private func writeThrough(_ fd: Int32, count: Int) {
        var written = 0
        while written < count {
            let n = write(fd, buffer + written, count - written)
            if n > 0 {
                written += n
            } else if n < 0 && errno == EINTR {
                continue
            } else {
                return
            }
        }
    }
}
