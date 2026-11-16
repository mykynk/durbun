import Foundation

/// Incremental Server-Sent Events parser (the WHATWG `text/event-stream` rules) over raw bytes: chunks
/// may end anywhere, inside an event, a line, a CRLF pair or a UTF-8 character. Lines end with CRLF, LF
/// or CR; `:` lines are comments; a leading BOM is skipped; an event is dispatched at a blank line when
/// it has `data`. Memory stays bounded whatever the server sends: the data of one event is kept up to
/// `cap` bytes (its full size is still counted), other field values up to `maxValueBytes`.
struct SSEParser {
    struct Event: Equatable {
        /// `event:` (nil for the default "message").
        var event: String?
        /// `id:` of this event.
        var id: String?
        /// `retry:` of this event, ms.
        var retry: Int?
        /// The data lines joined with "\n", cut at `cap` bytes.
        var data: [UInt8]
        /// Full size of the joined data in bytes.
        var size: Int
    }

    static let maxValueBytes = 1024

    private enum Field {
        case data, event, id, retry, other
    }

    private enum Part {
        case name, value, comment
    }

    /// Payload bytes kept per event.
    var cap: Int

    /// Skipping to the next event boundary (after data was missed).
    private var resyncing: Bool
    /// While resyncing: a line ended since then, so a blank line after it is a real boundary.
    private var sawLineEnd = false
    private var afterCR = false
    /// Bytes of the leading BOM matched so far (-1: the stream start is behind us).
    private var bomMatched: Int

    // The line being read.
    private var lineLength = 0
    private var part = Part.name
    private var name: [UInt8] = []
    private var field = Field.other
    private var skipSpace = false
    private var value: [UInt8] = []
    private var valueOverflow = false

    // The event being built.
    private var data: [UInt8] = []
    private var dataSize = 0
    private var dataLines = 0
    private var eventType: [UInt8]?
    private var eventId: String?
    private var retry: Int?

    /// - Parameter resync: the stream started before this parser: skip to the next event boundary.
    init(cap: Int, resync: Bool = false) {
        self.cap = max(0, cap)
        resyncing = resync
        bomMatched = resync ? -1 : 0
    }

    private static let bom: [UInt8] = [0xEF, 0xBB, 0xBF]

    mutating func push(_ chunk: Data) -> [Event] {
        var events: [Event] = []
        chunk.withUnsafeBytes { raw in
            for byte in raw.bindMemory(to: UInt8.self) { consume(byte, into: &events) }
        }
        return events
    }

    private mutating func consume(_ byte: UInt8, into events: inout [Event]) {
        if bomMatched >= 0 {
            if byte == Self.bom[bomMatched] {
                bomMatched += 1
                if bomMatched == Self.bom.count { bomMatched = -1 }
                return
            }
            // Not a BOM after all: replay what was held back.
            let held = bomMatched
            bomMatched = -1
            for index in 0..<held { consume(Self.bom[index], into: &events) }
        }
        if byte == 0x0A, afterCR {
            afterCR = false
            return
        }
        afterCR = false
        if byte == 0x0D || byte == 0x0A {
            afterCR = byte == 0x0D
            endLine(into: &events)
            return
        }
        lineLength += 1
        guard !resyncing else { return }
        switch part {
        case .name:
            if byte == 0x3A { // ':'
                if lineLength == 1 {
                    part = .comment
                } else {
                    beginValue()
                }
            } else if name.count <= 8 {
                name.append(byte)
            }
        case .value:
            if skipSpace {
                skipSpace = false
                if byte == 0x20 { return }
            }
            switch field {
            case .data:
                dataSize += 1
                if data.count < cap { data.append(byte) }
            case .event, .id, .retry:
                if value.count < Self.maxValueBytes { value.append(byte) } else { valueOverflow = true }
            case .other:
                break
            }
        case .comment:
            break
        }
    }

    private mutating func beginValue() {
        field = Self.field(named: name)
        part = .value
        skipSpace = true
        if field == .data { beginDataLine() }
    }

    private mutating func beginDataLine() {
        if dataLines > 0 {
            dataSize += 1
            if data.count < cap { data.append(0x0A) }
        }
        dataLines += 1
    }

    private mutating func endLine(into events: inout [Event]) {
        defer {
            lineLength = 0
            part = .name
            name.removeAll(keepingCapacity: true)
            field = .other
            skipSpace = false
            value.removeAll(keepingCapacity: true)
            valueOverflow = false
        }
        if resyncing {
            if lineLength == 0 && sawLineEnd {
                resyncing = false
                resetEvent()
            }
            sawLineEnd = true
            return
        }
        if lineLength == 0 {
            dispatch(into: &events)
            return
        }
        switch part {
        case .name:
            // A field name without a colon: the value is empty.
            beginValue()
            applyValue()
        case .value:
            applyValue()
        case .comment:
            break
        }
    }

    private mutating func applyValue() {
        switch field {
        case .event:
            eventType = value
        case .id:
            // An id with NULL is ignored (spec); a cut id would be wrong, so a too long one is too.
            if !value.contains(0), !valueOverflow { eventId = String(decoding: value, as: UTF8.self) }
        case .retry:
            if !value.isEmpty, !valueOverflow, value.allSatisfy({ $0 >= 0x30 && $0 <= 0x39 }) {
                retry = Int(String(decoding: value, as: UTF8.self))
            }
        case .data, .other:
            break
        }
    }

    private mutating func dispatch(into events: inout [Event]) {
        defer { resetEvent() }
        guard dataLines > 0 else { return }
        var type: String?
        if let eventType, !eventType.isEmpty {
            let text = BodyCapture.decodeUTF8(Data(eventType), allowTrimmingPartialCharacter: true)
                ?? String(decoding: eventType, as: UTF8.self)
            if text != "message" { type = text }
        }
        events.append(Event(event: type, id: eventId, retry: retry, data: data, size: dataSize))
    }

    private mutating func resetEvent() {
        data = []
        dataSize = 0
        dataLines = 0
        eventType = nil
        eventId = nil
        retry = nil
    }

    private static func field(named name: [UInt8]) -> Field {
        switch name {
        case Array("data".utf8): return .data
        case Array("event".utf8): return .event
        case Array("id".utf8): return .id
        case Array("retry".utf8): return .retry
        default: return .other
        }
    }
}
