package dev.durbun.internal

import java.io.ByteArrayOutputStream
import java.io.InputStream

/**
 * Reads `\n`-terminated UTF-8 lines from a byte stream (NDJSON framing). `\r\n` is accepted. Lines longer
 * than [maxLineBytes] are skipped entirely (the protocol caps frames at 16 MiB). Not thread-safe.
 */
internal class LineReader(
    private val input: InputStream,
    private val maxLineBytes: Int = MAX_FRAME_BYTES,
) {
    private val buffer = ByteArray(16 * 1024)
    private var pos = 0
    private var limit = 0
    private val line = ByteArrayOutputStream(1024)
    private var discarding = false

    /** Next line without its terminator, or `null` at end of stream. */
    fun readLine(): String? {
        while (true) {
            if (pos >= limit) {
                val n = input.read(buffer)
                if (n < 0) {
                    // End of stream: return a final unterminated line, if any.
                    if (line.size() > 0 && !discarding) return takeLine()
                    line.reset()
                    return null
                }
                pos = 0
                limit = n
                continue
            }
            var i = pos
            while (i < limit && buffer[i] != NEWLINE) i++
            append(pos, i - pos)
            if (i < limit) {
                pos = i + 1
                if (discarding) {
                    discarding = false
                    line.reset()
                    continue
                }
                return takeLine()
            }
            pos = limit
        }
    }

    private fun append(from: Int, count: Int) {
        if (count <= 0 || discarding) return
        if (line.size() + count > maxLineBytes) {
            discarding = true
            line.reset()
            return
        }
        line.write(buffer, from, count)
    }

    private fun takeLine(): String {
        val bytes = line.toByteArray()
        line.reset()
        val end = if (bytes.isNotEmpty() && bytes[bytes.size - 1] == CR) bytes.size - 1 else bytes.size
        return String(bytes, 0, end, Charsets.UTF_8)
    }

    companion object {
        /** `MAX_FRAME_BYTES` in the protocol. */
        const val MAX_FRAME_BYTES = 16 * 1024 * 1024
        private const val NEWLINE: Byte = 10
        private const val CR: Byte = 13
    }
}
