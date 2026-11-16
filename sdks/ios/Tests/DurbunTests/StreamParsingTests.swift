import XCTest
@testable import Durbun

final class SSEParserTests: XCTestCase {
    private func parse(_ chunks: [Data], cap: Int = 1024, resync: Bool = false) -> [SSEParser.Event] {
        var parser = SSEParser(cap: cap, resync: resync)
        return chunks.flatMap { parser.push($0) }
    }

    private func parse(_ text: String, cap: Int = 1024) -> [SSEParser.Event] {
        parse([Data(text.utf8)], cap: cap)
    }

    private func text(_ event: SSEParser.Event) -> String { String(decoding: event.data, as: UTF8.self) }

    func testFieldsAndDispatch() {
        let events = parse("event: update\nid: 7\nretry: 3000\ndata: a\ndata: b\n\ndata: plain\n\n")
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[0].event, "update")
        XCTAssertEqual(events[0].id, "7")
        XCTAssertEqual(events[0].retry, 3000)
        XCTAssertEqual(text(events[0]), "a\nb")
        XCTAssertEqual(events[0].size, 3)
        XCTAssertNil(events[1].event, "event, id and retry belong to their own event")
        XCTAssertNil(events[1].id)
        XCTAssertNil(events[1].retry)
        XCTAssertEqual(text(events[1]), "plain")
    }

    func testLineEndingsCommentsAndOddLines() {
        let stream = ": comment\r\ndata:no space\r\rdata:  two spaces\r\n\r\nevent: message\ndata\n\nevent:\ndata: x\n\nid\ndata: y\n\n"
        let events = parse(stream)
        XCTAssertEqual(events.map(text), ["no space", " two spaces", "", "x", "y"])
        XCTAssertEqual(events.map(\.event), [nil, nil, nil, nil, nil], "\"message\" and an empty type are the default")
        XCTAssertEqual(events[4].id, "", "a bare id field sets an empty id")
    }

    func testEventsWithoutDataAndUnfinishedEventsAreNotDispatched() {
        let events = parse("event: ping\nid: 3\nretry: 10\n\n: keepalive\n\nfoo: bar\n\ndata: unfinished")
        XCTAssertEqual(events, [])
    }

    func testInvalidRetryAndIdWithNullAreIgnored() {
        let events = parse("retry: 12a\nid: a\u{0}b\ndata: x\n\nretry: 99999999999999999999999\ndata: y\n\n")
        XCTAssertEqual(events.count, 2)
        XCTAssertNil(events[0].retry)
        XCTAssertNil(events[0].id)
        XCTAssertNil(events[1].retry, "out of range")
    }

    func testEverySplitPointGivesTheSameEvents() {
        let stream = Data("\u{FEFF}event: çay\r\ndata: Çağrı ✓\r\ndata: 2\r\n\r\n: c\ndata: x\r\rdata: y\n\n".utf8)
        let whole = parse([stream])
        XCTAssertEqual(whole.count, 3)
        XCTAssertEqual(whole[0].event, "çay")
        XCTAssertEqual(text(whole[0]), "Çağrı ✓\n2")
        for split in 1..<stream.count {
            let parts = [stream.prefix(split), stream.suffix(from: split)].map { Data($0) }
            XCTAssertEqual(parse(parts), whole, "split at \(split)")
        }
        // Byte by byte.
        XCTAssertEqual(parse(stream.map { Data([$0]) }), whole)
    }

    func testByteOrderMarkOnlyAtTheStart() {
        XCTAssertEqual(parse("\u{FEFF}data: a\n\n").map(text), ["a"])
        // A BOM later in the stream belongs to the field name (an unknown field).
        XCTAssertEqual(parse("data: a\n\n\u{FEFF}data: b\n\n").map(text), ["a"])
        // Bytes that start like a BOM but are not one are kept.
        XCTAssertEqual(parse([Data([0xEF]), Data("data: a\n\n".utf8)]).count, 0, "an unknown field name")
    }

    func testDataIsCutAtTheCapButTheSizeIsKept() {
        let big = String(repeating: "é", count: 1000) // 2000 bytes
        let events = parse("data: \(big)\ndata: z\n\n", cap: 9)
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].size, 2002)
        XCTAssertEqual(events[0].data.count, 9)
        let body = StreamPayload.utf8Body(Data(events[0].data), size: events[0].size)
        XCTAssertEqual(body.data, "éééé", "cut on a character boundary")
        XCTAssertTrue(body.truncated)
        XCTAssertEqual(body.size, 2002)
    }

    func testCapZeroKeepsOnlySizes() {
        let events = parse("data: hello\n\n", cap: 0)
        XCTAssertEqual(events.first?.size, 5)
        XCTAssertEqual(events.first?.data, [])
    }

    func testAVeryLongLineIsCountedNotKept() {
        var parser = SSEParser(cap: 16)
        XCTAssertEqual(parser.push(Data("data: ".utf8)), [])
        let block = Data(repeating: 0x61, count: 64 * 1024)
        for _ in 0..<64 { XCTAssertEqual(parser.push(block), []) }
        let events = parser.push(Data("\n\n".utf8))
        XCTAssertEqual(events.first?.size, 64 * 64 * 1024)
        XCTAssertEqual(events.first?.data.count, 16)
    }

    func testResyncSkipsToTheNextEventBoundary() {
        // Joined in the middle of "data: first\n\n": the rest of that event is skipped.
        XCTAssertEqual(parse([Data("rst\n\ndata: second\n\n".utf8)], resync: true).map(text), ["second"])
        // The first byte ends a line (its CR was missed): not a blank line yet.
        XCTAssertEqual(parse([Data("\ndata: tail\n\ndata: next\n\n".utf8)], resync: true).map(text), ["next"])
        // The second half of a CRLF and then a blank line.
        XCTAssertEqual(parse([Data("\n\r\ndata: ok\r\n\r\n".utf8)], resync: true).map(text), ["ok"])
    }
}

