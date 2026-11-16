package dev.durbun

import dev.durbun.internal.Json
import dev.durbun.internal.OutboundQueue
import dev.durbun.internal.SdkConfig
import dev.durbun.internal.SseParser
import dev.durbun.internal.Utf8
import dev.durbun.internal.Wire
import dev.durbun.internal.WireBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pieces behind stream capture: SSE parser, UTF-8 cuts, the queue's stream budget, config and wire. */
class StreamPartsTest {
    private class Seen(val event: String?, val id: String?, val retry: Long?, val size: Long, val data: String, val stored: Int)

    private fun parse(chunks: List<ByteArray>, storeLimit: Int = 1024, active: (Int) -> Boolean = { true }, end: Boolean = true): List<Seen> {
        val seen = ArrayList<Seen>()
        val parser = SseParser { e -> seen += Seen(e.event, e.eventId, e.retry, e.size, String(e.data, 0, e.stored, Charsets.UTF_8), e.stored) }
        chunks.forEachIndexed { i, chunk -> parser.feed(chunk, 0, chunk.size, active(i), storeLimit) }
        if (end) parser.endOfStream()
        return seen
    }

    private fun bytes(text: String) = text.toByteArray(Charsets.UTF_8)

    private fun oneByOne(text: String) = bytes(text).map { byteArrayOf(it) }

    private val stream = "\uFEFF: yorum\r\n" +
        "event: güncelleme\r\nid: 42\r\nretry: 1500\r\ndata: satır 1\r\ndata:satır 2\r\n\r\n" +
        "data\n\n" +
        "retry: hızlı\nid: a\u0000b\ndata: x\n\n" +
        "event: tek\n\n" +
        "veri: bilinmeyen\ndata: son\r\r" +
        "data: kesik"

    @Test
    fun parsesTheSameWhateverTheChunks() {
        val whole = parse(listOf(bytes(stream)))
        val split = parse(oneByOne(stream))
        assertEquals(4, whole.size)
        for ((a, b) in whole.zip(split)) {
            assertEquals(a.event, b.event)
            assertEquals(a.id, b.id)
            assertEquals(a.retry, b.retry)
            assertEquals(a.data, b.data)
            assertEquals(a.size, b.size)
        }
        assertEquals(whole.size, split.size)

        val first = whole[0]
        assertEquals("güncelleme", first.event)
        assertEquals("42", first.id)
        assertEquals(1500L, first.retry)
        assertEquals("satır 1\nsatır 2", first.data)
        assertEquals(bytes("satır 1\nsatır 2").size.toLong(), first.size)

        assertEquals("a field name alone is an empty data line", "", whole[1].data)
        assertEquals(0L, whole[1].size)

        assertNull("retry must be digits", whole[2].retry)
        assertNull("an id with NUL is ignored", whole[2].id)
        assertEquals("x", whole[2].data)

        assertEquals("an event without data is not dispatched; unknown fields are ignored", "son", whole[3].data)
        assertNull(whole[3].event)
    }

    @Test
    fun bomOnlyAtTheStartAndLookalikesStay() {
        assertEquals("a", parse(listOf(byteArrayOf(0xEF.toByte(), 0xBB.toByte(), 0xBF.toByte()) + bytes("data: a\n\n")))[0].data)
        // EF without the rest of a BOM is content (here: part of a field name, so the line is ignored).
        assertTrue(parse(listOf(byteArrayOf(0xEF.toByte()) + bytes("data: a\n\n"))).isEmpty())
    }

    @Test
    fun keepsAtMostTheStoreLimitButCountsAll() {
        val big = "data: " + "ş".repeat(1000) + "\n\n"
        val seen = parse(listOf(bytes(big)), storeLimit = 5)[0]
        assertEquals(2000L, seen.size)
        assertEquals(5, seen.stored)
    }

    @Test
    fun eventsSeenPartlyWhileOffAreDropped() {
        val chunks = listOf(bytes("data: önce\n"), bytes("\ndata: sonra\n\n"), bytes("data: kapalı\n\n"))
        val seen = parse(chunks, active = { it == 1 })
        assertEquals(listOf("sonra"), seen.map { it.data })
    }

    @Test
    fun endWithoutBlankLineDiscardsTheEvent() {
        assertTrue(parse(listOf(bytes("data: yarım"))).isEmpty())
        assertTrue(parse(listOf(bytes(":sadece yorum\n\n:bir daha\n\n"))).isEmpty())
    }

