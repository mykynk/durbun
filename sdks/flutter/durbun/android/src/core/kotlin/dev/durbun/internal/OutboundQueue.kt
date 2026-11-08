package dev.durbun.internal

import java.util.ArrayDeque
import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Bounded FIFO of encoded NDJSON lines waiting for the desktop. When full (by count or by characters) the
 * OLDEST lines are dropped, so the newest state always survives an outage. Thread-safe.
 *
 * The single consumer (the transport's writer) takes a line with [poll] and reports it with [markWritten]
 * (or puts it back with [requeue]), which lets [isDrained] tell when everything reached the socket.
 */
internal class OutboundQueue(
    private val maxMessages: Int,
    private val maxChars: Long,
) {
    private val lock = ReentrantLock()
    private val notEmpty = lock.newCondition()
    private val lines = ArrayDeque<String>()
    private var chars = 0L
    private var dropped = 0L
    private var inFlight = false

    /** Appends [line]; drops the oldest lines to make room. Returns false when [line] alone exceeds the budget. */
    fun offer(line: String): Boolean {
        lock.withLock {
            if (line.length > maxChars) {
                dropped++
                return false
            }
            while (lines.isNotEmpty() && (lines.size >= maxMessages || chars + line.length > maxChars)) {
                chars -= lines.removeFirst().length
                dropped++
            }
            lines.addLast(line)
            chars += line.length
            notEmpty.signal()
            return true
        }
    }

    /** Puts [line] at the head, ahead of everything else (keepalive replies). */
    fun offerFirst(line: String) = lock.withLock {
        lines.addFirst(line)
        chars += line.length
        notEmpty.signal()
    }

    /** Next line, waiting up to [timeoutMs]; `null` on timeout or interruption. */
    fun poll(timeoutMs: Long): String? {
        lock.withLock {
            var nanos = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            while (lines.isEmpty()) {
                if (nanos <= 0L) return null
                nanos = try {
                    notEmpty.awaitNanos(nanos)
                } catch (_: InterruptedException) {
                    Thread.currentThread().interrupt()
                    return null
                }
            }
            val line = lines.removeFirst()
            chars -= line.length
            inFlight = true
            return line
        }
    }

    /** The line returned by the last [poll] reached the socket. */
    fun markWritten() = lock.withLock {
        inFlight = false
    }

    /** The line returned by the last [poll] could not be written; it goes back to the head. */
    fun requeue(line: String) = lock.withLock {
        lines.addFirst(line)
        chars += line.length
        inFlight = false
        notEmpty.signal()
    }

    /** Nothing queued and nothing being written. */
    fun isDrained(): Boolean = lock.withLock { lines.isEmpty() && !inFlight }

    fun isEmpty(): Boolean = lock.withLock { lines.isEmpty() }

    fun size(): Int = lock.withLock { lines.size }

    /** Number of lines dropped since the last call (and resets the counter). */
    fun takeDropped(): Long = lock.withLock {
        val n = dropped
        dropped = 0
        n
    }

    fun clear() = lock.withLock {
        lines.clear()
        chars = 0
    }
}