final class StreamQueueTests: XCTestCase {
    private func strings(_ queue: inout OutgoingBuffer) -> [String] {
        var out: [String] = []
        while let line = queue.popFirst() { out.append(String(decoding: line, as: UTF8.self)) }
        return out
    }

    func testStreamLinesAreDroppedFirstAndOrderIsKept() {
        var queue = OutgoingBuffer(maxMessages: 4, maxBytes: 1 << 20)
        queue.append(Data("req".utf8))
        queue.append(Data("s1".utf8), stream: true)
        queue.append(Data("s2".utf8), stream: true)
        queue.append(Data("log".utf8))
        queue.append(Data("s3".utf8), stream: true)
        queue.append(Data("s4".utf8), stream: true)
        XCTAssertEqual(queue.count, 4)
        XCTAssertEqual(queue.takeDroppedCount(), 0, "no request or log line was dropped")
        XCTAssertEqual(queue.takeDroppedDroppableCount(), 2)
        XCTAssertEqual(strings(&queue), ["req", "log", "s3", "s4"])
    }

    func testWithoutStreamLinesTheOldestLineGoes() {
        var queue = OutgoingBuffer(maxMessages: 2, maxBytes: 1 << 20)
        queue.append(Data("s1".utf8), stream: true)
        queue.append(Data("a".utf8))
        queue.append(Data("b".utf8))
        queue.append(Data("c".utf8))
        XCTAssertEqual(queue.takeDroppedDroppableCount(), 1)
        XCTAssertEqual(queue.takeDroppedCount(), 1)
        XCTAssertEqual(strings(&queue), ["b", "c"])
    }

    func testByteLimitDropsStreamLinesFirst() {
        var queue = OutgoingBuffer(maxMessages: 100, maxBytes: 10)
        queue.append(Data(repeating: 1, count: 4))
        queue.append(Data(repeating: 2, count: 4), stream: true)
        queue.append(Data(repeating: 3, count: 4))
        XCTAssertEqual(queue.count, 2)
        XCTAssertEqual(queue.byteCount, 8)
        XCTAssertEqual(queue.popFirst()?.first, 1)
        XCTAssertEqual(queue.popFirst()?.first, 3)
    }

