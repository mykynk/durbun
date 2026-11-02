import XCTest
@testable import Durbun

final class FramingTests: XCTestCase {
    func testSplitsLinesAcrossChunks() throws {
        var framer = NDJSONFramer()
        XCTAssertEqual(try framer.push(Data(#"{"type":"pi"#.utf8)), [])
        let lines = try framer.push(Data("ng\",\"ts\":1}\r\n\n  \n{\"type\":\"config\"".utf8))
        XCTAssertEqual(lines.map { String(decoding: $0, as: UTF8.self) }, [#"{"type":"ping","ts":1}"#])
        XCTAssertEqual(framer.bufferedByteCount, #"{"type":"config""#.utf8.count)
        let rest = try framer.push(Data("}\n".utf8))
        XCTAssertEqual(rest.map { String(decoding: $0, as: UTF8.self) }, [#"{"type":"config"}"#])
        XCTAssertEqual(framer.bufferedByteCount, 0)
    }

    func testRejectsOversizedLines() {
        var framer = NDJSONFramer(maxLineBytes: 16)
        XCTAssertThrowsError(try framer.push(Data(repeating: 0x41, count: 17)))
        XCTAssertEqual(framer.bufferedByteCount, 0)
        XCTAssertEqual(try framer.push(Data("ok\n".utf8)).count, 1, "recovers after the error")
    }

    func testOutgoingBufferDropsOldestAndCounts() {
        var buffer = OutgoingBuffer(maxMessages: 3, maxBytes: 1 << 20)
        for i in 1...5 { buffer.append(Data("m\(i)\n".utf8)) }
        XCTAssertEqual(buffer.count, 3)
        XCTAssertEqual(buffer.takeDroppedCount(), 2)
        XCTAssertEqual(buffer.takeDroppedCount(), 0, "the counter resets once reported")
        XCTAssertEqual(buffer.popFirst().map { String(decoding: $0, as: UTF8.self) }, "m3\n")
        XCTAssertEqual(buffer.popFirst().map { String(decoding: $0, as: UTF8.self) }, "m4\n")
        XCTAssertEqual(buffer.peekFirst().map { String(decoding: $0, as: UTF8.self) }, "m5\n")
        XCTAssertEqual(buffer.byteCount, 3)
    }

    func testOutgoingBufferByteLimit() {
        var buffer = OutgoingBuffer(maxMessages: 100, maxBytes: 10)
        buffer.append(Data(repeating: 1, count: 6))
        buffer.append(Data(repeating: 2, count: 6))
        XCTAssertEqual(buffer.count, 1)
        XCTAssertEqual(buffer.peekFirst()?.first, 2)
        buffer.append(Data(repeating: 3, count: 50))
        XCTAssertEqual(buffer.count, 1, "a single oversized line is kept rather than dropped")
    }

    func testNoticeCanExceedTheLimitWithoutEvicting() {
        var buffer = OutgoingBuffer(maxMessages: 2, maxBytes: 1 << 20)
        buffer.append(Data("a".utf8))
        buffer.append(Data("b".utf8))
        buffer.append(Data("notice".utf8), evictOldest: false)
        XCTAssertEqual(buffer.count, 3)
        XCTAssertEqual(buffer.takeDroppedCount(), 0)
        XCTAssertEqual(buffer.popFirst().map { String(decoding: $0, as: UTF8.self) }, "a")
    }

    func testOutgoingBufferCompactsAfterManyPops() {
        var buffer = OutgoingBuffer(maxMessages: 10_000, maxBytes: 1 << 30)
        for i in 0..<5000 { buffer.append(Data("\(i)".utf8)) }
        for _ in 0..<4990 { _ = buffer.popFirst() }
        XCTAssertEqual(buffer.count, 10)
        XCTAssertEqual(buffer.popFirst().map { String(decoding: $0, as: UTF8.self) }, "4990")
    }
}

final class OutputFormattingTests: XCTestCase {
    private func level(_ line: String) -> DurbunLogLevel { OutputFormatting.classify(line).level }

    func testClassifiesLevels() {
        XCTAssertEqual(level("plain message"), .info)
        XCTAssertEqual(level("[ERROR] payment declined"), .error)
        XCTAssertEqual(level("12:00:01.234 [Warning] low disk"), .warning)
        XCTAssertEqual(level("Error: could not decode User"), .error)
        XCTAssertEqual(level("warning: deprecated API"), .warning)
        XCTAssertEqual(level("<debug> cache hit"), .debug)
        XCTAssertEqual(level("[network] VERBOSE: retry"), .verbose)
        XCTAssertEqual(level("❌ upload failed"), .error)
        XCTAssertEqual(level("⚠️ slow response"), .warning)
        XCTAssertEqual(level("🐛 state = idle"), .debug)
        XCTAssertEqual(level("information retrieved"), .info, "level words must be delimited")
        XCTAssertEqual(level("the terrorist movie"), .info)
        XCTAssertEqual(level("I/O completed"), .info)
    }

    func testDetectsSwiftRuntimeTraps() {
        let trap = OutputFormatting.classify("Pati/ProfileViewModel.swift:88: Fatal error: Unexpectedly found nil while unwrapping an Optional value")
        XCTAssertEqual(trap, OutputFormatting.Classification(level: .fatal, kind: "crash"))
        XCTAssertEqual(OutputFormatting.classify("Swift/ContiguousArrayBuffer.swift:690: Fatal error: Index out of range").kind, "crash")
        XCTAssertEqual(OutputFormatting.classify("*** Terminating app due to uncaught exception 'NSInvalidArgumentException'").level, .fatal)
    }

    func testStripsNoise() {
        XCTAssertEqual(OutputFormatting.stripANSI("\u{1B}[31mred\u{1B}[0m text"), "red text")
        XCTAssertEqual(OutputFormatting.stripNSLogPrefix("2026-11-02 12:00:01.123456+0300 Pati[1234:56789] Logged in"), "Logged in")
        XCTAssertEqual(OutputFormatting.stripNSLogPrefix("2026-11-02 12:00:01.123 My App[12:0x1a2b] hello"), "hello")
        XCTAssertEqual(OutputFormatting.stripNSLogPrefix("2026 was a good year"), "2026 was a good year")
    }

    func testContinuationRules() {
        XCTAssertTrue(OutputFormatting.isContinuation("  \"id\": 1,", previous: "{"))
        XCTAssertTrue(OutputFormatting.isContinuation("}", previous: "  \"id\": 1"))
        XCTAssertTrue(OutputFormatting.isContinuation("\"a\"", previous: "values = ["))
        XCTAssertTrue(OutputFormatting.isContinuation("3   Pati   0x0000000104a8c2f4 $s4Pati5StoreC4loadyyF + 120", previous: "Stack:"))
        XCTAssertFalse(OutputFormatting.isContinuation("next print", previous: "previous print"))
        XCTAssertFalse(OutputFormatting.isContinuation("", previous: "{"))
    }

    private func push(_ assembler: inout OutputAssembler, _ text: String, now: Double) -> [OutputAssembler.Entry] {
        var bytes = Array(text.utf8)
        return bytes.withUnsafeMutableBufferPointer { assembler.push(UnsafeBufferPointer($0), now: now) }
    }

    func testGroupsPrettyPrintedJSONIntoOneEntry() {
        var assembler = OutputAssembler()
        var entries = push(&assembler, "Response:\n{\n  \"id\": 42,\n  \"name\": \"Çağrı\"\n}\nnext line\n", now: 1000)
        XCTAssertEqual(entries.map(\.lines), [
            ["Response:"],
            ["{", "  \"id\": 42,", "  \"name\": \"Çağrı\"", "}"],
        ], "a separate print stays separate; the pretty-printed JSON becomes one entry")
        entries = assembler.flush(now: 1010, includePartial: false)
        XCTAssertEqual(entries.map(\.lines), [["next line"]])

        var json = OutputAssembler()
        _ = push(&json, "payload = {\n", now: 0)
        _ = push(&json, "  \"ok\": true\n}\n", now: 20)
        XCTAssertEqual(json.flush(now: 40, includePartial: false).map(\.lines), [["payload = {", "  \"ok\": true", "}"]])
    }

    func testSeparatePrintsStaySeparateAndTimingMatters() {
        var assembler = OutputAssembler()
        var entries = push(&assembler, "first\nsecond\n", now: 0)
        XCTAssertEqual(entries.map(\.lines), [["first"]])
        entries = push(&assembler, "  late indented line\n", now: 500)
        XCTAssertEqual(entries.map(\.lines), [["second"]], "a continuation outside the window starts a new entry")
        XCTAssertEqual(assembler.flush(now: 600, includePartial: true).map(\.lines), [["  late indented line"]])
    }

    func testPartialLinesAndCleanup() {
        var assembler = OutputAssembler()
        XCTAssertTrue(push(&assembler, "par", now: 0).isEmpty)
        XCTAssertTrue(push(&assembler, "tial\r\n", now: 1).isEmpty)
        XCTAssertEqual(assembler.flush(now: 2, includePartial: false).map(\.lines), [["partial"]])
        _ = push(&assembler, "\u{1B}[32m2026-11-02 12:00:01.123456+0300 Pati[1:2] green\u{1B}[0m\n\n", now: 3)
        XCTAssertEqual(assembler.flush(now: 4, includePartial: false).map(\.lines), [])
        _ = push(&assembler, "no newline at end", now: 5)
        XCTAssertEqual(assembler.flush(now: 6, includePartial: true).map(\.lines), [["no newline at end"]])
    }

    func testBlankLineEndsEntryAndNSLogPrefixIsRemoved() {
        var assembler = OutputAssembler()
        let entries = push(&assembler, "\u{1B}[32m2026-11-02 12:00:01.123456+0300 Pati[1:2] green\u{1B}[0m\n\nafter\n", now: 0)
        XCTAssertEqual(entries.map(\.lines), [["green"]])
    }
}

final class BodyCaptureTests: XCTestCase {
    func testTextBodiesAreUTF8() {
        let json = Data(#"{"şehir":"İzmir"}"#.utf8)
        let body = BodyCapture.wireBody(captured: json, totalSize: json.count, contentType: "application/json; charset=utf-8", limit: 1024)
        XCTAssertEqual(body?.encoding, .utf8)
        XCTAssertEqual(body?.data, #"{"şehir":"İzmir"}"#)
        XCTAssertEqual(body?.truncated, false)
    }

    func testBinaryBodiesAreBase64() {
        let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00])
        let body = BodyCapture.wireBody(captured: png, totalSize: png.count, contentType: "image/png", limit: 1024)
        XCTAssertEqual(body?.encoding, .base64)
        XCTAssertEqual(body?.data, png.base64EncodedString())
    }

    func testTruncationKeepsRealSizeAndDropsHalfCharacters() {
        let text = String(repeating: "ğ", count: 10) // 2 bytes each
        let body = BodyCapture.wireBody(captured: Data(text.utf8), totalSize: 20, contentType: "text/plain", limit: 5)
        XCTAssertEqual(body?.encoding, .utf8)
        XCTAssertEqual(body?.data, "ğğ")
        XCTAssertEqual(body?.size, 20)
        XCTAssertEqual(body?.truncated, true)
    }

    func testMissingContentTypeIsSniffed() {
        XCTAssertEqual(BodyCapture.wireBody(captured: Data("a=1&b=2".utf8), totalSize: 7, contentType: nil, limit: 100)?.encoding, .utf8)
        XCTAssertEqual(BodyCapture.wireBody(captured: Data([0, 1, 2]), totalSize: 3, contentType: nil, limit: 100)?.encoding, .base64)
        XCTAssertEqual(BodyCapture.wireBody(captured: Data([0xFF, 0xFE, 0x41]), totalSize: 3, contentType: "text/plain", limit: 100)?.encoding, .base64,
                       "invalid UTF-8 falls back to base64")
    }

    func testEmptyAndSizeOnlyBodies() {
        XCTAssertNil(BodyCapture.wireBody(captured: Data(), totalSize: 0, contentType: "text/plain", limit: 10))
        let sizeOnly = BodyCapture.wireBody(captured: Data(), totalSize: 4096, contentType: "application/json", limit: 0)
        XCTAssertEqual(sizeOnly, WireBody(encoding: .utf8, data: "", size: 4096, truncated: true), "captureBodies=false still reports the size")
    }

    func testTextContentTypesMatchProtocol() {
        for type in ["text/html", "application/json", "application/problem+json", "application/xml", "application/javascript",
                     "application/x-www-form-urlencoded", "application/graphql", "application/x-yaml", "text/csv"] {
            XCTAssertTrue(BodyCapture.isTextContentType(type), type)
        }
        for type in ["image/png", "application/octet-stream", "application/pdf", "multipart/form-data; boundary=x", nil] {
            XCTAssertFalse(BodyCapture.isTextContentType(type), type ?? "nil")
        }
    }

    func testAccumulatorCapsCapture() {
        var accumulator = BodyAccumulator(limit: 4)
        accumulator.append(Data([1, 2, 3]))
        accumulator.append(Data([4, 5, 6]))
        XCTAssertEqual(accumulator.data, Data([1, 2, 3, 4]))
        XCTAssertEqual(accumulator.totalSize, 6)
    }

    func testRequestBodyFromStream() {
        var request = URLRequest(url: URL(string: "https://example.com/upload")!)
        request.httpMethod = "POST"
        request.httpBodyStream = InputStream(data: Data(repeating: 7, count: 100_000))
        let result = RequestBody.read(request, captureLimit: 10)
        guard case let .data(data) = result.forward else { return XCTFail("small streams are buffered") }
        XCTAssertEqual(data.count, 100_000)
        XCTAssertEqual(result.totalSize, 100_000)
    }

    func testReplayStreamYieldsPrefixThenRemainder() {
        let prefix = Data("hello ".utf8)
        let rest = InputStream(data: Data("world".utf8))
        rest.open()
        let stream = ReplayStream.make(prefix: prefix, remainder: rest)
        stream.open()
        var collected = Data()
        var buffer = [UInt8](repeating: 0, count: 4)
        while true {
            let n = stream.read(&buffer, maxLength: buffer.count)
            if n <= 0 { break }
            collected.append(buffer, count: n)
        }
        stream.close()
        XCTAssertEqual(String(decoding: collected, as: UTF8.self), "hello world")
    }
}
