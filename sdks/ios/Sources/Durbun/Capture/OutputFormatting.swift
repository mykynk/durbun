import Foundation

/// Readability helpers for raw console output (print / NSLog / stderr): level detection, cleanup
/// of redundant prefixes and grouping of continuation lines into one multi-line entry.
enum OutputFormatting {
    struct Classification: Equatable {
        var level: DurbunLogLevel
        /// 'crash' for Swift runtime traps; nil = plain text.
        var kind: String?
    }

    // MARK: Level detection

    private static let crashMarkers = [
        "Fatal error: ",
        "Fatal error\n",
        "Precondition failed",
        "Assertion failed",
        "Unexpectedly found nil while",
    ]

    private static let emojiLevels: [(String, DurbunLogLevel)] = [
        ("💥", .fatal), ("☠️", .fatal),
        ("❌", .error), ("⛔", .error), ("🔴", .error), ("🛑", .error), ("‼️", .error), ("🚨", .error),
        ("⚠️", .warning), ("⚠", .warning), ("🟡", .warning), ("🟠", .warning),
        ("🐞", .debug), ("🐛", .debug), ("🔍", .debug),
        ("ℹ️", .info), ("🟢", .info), ("💚", .verbose),
    ]

    private static let levelWords: [(String, DurbunLogLevel)] = [
        ("verbose", .verbose), ("trace", .verbose),
        ("debug", .debug),
        ("info", .info), ("notice", .info),
        ("warning", .warning), ("warn", .warning),
        ("error", .error), ("err", .error),
        ("fatal", .fatal), ("critical", .fatal),
    ]

    /// `[ERROR]`, `<warn>`, `(debug)`, `|INFO|` or `Error:` near the start of the line.
    private static let levelPattern: NSRegularExpression? = {
        let words = levelWords.map(\.0).joined(separator: "|")
        let pattern = "(?i)(?:^|[\\s\\]])(?:[\\[<(|]\\s*(\(words))\\s*[\\]>)|]|(\(words))\\s*:)"
        return try? NSRegularExpression(pattern: pattern)
    }()

    static func classify(_ firstLine: String) -> Classification {
        if crashMarkers.contains(where: { firstLine.contains($0) }) {
            return Classification(level: .fatal, kind: "crash")
        }
        if firstLine.hasPrefix("*** Terminating app due to uncaught exception") {
            return Classification(level: .fatal, kind: nil)
        }
        let trimmed = firstLine.drop(while: { $0 == " " || $0 == "\t" })
        for (emoji, level) in emojiLevels where trimmed.hasPrefix(emoji) {
            return Classification(level: level, kind: nil)
        }
        let head = String(firstLine.prefix(48))
        if let regex = levelPattern,
           let match = regex.firstMatch(in: head, range: NSRange(location: 0, length: (head as NSString).length))
        {
            for group in 1...2 {
                let range = match.range(at: group)
                guard range.location != NSNotFound else { continue }
                let word = (head as NSString).substring(with: range).lowercased()
                if let level = levelWords.first(where: { $0.0 == word })?.1 {
                    return Classification(level: level)
                }
            }
        }
        return Classification(level: .info)
    }

    // MARK: Cleanup

    private static let ansiPattern = try? NSRegularExpression(pattern: "\u{1B}\\[[0-9;?]*[ -/]*[@-~]")

    /// `2024-05-01 12:00:00.123456+0300 MyApp[1234:56789] ` (NSLog). The desktop already shows the
    /// time and the app, so the prefix is noise.
    private static let nslogPrefixPattern = try? NSRegularExpression(
        pattern: "^\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}[.,:]\\d{1,6}(?:[+-]\\d{4})? .{1,128}?\\[\\d+:[0-9a-fA-Fx]+\\] "
    )

    static func stripANSI(_ line: String) -> String {
        guard line.contains("\u{1B}"), let regex = ansiPattern else { return line }
        let range = NSRange(location: 0, length: (line as NSString).length)
        return regex.stringByReplacingMatches(in: line, range: range, withTemplate: "")
    }

