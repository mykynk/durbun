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
/// (the SDK reports the count once a connection is back). Stream messages (`net.ws` / `net.sse`) go
/// first: while any is queued, the oldest of them is dropped instead of a log line or a request.
typealias OutgoingBuffer = BoundedQueue<Data>

extension BoundedQueue where Element == Data {
    /// - Parameters:
    ///   - stream: a stream message, dropped before any other line under pressure.
    ///   - evictOldest: false lets one line exceed the limits (used for the SDK's own "messages were
    ///     dropped" notice, which must not evict what it reports about).
    mutating func append(_ line: Data, stream: Bool = false, evictOldest: Bool = true) {
        append(line, weight: line.count, droppable: stream, evictOldest: evictOldest)
    }
}

/// Bounded FIFO. Over `maxMessages` items or `maxBytes` of weight, the oldest droppable item goes
/// first, then the oldest item of any kind; both are counted.
struct BoundedQueue<Element> {
    let maxMessages: Int
    let maxBytes: Int

    private struct Slot {
        var element: Element
        var weight: Int
    }

    /// nil: a droppable item removed from the middle (never at `head`).
    private var items: [Slot?] = []
    private var head = 0
    /// Position of `items[0]` since the queue was created (positions in `droppable` are absolute).
    private var base = 0
    /// Absolute positions of the queued droppable items, oldest first (from `droppableHead`).
    private var droppable: [Int] = []
    private var droppableHead = 0
    private(set) var count = 0
    private(set) var byteCount = 0
    /// Dropped items that were not droppable (reported as "messages were dropped").
    private(set) var droppedCount = 0
    /// Dropped droppable items.
    private(set) var droppedDroppableCount = 0

    init(maxMessages: Int, maxBytes: Int) {
        self.maxMessages = max(1, maxMessages)
        self.maxBytes = max(1, maxBytes)
    }

    var isEmpty: Bool { count == 0 }
    var droppableCount: Int { droppable.count - droppableHead }

    mutating func append(_ element: Element, weight: Int, droppable isDroppable: Bool = false, evictOldest: Bool = true) {
        if isDroppable { droppable.append(base + items.count) }
        items.append(Slot(element: element, weight: weight))
        count += 1
        byteCount += weight
        guard evictOldest else { return }
        while count > maxMessages || (byteCount > maxBytes && count > 1) {
            if removeOldestDroppable() != nil {
                droppedDroppableCount += 1
            } else {
                _ = popFirst()
                droppedCount += 1
            }
        }
    }

    func peekFirst() -> Element? {
        head < items.count ? items[head]?.element : nil
    }

    mutating func popFirst() -> Element? {
        guard head < items.count, let slot = items[head] else { return nil }
        if droppableHead < droppable.count, droppable[droppableHead] == base + head { droppableHead += 1 }
        items[head] = nil
        head += 1
        count -= 1
        byteCount -= slot.weight
        skipRemovedAndCompact()
        return slot.element
    }

    /// Removes the oldest droppable item (nil when none is queued).
    mutating func removeOldestDroppable() -> Element? {
        while droppableHead < droppable.count {
            let position = droppable[droppableHead] - base
            droppableHead += 1
            guard position >= head, position < items.count, let slot = items[position] else { continue }
            items[position] = nil
            count -= 1
            byteCount -= slot.weight
            skipRemovedAndCompact()
            return slot.element
        }
        return nil
    }

    /// Removes every droppable item; returns how many there were (not counted as dropped).
    @discardableResult
    mutating func removeAllDroppable() -> Int {
        var removed = 0
        while removeOldestDroppable() != nil { removed += 1 }
        return removed
    }

    /// Returns and resets the number of dropped items that were not droppable.
    mutating func takeDroppedCount() -> Int {
        defer { droppedCount = 0 }
        return droppedCount
    }

    /// Returns and resets the number of dropped droppable items.
    mutating func takeDroppedDroppableCount() -> Int {
        defer { droppedDroppableCount = 0 }
        return droppedDroppableCount
    }

    mutating func removeAll() {
        base += items.count
        items.removeAll()
        head = 0
        droppable.removeAll()
        droppableHead = 0
        count = 0
        byteCount = 0
    }

    /// Keeps `items[head]` a live item (or the queue empty) and the arrays from growing forever.
    private mutating func skipRemovedAndCompact() {
        while head < items.count, items[head] == nil { head += 1 }
        if head == items.count {
            base += items.count
            items.removeAll(keepingCapacity: true)
            head = 0
            droppable.removeAll(keepingCapacity: true)
            droppableHead = 0
            return
        }
        if head >= 1024 && head * 2 >= items.count {
            items.removeFirst(head)
            base += head
            head = 0
        }
        if droppableHead >= 1024 && droppableHead * 2 >= droppable.count {
            droppable.removeFirst(droppableHead)
            droppableHead = 0
        }
    }
}
