package dev.durbun.internal

import dev.durbun.Level
import java.io.BufferedReader
import java.io.IOException
import java.io.InputStreamReader
import java.util.Calendar
import java.util.TimeZone

/** One logcat entry (possibly several physical lines merged). */
internal class LogcatEntry(
    val ts: Long,
    val pid: Int,
    val tid: Int,
    val level: Level,
    val tag: String,
    val message: String,
) {
    fun sameHeader(other: LogcatEntry): Boolean =
        ts == other.ts && pid == other.pid && tid == other.tid && level == other.level && tag == other.tag

    fun withMessage(text: String) = LogcatEntry(ts, pid, tid, level, tag, text)

    override fun toString(): String = "LogcatEntry($ts $pid/$tid ${level.wireName} $tag: $message)"
}

/**
 * Parses `logcat -v threadtime` lines, with or without the `epoch` / `year` / `usec` modifiers:
 * ```
 * 11-02 11:43:12.345  4321  4377 D OkHttp  : --> GET https://api.example.com/users
 * 2026-11-02 11:43:12.345  4321  4377 D OkHttp  : --> GET https://api.example.com/users
 *   1793612592.345  4321  4377 D OkHttp  : --> GET https://api.example.com/users
 * ```
 */
internal object LogcatParser {
    private val EPOCH = Regex("""^\s*(\d{9,11})\.(\d{3})\d*\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s(.*)$""")
    private val DATE =
        Regex("""^(?:(\d{4})-)?(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\.(\d{3})\d*\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s(.*)$""")

    private const val DAY_MS = 86_400_000L

    fun parse(line: String, nowMs: Long = System.currentTimeMillis(), zone: TimeZone = TimeZone.getDefault()): LogcatEntry? {
        if (line.isEmpty() || line.startsWith("--------- ")) return null
        EPOCH.matchEntire(line)?.let { m ->
            val g = m.groupValues
            val ts = g[1].toLong() * 1000 + g[2].toLong()
            return build(ts, g[3], g[4], g[5], g[6])
        }
        DATE.matchEntire(line)?.let { m ->
            val g = m.groupValues
            val calendar = Calendar.getInstance(zone)
            calendar.timeInMillis = nowMs
            val explicitYear = g[1].toIntOrNull()
            val year = explicitYear ?: calendar.get(Calendar.YEAR)
            calendar.clear()
            calendar.set(year, g[2].toInt() - 1, g[3].toInt(), g[4].toInt(), g[5].toInt(), g[6].toInt())
            calendar.set(Calendar.MILLISECOND, g[7].toInt())
            var ts = calendar.timeInMillis
            if (explicitYear == null && ts > nowMs + DAY_MS) {
                calendar.set(Calendar.YEAR, year - 1) // a December line read in January
                ts = calendar.timeInMillis
            }
            return build(ts, g[8], g[9], g[10], g[11])
        }
        return null
    }

    private fun build(ts: Long, pid: String, tid: String, level: String, rest: String): LogcatEntry? {
        val separator = rest.indexOf(": ")
        val tag: String
        val message: String
        when {
            separator >= 0 -> {
                tag = rest.substring(0, separator).trim()
                message = rest.substring(separator + 2)
            }
            rest.endsWith(":") -> {
                tag = rest.substring(0, rest.length - 1).trim()
                message = ""
            }
            else -> {
                tag = rest.trim()
                message = ""
            }
        }
        return LogcatEntry(
            ts = ts,
            pid = pid.toIntOrNull() ?: return null,
            tid = tid.toIntOrNull() ?: return null,
            level = levelOf(level[0]),
            tag = tag,
            message = message,
        )
    }

    fun levelOf(c: Char): Level = when (c) {
        'V' -> Level.VERBOSE
        'D' -> Level.DEBUG
        'I' -> Level.INFO
        'W' -> Level.WARN
        'E' -> Level.ERROR
        else -> Level.FATAL // F, A
    }
}

/**
 * logcat prints each line of a multi-line message (stack traces!) with the same header. Consecutive lines
 * with an identical header (ts, pid, tid, level, tag) are merged back into one readable entry.
 */
