package dev.durbun.internal

import dev.durbun.Level

/**
 * How an earlier launch of this app ended, as Android records it (`ApplicationExitInfo`, API 30+). Plain values so
 * the formatting is tested on the JVM.
 */
internal class ExitRecord(
    val timestampMs: Long,
    /** `ApplicationExitInfo.REASON_*`. */
    val reason: Int,
    val description: String?,
    /** Exit code, or the signal number for [ExitReports.SIGNALED] and [ExitReports.CRASH_NATIVE]. */
    val status: Int,
    /** `RunningAppProcessInfo.IMPORTANCE_*` when the process died. */
    val importance: Int,
    val pssKb: Long,
    val rssKb: Long,
    val pid: Int,
    val processName: String?,
    /** ANR: the thread dump Android wrote (text); null for other reasons or when unavailable. */
    val traces: String? = null,
)

/** Where earlier exits come from (Android: `ActivityManager.getHistoricalProcessExitReasons`). */
internal interface ExitReasonSource {
    /** Exits newer than the last one reported, oldest first. Disk and binder I/O: call it off the main thread. */
    fun newRecords(): List<ExitRecord>

    /** Every exit up to [timestampMs] was handled (sent, or left to the desktop). */
    fun markHandled(timestampMs: Long)
}

/** Turns [ExitRecord]s into log lines ("Previous launch ended: App Not Responding …"). */
internal object ExitReports {
    // ApplicationExitInfo.REASON_* (stable public constants).
    const val EXIT_SELF = 1
    const val SIGNALED = 2
    const val LOW_MEMORY = 3
    const val CRASH = 4
    const val CRASH_NATIVE = 5
    const val ANR = 6
    const val INITIALIZATION_FAILURE = 7
    const val PERMISSION_CHANGE = 8
    const val EXCESSIVE_RESOURCE_USAGE = 9
    const val DEPENDENCY_DIED = 12
    const val FREEZER = 14

    const val EXIT_TAG = "app-exit"

    /** One line to send, and whether the desktop already reads the same record from the device (adb). */
    class Report(val line: String, val desktopReadsIt: Boolean)

    /**
     * The report for one record, or null for exits the app or the person caused (the app called exit, the user
     * swiped it away or force-stopped it, an update) and for JVM crashes (the crash handler reports those itself).
     */
    fun report(record: ExitRecord): Report? {
        val data = linkedMapOf<String, Any?>(
            "previousLaunch" to true,
            "exitReason" to reasonCode(record.reason),
            "exitedAt" to record.timestampMs,
            "pid" to record.pid,
            "processName" to record.processName,
            "importance" to importanceName(record.importance),
        )
        record.description?.takeIf { it.isNotBlank() }?.let { data["description"] = it }
        if (record.pssKb > 0) data["pssMB"] = mb(record.pssKb)
        if (record.rssKb > 0) data["rssMB"] = mb(record.rssKb)
        val where = if (record.importance in 1..VISIBLE) "in the foreground" else "in the background"
        val (level, kind, message) = when (record.reason) {
            ANR -> Triple(
                Level.FATAL,
                "crash",
                "Previous launch ended: App Not Responding (ANR). The main thread was blocked, so Android " +
                    "closed the app.",
            )
            CRASH_NATIVE -> {
                data["signal"] = record.status
                Triple(
                    Level.FATAL,
                    "crash",
                    "Previous launch ended: native crash (${signalName(record.status)}). The native backtrace " +
                        "is in the device's tombstone; over USB the desktop reads it.",
                )
            }
            LOW_MEMORY -> Triple(
                if (record.importance in 1..VISIBLE) Level.WARN else Level.INFO,
                "text",
                "Previous launch was ended by Android $where to free memory (low memory killer).",
            )
            EXCESSIVE_RESOURCE_USAGE -> Triple(
                Level.WARN,
                "text",
                "Previous launch was ended by Android because it used too many resources $where" +
                    (record.description?.takeIf { it.isNotBlank() }?.let { " ($it)" } ?: "") + ".",
            )
            SIGNALED -> {
                data["signal"] = record.status
                Triple(
                    Level.INFO,
                    "text",
                    "Previous launch was ended by a signal (${signalName(record.status)}) $where.",
                )
            }
            INITIALIZATION_FAILURE -> Triple(
                Level.ERROR,
                "text",
                "Previous launch failed to start (initialization failure).",
            )
            PERMISSION_CHANGE -> Triple(
                Level.INFO,
                "text",
                "Previous launch was ended by Android because a permission of the app was revoked.",
            )
            DEPENDENCY_DIED -> Triple(
                Level.INFO,
                "text",
                "Previous launch was ended because a process it depends on died.",
            )
            FREEZER -> Triple(
                Level.INFO,
                "text",
                "Previous launch was ended by Android while frozen in the background.",
            )
            else -> return null
        }
        val error = if (record.reason == ANR) {
            val stack = record.traces?.let(AnrTraces::mainThreadAndBlockers)
            linkedMapOf<String, Any?>(
                "type" to "ANR",
                "message" to (record.description?.takeIf { it.isNotBlank() } ?: "App Not Responding"),
                "stack" to stack,
            )
        } else {
            null
        }
        val line = Wire.log(
            ts = record.timestampMs,
            level = level.wireName,
            tag = if (kind == "crash") DurbunCore.CRASH_TAG else EXIT_TAG,
            message = message,
            data = data,
            error = error,
            kind = kind,
        )
        return Report(line, desktopReadsIt = record.reason == ANR || record.reason == CRASH_NATIVE)
    }

