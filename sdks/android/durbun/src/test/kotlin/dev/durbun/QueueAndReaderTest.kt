package dev.durbun

import dev.durbun.internal.LineReader
import dev.durbun.internal.OutboundQueue
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.InputStream

class QueueAndReaderTest {
    @Test
    fun dropsOldestWhenFullByCount() {
        val queue = OutboundQueue(maxMessages = 3, maxChars = 1_000)
        (1..5).forEach { queue.offer("m$it") }
        assertEquals(3, queue.size())
        assertEquals(2L, queue.takeDropped())
        assertEquals(0L, queue.takeDropped())
        assertEquals(listOf("m3", "m4", "m5"), List(3) { queue.poll(0)!! })
        assertNull(queue.poll(10))
    }

    @Test
    fun dropsOldestWhenFullByCharacters() {
        val queue = OutboundQueue(maxMessages = 100, maxChars = 10)
        assertTrue(queue.offer("aaaa"))
        assertTrue(queue.offer("bbbb"))
        assertTrue(queue.offer("cccc")) // 12 chars > 10 → "aaaa" dropped
        assertEquals(listOf("bbbb", "cccc"), List(2) { queue.poll(0)!! })
        assertFalse(queue.offer("x".repeat(11))) // larger than the whole budget
        assertEquals(2L, queue.takeDropped())
    }

    @Test
    fun tracksInFlightLinesForDraining() {
        val queue = OutboundQueue(10, 1_000)
        assertTrue(queue.isDrained())
        queue.offer("a")
        assertFalse(queue.isDrained())
        val line = queue.poll(0)!!
        assertFalse("polled but not written yet", queue.isDrained())
        queue.requeue(line)
        assertEquals("a", queue.poll(0))
        queue.markWritten()
        assertTrue(queue.isDrained())
        queue.offer("b")
        queue.offerFirst("pong")
        assertEquals("pong", queue.poll(0))
    }

    @Test
    fun pollWaitsForProducers() {
        val queue = OutboundQueue(10, 1_000)
        Thread {
            Thread.sleep(50)
            queue.offer("late")
        }.start()
        assertEquals("late", queue.poll(2_000))
    }

    /** Delivers at most [chunk] bytes per read, like a slow socket. */
    private class Trickle(bytes: ByteArray, private val chunk: Int) : InputStream() {
        private val inner = ByteArrayInputStream(bytes)
        override fun read(): Int = inner.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = inner.read(b, off, minOf(len, chunk))
    }

    @Test
    fun readsNdjsonLinesAcrossChunkBoundaries() {
        val text = "{\"type\":\"ping\",\"ts\":1}\n{\"type\":\"mocks\",\"rules\":[]}\r\n\n{\"msg\":\"Çağrı başarısız 🚀\"}\npartial"
        val reader = LineReader(Trickle(text.toByteArray(), 3))
        assertEquals("{\"type\":\"ping\",\"ts\":1}", reader.readLine())
        assertEquals("{\"type\":\"mocks\",\"rules\":[]}", reader.readLine())
        assertEquals("", reader.readLine())
        assertEquals("{\"msg\":\"Çağrı başarısız 🚀\"}", reader.readLine())
        assertEquals("partial", reader.readLine())
        assertNull(reader.readLine())
    }

    @Test
    fun skipsOverlongLines() {
        val text = "short\n" + "x".repeat(100) + "\nafter\n"
        val reader = LineReader(Trickle(text.toByteArray(), 7), maxLineBytes = 50)
        assertEquals("short", reader.readLine())
        assertEquals("after", reader.readLine())
        assertNull(reader.readLine())
    }
}
