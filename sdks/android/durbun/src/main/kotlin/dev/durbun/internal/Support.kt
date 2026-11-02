package dev.durbun.internal

import dev.durbun.DurbunAction
import java.io.File

/** App actions advertised in `hello.actions` / `{type:'actions'}`: built-ins first, then the app's own. */
internal class ActionRegistry {
    private val actions = LinkedHashMap<String, DurbunAction>()

    @Synchronized
    fun add(action: DurbunAction) {
        actions[action.id] = action
    }

    @Synchronized
    fun remove(id: String): Boolean = actions.remove(id) != null

    @Synchronized
    fun get(id: String): DurbunAction? = actions[id]

    @Synchronized
    fun descriptors(): List<Map<String, Any?>> = BUILT_IN + actions.values.map(::describe)

    companion object {
        const val DUMP_THREADS = "android.dumpThreads"
        const val GC = "android.gc"

        val BUILT_IN: List<Map<String, Any?>> = listOf(
            linkedMapOf(
                "id" to DUMP_THREADS,
                "kind" to "button",
                "label" to "Dump threads",
                "labelKey" to "android.dumpThreads",
                "group" to "android",
            ),
            linkedMapOf(
                "id" to GC,
                "kind" to "button",
                "label" to "Run garbage collection",
                "labelKey" to "android.gc",
                "group" to "android",
            ),
        )

        fun describe(action: DurbunAction): Map<String, Any?> {
            val map = linkedMapOf<String, Any?>(
                "id" to action.id,
                "kind" to action.kind.wireName,
                "label" to action.label,
                "group" to action.group,
            )
            if (action.options.isNotEmpty()) {
                map["options"] = action.options.map { linkedMapOf("value" to it.value, "label" to it.label) }
            }
            action.value?.let { map["value"] = it }
            return map
        }
    }
}

/**
 * Remembers recent SDK log lines (level + first line) so the logcat forwarder can skip the same line when it
 * also reaches logcat (for example Timber with both a DebugTree and a Dürbün tree planted).
 */
internal class RecentLogs(private val capacity: Int = 2_048, private val windowMs: Long = 2_000) {
    private val seen = object : LinkedHashMap<String, Long>(capacity, 0.75f, false) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Long>?): Boolean = size > capacity
    }

    @Synchronized
    fun remember(level: String, message: String, ts: Long) {
        val key = key(level, message)
        seen.remove(key)
        seen[key] = ts
    }

    @Synchronized
    fun isDuplicate(level: String, message: String, ts: Long): Boolean {
        val last = seen[key(level, message)] ?: return false
        return Math.abs(ts - last) <= windowMs
    }

    private fun key(level: String, message: String): String {
        val end = message.indexOf('\n').let { if (it < 0) message.length else it }
        val firstLine = message.substring(0, minOf(end, 200)).trim()
        return "$level|$firstLine"
    }
}

/**
 * Crash reports that could not reach the desktop before the process died; sent on the next launch.
 * The directory is resolved lazily so nothing touches the disk on the main thread at startup.
 */
internal class PendingCrashStore(private val dirProvider: () -> File?) {
    constructor(dir: File) : this({ dir })

    private fun file(): File? = dirProvider()?.let { File(it, "pending-crashes.ndjson") }

    fun save(line: String) {
        try {
            val f = file() ?: return
            f.parentFile?.mkdirs()
            f.appendText(line + "\n", Charsets.UTF_8)
        } catch (_: Throwable) {
        }
    }

    /** Reads and deletes stored crashes (at most the last [max]). */
    fun drain(max: Int = 5): List<String> {
        return try {
            val f = file() ?: return emptyList()
            if (!f.exists()) return emptyList()
            val lines = f.readLines(Charsets.UTF_8).filter { it.isNotBlank() }
            f.delete()
            lines.takeLast(max)
        } catch (_: Throwable) {
            emptyList()
        }
    }
}
