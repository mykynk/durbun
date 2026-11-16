import Foundation

/// Hands stream work (WebSocket messages and handshakes, Server-Sent Events chunks) from the app's
/// threads to one serial utility queue, in the order it was handed over. Producers only append to a
/// bounded queue under a lock: when it is full, the oldest stream messages are dropped first.
final class StreamPipeline {
    static let shared = StreamPipeline()

    /// Runs every submitted work item, the SDK's WebSocket watcher and the SSE parsers.
    let queue = DispatchQueue(label: "dev.durbun.streams", qos: .utility)
    private let lock = UnfairLock()
    private var pending: BoundedQueue<() -> Void>
    private var draining = false

    init(maxItems: Int = 2000, maxBytes: Int = 16 * 1024 * 1024) {
        pending = BoundedQueue(maxMessages: maxItems, maxBytes: maxBytes)
    }

    /// - Parameters:
    ///   - droppable: a stream message, dropped (oldest first) when the queue is full.
    ///   - weight: bytes the work keeps alive (the payload it captured).
    func submit(droppable: Bool, weight: Int = 0, _ work: @escaping () -> Void) {
        let schedule: Bool = lock.withLock {
            pending.append(work, weight: max(0, weight), droppable: droppable)
            if draining { return false }
            draining = true
            return true
        }
        if schedule { queue.async { self.drain() } }
    }

    /// Tests: blocks until everything submitted so far ran.
    func waitUntilIdle() {
        while lock.withLock({ draining || !pending.isEmpty }) {
            queue.sync {}
        }
    }

    private func drain() {
        while true {
            let work: (() -> Void)? = lock.withLock {
                if let next = pending.popFirst() { return next }
                draining = false
                return nil
            }
            guard let work else { return }
            work()
        }
    }
}

/// A stream message's payload as a `WireBody`, cut at `config.maxStreamMessageBytes`.
enum StreamPayload {
    /// Text: utf8, cut on a character boundary. No body when `cap` is 0 or the text is empty.
    static func text(_ text: String, cap: Int) -> (size: Int, body: WireBody?) {
        let utf8 = text.utf8
        let size = utf8.count
        guard cap > 0, size > 0 else { return (size, nil) }
        return (size, utf8Body(Data(utf8.prefix(cap)), size: size))
    }

    /// Binary: base64. No body when `cap` is 0 or the data is empty.
    static func binary(_ data: Data, cap: Int) -> (size: Int, body: WireBody?) {
        let size = data.count
        guard cap > 0, size > 0 else { return (size, nil) }
        let kept = Data(data.prefix(cap))
        return (size, WireBody(encoding: .base64, data: kept.base64EncodedString(), size: size, truncated: kept.count < size))
    }

    /// `kept`: the first bytes (at most the cap) of a UTF-8 payload of `size` bytes.
    static func utf8Body(_ kept: Data, size: Int) -> WireBody {
        let truncated = kept.count < size
        let text = BodyCapture.decodeUTF8(kept, allowTrimmingPartialCharacter: truncated) ?? String(decoding: kept, as: UTF8.self)
        return WireBody(encoding: .utf8, data: text, size: size, truncated: truncated)
    }
}

/// One `text/event-stream` response that `DurbunURLProtocol` reports as a stream: its `net.response`
/// went out at the headers without a body, and every chunk the app receives is parsed into `net.sse`
/// events on the stream queue (never on the delegate queue, never kept as a body). Chunks seen while
/// the desktop does not ask for streams, or dropped under pressure, leave a gap: the parser then skips
/// to the next event boundary instead of reporting half an event.
final class EventStreamCapture {
    let id: String
    private let startsMidStream: Bool
    private let lock = UnfairLock()
    /// Chunks seen (lock).
    private var seq = 0
    private var finished = false
    /* stream queue only */
    private var parser: SSEParser?
    private var parsedSeq = 0

    /// `startsMidStream`: the body began before the capture did (the desktop asked for streams later).
    init(id: String, startsMidStream: Bool) {
        self.id = id
        self.startsMidStream = startsMidStream
    }

    /// A 2xx `text/event-stream` response.
    static func isEventStream(_ response: HTTPURLResponse) -> Bool {
        guard (200..<300).contains(response.statusCode) else { return false }
        let type = response.value(forHTTPHeaderField: "Content-Type") ?? response.mimeType
        return type?.lowercased().hasPrefix("text/event-stream") == true
    }

    /// A chunk the app received (forwarding delegate queue): a cheap hand-off.
    func received(_ chunk: Data) {
        let ts = Clock.nowMs()
        let capture = DurbunCore.shared.streamMessageCap != nil
        lock.withLock {
            guard !finished else { return }
            seq += 1
            guard capture else { return }
            let number = seq
            StreamPipeline.shared.submit(droppable: true, weight: chunk.count) { [self] in
                parse(chunk, seq: number, ts: ts)
            }
        }
    }

    /// The stream ended: normally (`final` nil: `net.sse {end}`), or with `final` (a `net.error`). Sent
    /// also when the desktop stopped asking for streams meanwhile: a reported stream is always finished.
    /// Only the first call counts.
    func end(final: JSONValue?) {
        let ts = Clock.nowMs()
        lock.withLock {
            guard !finished else { return }
            finished = true
            StreamPipeline.shared.submit(droppable: false) { [self] in
                parser = nil
                let core = DurbunCore.shared
                if let final {
                    core.send(final)
                } else {
                    core.sendStream(WireMessage.netSse(id: id, ts: ts, end: true))
                }
            }
        }
    }

    /// Stream queue.
    private func parse(_ chunk: Data, seq: Int, ts: Double) {
        let core = DurbunCore.shared
        guard let cap = core.streamMessageCap else {
            parser = nil
            parsedSeq = seq
            return
        }
        if parser == nil || seq != parsedSeq + 1 {
            let fromStart = parser == nil && seq == 1 && !startsMidStream
            parser = SSEParser(cap: cap, resync: !fromStart)
        }
        parsedSeq = seq
        parser?.cap = cap
        guard let events = parser?.push(chunk) else { return }
        for event in events {
            let body = cap > 0 && event.size > 0 ? StreamPayload.utf8Body(Data(event.data), size: event.size) : nil
            core.sendStream(WireMessage.netSse(
                id: id, ts: ts, event: event.event, eventId: event.id, retry: event.retry, size: event.size, body: body
            ))
        }
    }
}
