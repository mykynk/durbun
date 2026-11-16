package dev.durbun.internal

/**
 * Incremental Server-Sent Events parser (the WHATWG `text/event-stream` rules) over raw bytes, fed with whatever
 * chunks the app happens to read: a chunk may end inside a line, inside a CRLF or inside a UTF-8 character.
 * Lines end with CRLF, LF or CR; a leading UTF-8 BOM is skipped; `:` lines are comments; `data:` lines are joined
 * with "\n"; a blank line dispatches the event (only when it had a `data` line, as in a browser); an event cut
 * off by the end of the stream is discarded.
 *
 * Memory is bounded whatever the server sends: the data of one event is kept up to the store limit given with
 * each chunk (its full size is still counted), and `event` / `id` / `retry` values up to [MAX_FIELD_BYTES].
 * Not thread-safe: one reader feeds it.
 */
internal class SseParser(private val onEvent: (Event) -> Unit) {
    /**
     * One dispatched event. [data] holds the first [stored] bytes of the UTF-8 data (of [size] bytes in all); the
     * parser reuses the array, so read it inside the callback.
     */
    class Event(
        val event: String?,
        val eventId: String?,
        val retry: Long?,
        val size: Long,
        val data: ByteArray,
        val stored: Int,
    )

    private enum class Kind { NAME, DATA, EVENT, ID, RETRY, IGNORE }

    /* line state */
    private var kind = Kind.NAME
    private val name = ByteArray(MAX_NAME_BYTES)
    private var nameLength = 0
    private var lineLength = 0L
    private var skipSpace = false
    private var afterCr = false
    private val value = ByteArray(MAX_FIELD_BYTES)
    private var valueLength = 0
    private var valueHasNul = false

    /* BOM: bytes of EF BB BF matched so far at the start of the stream (-1 once past it) */
    private var bomMatched = 0

    /* event state */
    private var data = ByteArray(0)
    private var stored = 0
    private var size = 0L
    private var dataLines = 0
    private var eventType: String? = null
    private var eventId: String? = null
    private var retry: Long? = null

    /** Some bytes of the event being parsed went by while capture was off: it is not dispatched. */
    private var incomplete = false

    /** The store limit of the current chunk. */
    private var storeLimit = 0

    /**
     * Parses [length] bytes of [bytes] from [offset]. With [active] false (the desktop does not want events right
     * now) only the line structure is followed, and the events those bytes belong to are not dispatched.
     * [storeLimit]: how many data bytes of one event to keep.
     */
    fun feed(bytes: ByteArray, offset: Int, length: Int, active: Boolean, storeLimit: Int) {
        this.storeLimit = if (active) storeLimit.coerceAtLeast(0) else 0
        var i = offset
        val end = offset + length
        while (i < end) {
            val b = bytes[i++].toInt() and 0xFF
            if (!active) incomplete = true
            if (bomMatched >= 0) {
                if (b == BOM[bomMatched]) {
                    bomMatched++
                    if (bomMatched == BOM.size) bomMatched = -1
                    continue
                }
                // Not a BOM after all: the bytes held back are content.
                val held = bomMatched
                bomMatched = -1
                for (k in 0 until held) process(BOM[k])
            }
            process(b)
        }
    }

    /** The stream ended: an event without its blank line is discarded. */
    fun endOfStream() {
        resetLine()
        resetEvent()
    }

    private fun process(b: Int) {
        if (afterCr) {
            afterCr = false
            if (b == LF) return // the LF of a CRLF
        }
        if (b == CR) {
            endLine()
            afterCr = true
            return
        }
        if (b == LF) {
            endLine()
            return
        }
        lineLength++
        if (kind == Kind.NAME) {
            if (b == COLON) {
                startValue(kindOf())
            } else if (nameLength < name.size) {
                name[nameLength++] = b.toByte()
            } else {
                kind = Kind.IGNORE // no field name is this long
            }
            return
        }
        if (skipSpace) {
            skipSpace = false
            if (b == SPACE) return
        }
        when (kind) {
            Kind.DATA -> appendData(b)
            Kind.EVENT, Kind.ID, Kind.RETRY -> {
                if (b == 0) valueHasNul = true
                if (valueLength < value.size) value[valueLength++] = b.toByte()
            }
            else -> Unit
        }
    }

    private fun startValue(fieldKind: Kind) {
        kind = fieldKind
        skipSpace = true
        if (fieldKind == Kind.DATA) {
            if (dataLines > 0) appendData(LF)
            dataLines++
        }
    }

