import Foundation

/// Reads the body of an intercepted request. CFNetwork hands every body to URLProtocol as an
/// unopened `httpBodyStream` (even `httpBody` and upload tasks from data/file), so the stream has
/// to be consumed here and its bytes re-attached to the forwarded request.
enum RequestBody {
    enum Forward {
        case none
        case data(Data)
        /// Huge bodies: bytes already read + the rest of the original stream, replayed lazily.
        case stream(InputStream)
        /// The app's body stream reported an error; the request fails like it would natively.
        case failed(Error)
    }

    struct Result {
        var forward: Forward
        /// The first bytes of the body (for capture).
        var captured: Data
        /// Full size when known.
        var totalSize: Int
    }

    /// Bodies up to this size are buffered and forwarded as `httpBody`; larger ones are streamed:
    /// only the capture limit plus a margin is ever held in memory (never the whole upload).
    ///
    /// Trade-off: a streamed body cannot be rewound, so a 307/308 redirect or an authentication
    /// retry that must resend it fails (`needNewBodyStream` has no stream to give). Buffered bodies
    /// (up to this limit) and `httpBody` requests are resent as usual.
    static func inMemoryLimit(captureLimit: Int) -> Int {
        max(captureLimit, minimumInMemory) + margin
    }

    /// Small bodies always stay rewindable, even with body capture off.
    static let minimumInMemory = 1024 * 1024
    static let margin = 256 * 1024
    private static let chunkSize = 64 * 1024

    /// May block while the app writes into a bound stream pair: call it off the protocol's client thread.
    static func read(_ request: URLRequest, captureLimit: Int) -> Result {
        let inMemoryLimit = inMemoryLimit(captureLimit: captureLimit)
        if let body = request.httpBody {
            return Result(forward: .data(body), captured: body, totalSize: body.count)
        }
        guard let stream = request.httpBodyStream else {
            return Result(forward: .none, captured: Data(), totalSize: 0)
        }
        stream.open()
        var collected = Data()
        var buffer = [UInt8](repeating: 0, count: chunkSize)
        var failed = false
        while collected.count <= inMemoryLimit {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n > 0 {
                collected.append(buffer, count: n)
            } else {
                failed = n < 0
                break
            }
        }
        if failed {
            let error = stream.streamError ?? NSError(
                domain: NSURLErrorDomain,
                code: NSURLErrorRequestBodyStreamExhausted,
                userInfo: [NSLocalizedDescriptionKey: "The request body stream failed."]
            )
            stream.close()
            return Result(forward: .failed(error), captured: collected, totalSize: collected.count)
        }
        if collected.count <= inMemoryLimit {
            stream.close()
            return Result(forward: .data(collected), captured: collected, totalSize: collected.count)
        }
        // Too large to buffer: replay what was read, then the remainder, without holding
        // everything in memory (the pump releases the prefix once written).
        let declared = request.value(forHTTPHeaderField: "Content-Length").flatMap { Int($0) }
        let captured = collected.prefix(max(0, captureLimit))
        return Result(
            forward: .stream(ReplayStream.make(prefix: collected, remainder: stream)),
            captured: Data(captured),
            totalSize: declared ?? collected.count
        )
    }
}

/// An InputStream that yields `prefix` followed by the rest of `remainder`, fed by a background
/// thread through a bound stream pair (works with URLSession's run-loop based stream handling).
enum ReplayStream {
    static func make(prefix: Data, remainder: InputStream) -> InputStream {
        var input: InputStream?
        var output: OutputStream?
        Stream.getBoundStreams(withBufferSize: 256 * 1024, inputStream: &input, outputStream: &output)
        guard let input, let output else {
            remainder.close()
            return InputStream(data: prefix)
        }
        let box = PrefixBox(prefix)
        let thread = Thread {
            pump(prefix: box, remainder: remainder, into: output)
        }
        thread.name = "dev.durbun.body-replay"
        thread.qualityOfService = .userInitiated // feeds the app's upload
        thread.start()
        return input
    }

    /// Holds the already-read bytes until they were written, then lets them go.
    private final class PrefixBox {
        var data: Data?
        init(_ data: Data) { self.data = data }
    }

    private static func pump(prefix: PrefixBox, remainder: InputStream, into output: OutputStream) {
        output.open()
        defer {
            output.close()
            remainder.close()
        }
        let head = prefix.data ?? Data()
        prefix.data = nil
        guard write(head, to: output) else { return }
        var buffer = [UInt8](repeating: 0, count: 64 * 1024)
        while true {
            let n = remainder.read(&buffer, maxLength: buffer.count)
            guard n > 0 else { return }
            let ok = buffer.withUnsafeBytes { write(UnsafeRawBufferPointer(rebasing: $0[0..<n]), to: output) }
            if !ok { return }
        }
    }

    private static func write(_ data: Data, to output: OutputStream) -> Bool {
        data.withUnsafeBytes { write($0, to: output) }
    }

    /// Blocking write of every byte; false once the reading side went away.
    private static func write(_ bytes: UnsafeRawBufferPointer, to output: OutputStream) -> Bool {
        guard let base = bytes.baseAddress?.assumingMemoryBound(to: UInt8.self) else { return true }
        var offset = 0
        while offset < bytes.count {
            let written = output.write(base + offset, maxLength: bytes.count - offset)
            if written <= 0 { return false }
            offset += written
        }
        return true
    }
}