    static func stripNSLogPrefix(_ line: String) -> String {
        guard let first = line.first, first.isNumber, let regex = nslogPrefixPattern else { return line }
        let range = NSRange(location: 0, length: (line as NSString).length)
        guard let match = regex.firstMatch(in: line, range: range) else { return line }
        return (line as NSString).substring(from: match.range.upperBound)
    }

    // MARK: Grouping

    private static let stackFramePattern = try? NSRegularExpression(pattern: "^\\d+\\s+\\S.*\\s0x[0-9a-fA-F]+\\s")

    /// True when `line` most likely continues the entry whose last line is `previous`: indented
    /// lines, closing brackets, lines after an opening bracket (pretty-printed JSON, `dump()`
    /// output, stack traces).
    static func isContinuation(_ line: String, previous: String) -> Bool {
        guard let first = line.first else { return false }
        if first == " " || first == "\t" { return true }
        if first == "}" || first == "]" || first == ")" { return true }
        if let last = previous.last(where: { !$0.isWhitespace }), last == "{" || last == "[" || last == "(" {
            return true
        }
        if first.isNumber, let regex = stackFramePattern {
            return regex.firstMatch(in: line, range: NSRange(location: 0, length: (line as NSString).length)) != nil
        }
        return false
    }
}

/// Assembles raw output bytes of one stream into entries (lines + continuation grouping).
struct OutputAssembler {
    struct Entry: Equatable {
        var lines: [String]
        var ts: Double
    }

    static let maxPartialBytes = 64 * 1024
    static let maxEntryLines = 500
    static let maxEntryBytes = 128 * 1024
    /// Continuation lines arriving later than this start a new entry.
    static let groupingWindow: Double = 50

    private var partial: [UInt8] = []
    private var pending: Entry?
    private var pendingBytes = 0
    private var pendingLastAppend = 0.0

    var hasPending: Bool { pending != nil }

    /// Feeds bytes; returns entries that are complete.
    mutating func push(_ bytes: UnsafeBufferPointer<UInt8>, now: Double) -> [Entry] {
        var finished: [Entry] = []
        var lineStart = 0
        for index in 0..<bytes.count where bytes[index] == 0x0A {
            partial.append(contentsOf: UnsafeBufferPointer(rebasing: bytes[lineStart..<index]))
            consumeLine(now: now, into: &finished)
            lineStart = index + 1
        }
        if lineStart < bytes.count {
            partial.append(contentsOf: UnsafeBufferPointer(rebasing: bytes[lineStart..<bytes.count]))
            if partial.count > Self.maxPartialBytes { consumeLine(now: now, into: &finished) }
        }
        return finished
    }

    /// Ends the pending entry (and any unterminated line) — after the grouping window or on stop.
    mutating func flush(now: Double, includePartial: Bool) -> [Entry] {
        var finished: [Entry] = []
        if includePartial && !partial.isEmpty { consumeLine(now: now, into: &finished) }
        if let entry = pending { finished.append(entry) }
        pending = nil
        pendingBytes = 0
        return finished
    }

    private mutating func consumeLine(now: Double, into finished: inout [Entry]) {
        var text = String(decoding: partial, as: UTF8.self)
        partial.removeAll(keepingCapacity: true)
        if text.hasSuffix("\r") { text.removeLast() }
        text = OutputFormatting.stripANSI(text)
        guard !text.trimmingCharacters(in: .whitespaces).isEmpty else {
            if let entry = pending { finished.append(entry) }
            pending = nil
            pendingBytes = 0
            return
        }
        if var entry = pending,
           now - pendingLastAppend <= Self.groupingWindow,
           entry.lines.count < Self.maxEntryLines,
           pendingBytes + text.utf8.count <= Self.maxEntryBytes,
           let previous = entry.lines.last,
           OutputFormatting.isContinuation(text, previous: previous)
        {
            entry.lines.append(text)
            pending = entry
            pendingBytes += text.utf8.count
            pendingLastAppend = now
            return
        }
        if let entry = pending { finished.append(entry) }
        pending = Entry(lines: [OutputFormatting.stripNSLogPrefix(text)], ts: now)
        pendingBytes = text.utf8.count
        pendingLastAppend = now
    }
}