    fun reasonCode(reason: Int): String = when (reason) {
        EXIT_SELF -> "exitSelf"
        SIGNALED -> "signaled"
        LOW_MEMORY -> "lowMemory"
        CRASH -> "crash"
        CRASH_NATIVE -> "crashNative"
        ANR -> "anr"
        INITIALIZATION_FAILURE -> "initializationFailure"
        PERMISSION_CHANGE -> "permissionChange"
        EXCESSIVE_RESOURCE_USAGE -> "excessiveResourceUsage"
        DEPENDENCY_DIED -> "dependencyDied"
        FREEZER -> "freezer"
        else -> "other"
    }

    private const val VISIBLE = 200

    private fun importanceName(importance: Int): String = when {
        importance <= 0 -> "unknown"
        importance <= 100 -> "foreground"
        importance <= 125 -> "foregroundService"
        importance <= 200 -> "visible"
        importance <= 230 -> "perceptible"
        importance <= 300 -> "service"
        else -> "background"
    }

    private fun mb(kb: Long): Double = Math.round(kb / 1024.0 * 10.0) / 10.0

    fun signalName(signal: Int): String = when (signal) {
        4 -> "SIGILL"
        5 -> "SIGTRAP"
        6 -> "SIGABRT"
        7 -> "SIGBUS"
        8 -> "SIGFPE"
        9 -> "SIGKILL"
        11 -> "SIGSEGV"
        15 -> "SIGTERM"
        31 -> "SIGSYS"
        else -> "signal $signal"
    }
}

/** Picks the useful part of an ANR thread dump: the main thread and the threads holding the locks it waits for. */
internal object AnrTraces {
    private val HELD_BY = Regex("held by (?:thread|tid=)\\s*(\\d+)")
    private val TID = Regex("\\btid=(\\d+)\\b")
    private const val MAX_CHARS = 16_000

    fun mainThreadAndBlockers(dump: String): String? {
        val blocks = dump.split(Regex("\\r?\\n\\s*\\r?\\n")).map { it.trim('\n', '\r') }.filter { it.startsWith("\"") }
        val main = blocks.firstOrNull { it.startsWith("\"main\"") } ?: return null
        val out = StringBuilder(main)
        val seen = HashSet<String>()
        var current = main
        // Follow the lock chain a few steps (main waits for A, A waits for B …).
        repeat(4) {
            val tid = HELD_BY.find(current)?.groupValues?.get(1) ?: return@repeat
            if (!seen.add(tid)) return@repeat
            val holder = blocks.firstOrNull { block ->
                TID.find(block.lineSequence().first())?.groupValues?.get(1) == tid
            } ?: return@repeat
            out.append("\n\n").append(holder)
            current = holder
        }
        return out.toString().take(MAX_CHARS)
    }
}