    func testRemoveAllStreamLines() {
        var queue = OutgoingBuffer(maxMessages: 100, maxBytes: 1 << 20)
        queue.append(Data("s1".utf8), stream: true)
        queue.append(Data("a".utf8))
        queue.append(Data("s2".utf8), stream: true)
        XCTAssertEqual(queue.removeAllDroppable(), 2)
        XCTAssertEqual(queue.takeDroppedDroppableCount(), 0, "a purge is not a drop")
        XCTAssertEqual(queue.peekFirst().map { String(decoding: $0, as: UTF8.self) }, "a")
        XCTAssertEqual(strings(&queue), ["a"])
        XCTAssertTrue(queue.isEmpty)
    }

    func testManyMixedLinesCompactAndStayInOrder() {
        var queue = OutgoingBuffer(maxMessages: 100_000, maxBytes: 1 << 30)
        var model: [(line: String, stream: Bool)] = []
        for index in 0..<10_000 {
            let stream = index % 3 == 0
            queue.append(Data("\(index)".utf8), stream: stream)
            model.append(("\(index)", stream))
            if index % 7 == 0 {
                XCTAssertEqual(queue.popFirst().map { String(decoding: $0, as: UTF8.self) }, model.removeFirst().line)
            }
            if index % 11 == 0, let position = model.firstIndex(where: { $0.stream }) {
                XCTAssertEqual(queue.removeOldestDroppable().map { String(decoding: $0, as: UTF8.self) }, model.remove(at: position).line)
            }
        }
        XCTAssertEqual(queue.count, model.count)
        XCTAssertEqual(queue.droppableCount, model.filter(\.stream).count)
        XCTAssertEqual(strings(&queue), model.map(\.line))
    }

    func testPipelineRunsInOrderAndDropsOldStreamWorkFirst() {
        let pipeline = StreamPipeline(maxItems: 3, maxBytes: 1 << 20)
        let gate = DispatchSemaphore(value: 0)
        var ran: [String] = []
        let lock = NSLock()
        func record(_ name: String) -> () -> Void { { lock.lock(); ran.append(name); lock.unlock() } }
        pipeline.submit(droppable: false) { gate.wait() } // keeps the queue busy
        Thread.sleep(forTimeInterval: 0.05)
        pipeline.submit(droppable: false, record("request"))
        pipeline.submit(droppable: true, record("m1"))
        pipeline.submit(droppable: true, record("m2"))
        pipeline.submit(droppable: false, record("close"))
        gate.signal()
        pipeline.waitUntilIdle()
        XCTAssertEqual(ran, ["request", "m2", "close"])
    }

    func testPayloads() {
        let text = StreamPayload.text("héllo wörld", cap: 2)
        XCTAssertEqual(text.size, 13)
        XCTAssertEqual(text.body?.data, "h", "é is not cut in half")
        XCTAssertEqual(text.body?.truncated, true)
        XCTAssertEqual(text.body?.encoding, .utf8)
        let full = StreamPayload.text("hi", cap: 10)
        XCTAssertEqual(full.body, WireBody(encoding: .utf8, data: "hi", size: 2, truncated: false))
        let binary = StreamPayload.binary(Data([1, 2, 3, 4, 5]), cap: 3)
        XCTAssertEqual(binary.body, WireBody(encoding: .base64, data: "AQID", size: 5, truncated: true))
        XCTAssertNil(StreamPayload.text("hi", cap: 0).body)
        XCTAssertEqual(StreamPayload.binary(Data([1]), cap: 0).size, 1)
        XCTAssertNil(StreamPayload.text("", cap: 10).body)
    }

    func testWebSocketURLs() {
        XCTAssertEqual(WebSocketCapture.webSocketURL(URL(string: "http://h:1/p?q=1")!), "ws://h:1/p?q=1")
        XCTAssertEqual(WebSocketCapture.webSocketURL(URL(string: "https://h/p")!), "wss://h/p")
        XCTAssertEqual(WebSocketCapture.webSocketURL(URL(string: "wss://h/p")!), "wss://h/p")
    }
}