    @Test
    fun utf8SizesAndCuts() {
        val text = "aş😀b"
        assertEquals(1L + 2 + 4 + 1, Utf8.size(text))
        assertEquals("a", text.substring(0, Utf8.prefixLength(text, 2)))
        assertEquals("aş", text.substring(0, Utf8.prefixLength(text, 6)))
        assertEquals("never splits a surrogate pair", "aş😀", text.substring(0, Utf8.prefixLength(text, 7)))
        assertEquals(text.length, Utf8.prefixLength(text, 100))
        assertEquals(1L, Utf8.size("\uD800")) // a lone surrogate goes out as '?'
    }

    @Test
    fun streamMessagesAreDroppedBeforeOtherLines() {
        val queue = OutboundQueue(maxMessages = 10, maxChars = 10_000)
        (1..3).forEach { queue.offer("log$it") }
        (1..8).forEach { queue.offer("ws$it", stream = true) }
        assertEquals("streams keep to half of the queue", 8, queue.size())
        (4..8).forEach { queue.offer("log$it") }
        assertEquals(10, queue.size())
        val lines = List(10) { queue.poll(0)!! }
        assertEquals(listOf("log1", "log2", "log3", "ws7", "ws8", "log4", "log5", "log6", "log7", "log8"), lines)
        assertEquals(6L, queue.takeDropped())
        // Only other lines left: the oldest goes, as before.
        (1..11).forEach { queue.offer("x$it") }
        assertEquals("x2", queue.poll(0))
    }

    @Test
    fun droppedStreamMessagesDoNotPileUpWithoutAReader() {
        val queue = OutboundQueue(maxMessages = 100, maxChars = 1_000_000)
        queue.offer("log")
        repeat(100_000) { queue.offer("ws$it", stream = true) }
        assertEquals(51, queue.size())
        assertEquals("log", queue.poll(0))
        assertEquals("ws99950", queue.poll(0))
        assertFalse(queue.isEmpty())
    }

    @Test
    fun streamConfigIsOffUnlessTheLatestConfigSaysSo() {
        val on = SdkConfig.from(mapOf("captureStreams" to true, "maxStreamMessageBytes" to 4096L), SdkConfig())
        assertTrue(on.captureStreams)
        assertEquals(4096, on.maxStreamMessageBytes)
        val older = SdkConfig.from(mapOf("captureBodies" to true, "maxBodyBytes" to 2048L), on)
        assertFalse("an older desktop's config turns it off", older.captureStreams)
        assertEquals(0, older.maxStreamMessageBytes)
        assertEquals(2048, older.maxBodyBytes)
        assertFalse(SdkConfig().captureStreams)
    }

    @Test
    fun wireShapes() {
        val plain = Json.parseObject(Wire.netResponse("okhttp-0", 1.0, 200, "OK", emptyList(), null, null, null, null, false, null))!!
        assertNull(plain["noStream"])
        val untagged = Json.parseObject(Wire.netResponse("okhttp-0", 1.0, 101, null, emptyList(), null, null, null, null, false, null, noStream = true))!!
        assertEquals(true, untagged["noStream"])
        val ws = Json.parseObject(Wire.netWs("okhttp-1", 5, "in", "close", 5, null, 1001, "bye"))!!
        assertEquals(mapOf("type" to "net.ws", "id" to "okhttp-1", "ts" to 5L, "dir" to "in", "opcode" to "close", "size" to 5L, "closeCode" to 1001L, "closeReason" to "bye"), ws)
        val sse = Json.parseObject(Wire.netSse("okhttp-2", 6, "message", "", null, 3, WireBody("utf8", "abc", 3, false)))!!
        assertNull(sse["event"])
        assertNull(sse["eventId"])
        assertEquals(mapOf("encoding" to "utf8", "data" to "abc", "size" to 3L), sse["body"])
        assertEquals(mapOf("type" to "net.sse", "id" to "okhttp-2", "ts" to 7L, "end" to true), Json.parseObject(Wire.netSseEnd("okhttp-2", 7)))
        val long = "ş".repeat(300)
        val capped = Json.parseObject(Wire.netSse("okhttp-3", 8, long, long, null, 0, null))!!
        assertEquals(256, (capped["event"] as String).length)
        assertEquals(256, (capped["eventId"] as String).length)
        val reason = Json.parseObject(Wire.netWs("okhttp-4", 9, "out", "close", 2, null, 1000, "a".repeat(255) + "😀"))!!
        assertEquals("never splits a surrogate pair", "a".repeat(255), reason["closeReason"])
    }
}
