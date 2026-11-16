package dev.durbun.internal

import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Bounded FIFO of encoded NDJSON lines waiting for the desktop. When full (by count or by characters) the
 * OLDEST lines are dropped, so the newest state always survives an outage. Thread-safe.
 *
 * Stream messages (`net.ws` / `net.sse`, offered with `stream = true`) can arrive far faster than anything
 * else, so they get at most half of the budget and are the first to go: a chatty socket drops its own oldest
 * messages before it can push out logs or requests.
 *
 * The single consumer (the transport's writer) takes a line with [poll] and reports it with [markWritten]
 * (or puts it back with [requeue]), which lets [isDrained] tell when everything reached the socket.
 */
internal class OutboundQueue(
    private val maxMessages: Int,
    private val maxChars: Long,
) {
    private class Entry(val line: String, val stream: Boolean) {
        /** Dropped while still in [lines] (removed lazily). */
        var dropped = false
    }

    private val lock = ReentrantLock()
    private val notEmpty = lock.newCondition()
    private val lines = ArrayDeque<Entry>()

    /** The stream entries still in [lines], oldest first. */
    private val streams = ArrayDeque<Entry>()
    private var live = 0
    private var tombstones = 0
    private var chars = 0L
    private var streamChars = 0L
    private var dropped = 0L
    private var inFlight = false

    private val maxStreamMessages = maxOf(1, maxMessages / 2)
    private val maxStreamChars = maxChars / 2

    /**
     * Appends [line]; drops the oldest lines (stream messages first) to make room. Returns false when [line] alone
     * exceeds the budget.
     */
    fun offer(line: String, stream: Boolean = false): Boolean {
        lock.withLock {
            val length = line.length
            if (length > (if (stream) maxStreamChars else maxChars)) {
                dropped++
                return false
            }
            if (stream) {
                while (streams.isNotEmpty() && (streams.size >= maxStreamMessages || streamChars + length > maxStreamChars)) {
                    dropOldestStream()
                }
            }
            while (live > 0 && (live >= maxMessages || chars + length > maxChars)) {
                if (streams.isNotEmpty()) dropOldestStream() else dropHead()
            }
            val entry = Entry(line, stream)
            lines.addLast(entry)
            if (stream) {
                streams.addLast(entry)
                streamChars += length
            }
            live++
            chars += length
            notEmpty.signal()
            return true
        }
    }

    /** Puts [line] at the head, ahead of everything else (keepalive replies). */
    fun offerFirst(line: String) = lock.withLock {
        addFirst(line)
        notEmpty.signal()
    }

    /** Next line, waiting up to [timeoutMs]; `null` on timeout or interruption. */
    fun poll(timeoutMs: Long): String? {
        lock.withLock {
            var nanos = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            while (live == 0) {
                if (nanos <= 0L) return null
                nanos = try {
                    notEmpty.awaitNanos(nanos)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return null
                }
            }
            val entry = removeFirstLive()
            inFlight = true
            return entry.line
        }
    }

    /** The line returned by the last [poll] reached the socket. */
    fun markWritten() = lock.withLock {
        inFlight = false
    }

    /** The line returned by the last [poll] could not be written; it goes back to the head. */
    fun requeue(line: String) = lock.withLock {
        addFirst(line)
        inFlight = false
        notEmpty.signal()
    }

    /** Nothing queued and nothing being written. */
    fun isDrained(): Boolean = lock.withLock { live == 0 && !inFlight }

    fun isEmpty(): Boolean = lock.withLock { live == 0 }

    fun size(): Int = lock.withLock { live }

    /** Number of lines dropped since the last call (and resets the counter). */
    fun takeDropped(): Long = lock.withLock {
        val n = dropped
        dropped = 0
        n
    }

    fun clear() = lock.withLock {
        lines.clear()
        streams.clear()
        live = 0
        tombstones = 0
        chars = 0
        streamChars = 0
    }

    /* ───────────── under [lock] ───────────── */

    private fun addFirst(line: String) {
        lines.addFirst(Entry(line, stream = false))
        live++
        chars += line.length
    }

    /** Removes and returns the oldest entry that was not dropped; [live] must be > 0. */
    private fun removeFirstLive(): Entry {
        while (true) {
            val entry = lines.removeFirst()
            if (entry.dropped) {
                tombstones--
                continue
            }
            live--
            chars -= entry.line.length
            if (entry.stream) {
                streams.removeFirst() // the oldest live stream entry is this one
                streamChars -= entry.line.length
            }
            return entry
        }
    }

    private fun dropHead() {
        removeFirstLive()
        dropped++
    }

    /** Drops the oldest stream message where it is; [lines] lets go of it on the next [poll] or compaction. */
    private fun dropOldestStream() {
        val entry = streams.removeFirst()
        entry.dropped = true
        tombstones++
        live--
        chars -= entry.line.length
        streamChars -= entry.line.length
        dropped++
        // Without a reader (desktop away) dropped entries would pile up: rebuild once they outnumber the rest.
        if (tombstones > COMPACT_AFTER && tombstones > live) {
            val kept = lines.filterTo(ArrayList(live)) { !it.dropped }
            lines.clear()
            lines.addAll(kept)
            tombstones = 0
        }
    }

    private companion object {
        const val COMPACT_AFTER = 64
    }
}
