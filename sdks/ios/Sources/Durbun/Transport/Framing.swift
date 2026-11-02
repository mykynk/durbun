import Foundation

/// Splits an inbound byte stream into NDJSON lines (`\n`, tolerating `\r\n`; blank lines skipped).
struct NDJSONFramer {
    struct LineTooLong: Error {}

    /// `MAX_FRAME_BYTES` of the protocol.
    static let maxLineBytes = 16 * 1024 * 1024

    private var buffer = Data()
    private let maxLineBytes: Int

    init(maxLineBytes: Int = NDJSONFramer.maxLineBytes) {
        self.maxLineBytes = maxLineBytes
    }

    var bufferedByteCount: Int { buffer.count }

    mutating func push(_ chunk: Data) throws -> [Data] {
        buffer.append(chunk)
        var lines: [Data] = []
        var start = buffer.startIndex
        while let newline = buffer[start...].firstIndex(of: 0x0A) {
            var end = newline
            if end > start, buffer[buffer.index(before: end)] == 0x0D { end = buffer.index(before: end) }
            if end > start {
                let line = buffer[start..<end]
                if line.contains(where: { $0 != 0x20 && $0 != 0x09 }) { lines.append(Data(line)) }
            }
            start = buffer.index(after: newline)
        }
        if start != buffer.startIndex { buffer = Data(buffer[start...]) }
        if buffer.count > maxLineBytes {
            buffer = Data()
            throw LineTooLong()
        }
        return lines
    }
}

/// Bounded FIFO of serialized outgoing lines. When full, the oldest lines are dropped and counted
/// (the SDK reports the count once a connection is back).
struct OutgoingBuffer {
    let maxMessages: Int
    let maxBytes: Int

    private var items: [Data] = []
    private var head = 0
    private(set) var byteCount = 0
    private(set) var droppedCount = 0

    init(maxMessages: Int, maxBytes: Int) {
        self.maxMessages = max(1, maxMessages)
        self.maxBytes = max(1, maxBytes)
    }

    var count: Int { items.count - head }
    var isEmpty: Bool { count == 0 }

    /// - Parameter evictOldest: false lets one line exceed the limits (used for the SDK's own
    ///   "messages were dropped" notice, which must not evict what it reports about).
    mutating func append(_ line: Data, evictOldest: Bool = true) {
        items.append(line)
        byteCount += line.count
        guard evictOldest else { return }
        while count > maxMessages || (byteCount > maxBytes && count > 1) {
            _ = popFirst()
            droppedCount += 1
        }
    }

    func peekFirst() -> Data? {
        head < items.count ? items[head] : nil
    }

    mutating func popFirst() -> Data? {
        guard head < items.count else { return nil }
        let line = items[head]
        items[head] = Data()
        head += 1
        byteCount -= line.count
        if head == items.count {
            items.removeAll(keepingCapacity: true)
            head = 0
        } else if head >= 1024 && head * 2 >= items.count {
            items.removeFirst(head)
            head = 0
        }
        return line
    }

    /// Returns and resets the number of dropped lines.
    mutating func takeDroppedCount() -> Int {
        defer { droppedCount = 0 }
        return droppedCount
    }

    mutating func removeAll() {
        items.removeAll()
        head = 0
        byteCount = 0
    }
}