internal class LogcatMerger(
    private val maxChars: Int = 256 * 1024,
    private val emit: (LogcatEntry) -> Unit,
) {
    private var pending: LogcatEntry? = null
    private val text = StringBuilder()

    fun add(entry: LogcatEntry) {
        val current = pending
        if (current != null && current.sameHeader(entry) && text.length + entry.message.length < maxChars) {
            text.append('\n').append(entry.message)
            return
        }
        flush()
        pending = entry
        text.setLength(0)
        text.append(entry.message)
    }

    /** A line without a logcat header continues the pending entry. */
    fun continuation(line: String) {
        if (pending != null && text.length + line.length < maxChars) text.append('\n').append(line)
    }

    fun hasPending(): Boolean = pending != null

    fun flush() {
        val current = pending ?: return
        pending = null
        val merged = current.withMessage(text.toString())
        text.setLength(0)
        emit(merged)
    }
}

/**
 * Streams this process's own logcat (`logcat --pid=<own pid>`; apps may always read their own logs) and
 * hands merged entries to [sink]. Used only while the desktop cannot read device logs (Wi-Fi without adb).
 */
internal class LogcatForwarder(
    private val pid: Int,
    private val modernLogcat: Boolean,
    private val logger: InternalLogger,
    private val command: (modern: Boolean) -> List<String> = { modern -> defaultCommand(modern, pid) },
    private val sink: (LogcatEntry) -> Unit,
) : LogcatController {
    private val lock = Any()

    @Volatile
    private var generation = 0

    @Volatile
    private var enabled = false

    @Volatile
    private var process: Process? = null

    /** Newest forwarded timestamp: after a restart, logcat replays its buffer and older lines are skipped. */
    @Volatile
    private var lastTs = 0L

    override fun setEnabled(enabled: Boolean) {
        synchronized(lock) {
            if (this.enabled == enabled) return
            this.enabled = enabled
            val gen = ++generation
            if (enabled) {
                startDaemonThread("durbun-logcat", logger) { loop(gen) }
            } else {
                process?.destroy()
            }
        }
    }

    override fun stop() = setEnabled(false)

    private fun active(gen: Int) = enabled && generation == gen

    private fun loop(gen: Int) {
        var modern = modernLogcat
        var failures = 0
        while (active(gen)) {
            val startedAt = System.nanoTime()
            val parsed = try {
                runOnce(gen, modern)
            } catch (e: IOException) {
                if (failures == 0) logger.warn("Cannot read logcat", e)
                0
            }
            if (!active(gen)) break
            val quickExit = System.nanoTime() - startedAt < QUICK_EXIT_NS
            if (modern && parsed == 0 && quickExit) {
                modern = false // an older logcat rejected `--pid` / `-v epoch`: filter by pid ourselves
                continue
            }
            failures++
            Thread.sleep(minOf(1_000L * failures, 10_000L))
        }
    }

    private fun runOnce(gen: Int, modern: Boolean): Int {
        val barrier = lastTs
        val proc = ProcessBuilder(command(modern)).redirectErrorStream(true).start()
        process = proc
        var parsed = 0
        val merger = LogcatMerger { entry ->
            if (barrier == 0L || entry.ts > barrier) {
                if (entry.ts > lastTs) lastTs = entry.ts
                try {
                    sink(entry)
                } catch (t: Throwable) {
                    logger.warn("Could not forward a logcat line", t)
                }
            }
        }
        try {
            BufferedReader(InputStreamReader(proc.inputStream, Charsets.UTF_8), 16 * 1024).use { reader ->
                while (active(gen)) {
                    if (merger.hasPending() && !reader.ready()) {
                        // End of a burst: give the rest of a multi-line message a moment, then emit it.
                        var waited = 0
                        while (waited < MERGE_WINDOW_MS && !reader.ready()) {
                            Thread.sleep(10)
                            waited += 10
                        }
                        if (!reader.ready()) {
                            merger.flush()
                            continue
                        }
                    }
                    val line = reader.readLine() ?: break
                    if (line.startsWith("--------- ")) continue
                    val entry = LogcatParser.parse(line)
                    if (entry == null) {
                        merger.continuation(line)
                        continue
                    }
                    parsed++
                    if (entry.pid == pid) merger.add(entry)
                }
            }
        } finally {
            merger.flush()
            proc.destroy()
            if (process === proc) process = null
        }
        return parsed
    }

    companion object {
        private const val MERGE_WINDOW_MS = 60
        private const val QUICK_EXIT_NS = 3_000_000_000L

        fun defaultCommand(modern: Boolean, pid: Int): List<String> =
            if (modern) {
                listOf("logcat", "-v", "threadtime", "-v", "epoch", "--pid=$pid")
            } else {
                listOf("logcat", "-v", "threadtime")
            }
    }
}