    private fun endLine() {
        if (lineLength == 0L) {
            dispatch()
            return
        }
        // A line without a colon is a field name with an empty value ("data" alone adds an empty data line).
        if (kind == Kind.NAME) startValue(kindOf())
        when (kind) {
            Kind.EVENT -> eventType = valueText()
            Kind.ID -> if (!valueHasNul) eventId = valueText()
            Kind.RETRY -> retryValue()?.let { retry = it }
            else -> Unit
        }
        resetLine()
    }

    private fun dispatch() {
        val dispatchable = dataLines > 0 && !incomplete
        if (dispatchable) {
            onEvent(Event(eventType, eventId, retry, size, data, stored))
        }
        resetEvent()
    }

    private fun appendData(b: Int) {
        size++
        if (stored >= storeLimit) return
        if (stored == data.size) {
            data = data.copyOf(minOf(storeLimit, maxOf(256, data.size * 2)))
        }
        data[stored++] = b.toByte()
    }

    private fun kindOf(): Kind = when {
        nameLength == 0 -> Kind.IGNORE // a comment
        matches("data") -> Kind.DATA
        matches("event") -> Kind.EVENT
        matches("id") -> Kind.ID
        matches("retry") -> Kind.RETRY
        else -> Kind.IGNORE
    }

    private fun matches(field: String): Boolean {
        if (nameLength != field.length) return false
        for (k in 0 until nameLength) if (name[k].toInt() != field[k].code) return false
        return true
    }

    private fun valueText(): String = String(value, 0, BodyCodec.utf8SafeLength(value, valueLength), Charsets.UTF_8)

    /** `retry:` counts only when it is all ASCII digits. */
    private fun retryValue(): Long? {
        if (valueLength == 0 || valueLength > 18) return null
        var n = 0L
        for (k in 0 until valueLength) {
            val d = value[k].toInt()
            if (d < '0'.code || d > '9'.code) return null
            n = n * 10 + (d - '0'.code)
        }
        return n
    }

    private fun resetLine() {
        kind = Kind.NAME
        nameLength = 0
        lineLength = 0
        skipSpace = false
        valueLength = 0
        valueHasNul = false
    }

    private fun resetEvent() {
        if (data.size > KEEP_BUFFER) data = ByteArray(0)
        stored = 0
        size = 0
        dataLines = 0
        eventType = null
        eventId = null
        retry = null
        incomplete = false
    }

    private companion object {
        const val CR = '\r'.code
        const val LF = '\n'.code
        const val COLON = ':'.code
        const val SPACE = ' '.code
        val BOM = intArrayOf(0xEF, 0xBB, 0xBF)

        /** Longest field name that matters ("retry"); longer names are ignored without keeping them. */
        const val MAX_NAME_BYTES = 8

        /** `event`, `id` and `retry` values are cut here. */
        const val MAX_FIELD_BYTES = 1024

        /** A data buffer larger than this is let go after its event. */
        const val KEEP_BUFFER = 16 * 1024
    }
}

/** UTF-8 sizes and cuts of Kotlin strings without encoding them (WebSocket text messages). */
internal object Utf8 {
    /** Bytes [text] takes in UTF-8 (a lone surrogate is sent as `?`, one byte, like Okio does). */
    fun size(text: String): Long {
        var n = 0L
        var i = 0
        val length = text.length
        while (i < length) {
            val c = text[i]
            n += when {
                c.code < 0x80 -> 1
                c.code < 0x800 -> 2
                Character.isHighSurrogate(c) && i + 1 < length && Character.isLowSurrogate(text[i + 1]) -> {
                    i++
                    4
                }
                Character.isSurrogate(c) -> 1
                else -> 3
            }
            i++
        }
        return n
    }

    /** The longest prefix of [text] (in chars, never splitting a surrogate pair) whose UTF-8 fits in [maxBytes]. */
    fun prefixLength(text: String, maxBytes: Int): Int {
        var bytes = 0L
        var i = 0
        val length = text.length
        while (i < length) {
            val c = text[i]
            val pair = Character.isHighSurrogate(c) && i + 1 < length && Character.isLowSurrogate(text[i + 1])
            val n = when {
                c.code < 0x80 -> 1
                c.code < 0x800 -> 2
                pair -> 4
                Character.isSurrogate(c) -> 1
                else -> 3
            }
            if (bytes + n > maxBytes) return i
            bytes += n
            i += if (pair) 2 else 1
        }
        return length
    }
}
