package dev.durbun.internal.android

import android.app.Activity
import android.app.Application
import android.app.UiModeManager
import android.content.Context
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import dev.durbun.internal.AppTools
import java.io.File
import java.lang.ref.WeakReference

/**
 * Android tools in the desktop's Device panel, next to "Dump threads" and "Run garbage collection":
 * - `android.appearance`: light / dark / system for this app (Android 12+, `UiModeManager.setApplicationNightMode`;
 *   Android keeps it for the app until it is set back to System),
 * - `android.dumpViewHierarchy`: the view tree of the visible activities (main thread, at most 5000 views),
 * - `android.dumpPrefs`: every SharedPreferences file of the app (read on Dürbün's thread, never on the main one).
 *
 * Results go back to the desktop and, for the dumps, into the log stream (like the thread dump).
 */
internal class AndroidAppTools(
    private val app: Application,
    /** Writes a log line on behalf of a tool: message, tag, JSON data. */
    private val log: (String, String, Any?) -> Unit,
) : AppTools {
    private val main = Handler(Looper.getMainLooper())
    private val activities = ActivityTracker()

    @Volatile
    private var appearance = APPEARANCE_SYSTEM

    init {
        app.registerActivityLifecycleCallbacks(activities)
    }

    override fun stop() {
        app.unregisterActivityLifecycleCallbacks(activities)
    }

    override fun descriptors(): List<Map<String, Any?>> = listOf(
        linkedMapOf(
            "id" to APPEARANCE,
            "kind" to "select",
            "label" to "Appearance",
            "labelKey" to APPEARANCE,
            "group" to GROUP,
            "options" to listOf(
                linkedMapOf("value" to APPEARANCE_SYSTEM, "label" to "System"),
                linkedMapOf("value" to "light", "label" to "Light"),
                linkedMapOf("value" to "dark", "label" to "Dark"),
            ),
            "value" to appearance,
        ),
        linkedMapOf(
            "id" to DUMP_VIEWS,
            "kind" to "button",
            "label" to "Dump view hierarchy",
            "labelKey" to DUMP_VIEWS,
            "group" to GROUP,
        ),
        linkedMapOf(
            "id" to DUMP_PREFS,
            "kind" to "button",
            "label" to "Dump SharedPreferences",
            "labelKey" to DUMP_PREFS,
            "group" to GROUP,
        ),
    )

    override fun run(
        name: String,
        params: Map<String, Any?>,
        done: (data: Any?, error: String?, changed: Boolean) -> Unit,
    ): Boolean {
        when (name) {
            APPEARANCE -> setAppearance(params, done)
            DUMP_VIEWS -> main.post {
                try {
                    val dump = ViewDump.of(activities.visible())
                    val data = linkedMapOf<String, Any?>("windows" to dump.windows, "views" to dump.views)
                    log("View hierarchy — ${dump.views} views in ${dump.windows} windows\n${dump.text}", "ui", data)
                    done(data, null, false)
                } catch (t: Throwable) {
                    done(null, t.message ?: t.javaClass.simpleName, false)
                }
            }
            DUMP_PREFS -> {
                // Commands arrive on Dürbün's I/O thread: reading the files here keeps them off the main thread.
                val prefs = readPreferences()
                val keys = prefs.values.sumOf { it.size }
                log("SharedPreferences — ${prefs.size} files, $keys keys", "prefs", prefs)
                done(prefs, null, false)
            }
            else -> return false
        }
        return true
    }

    private fun setAppearance(params: Map<String, Any?>, done: (Any?, String?, Boolean) -> Unit) {
        val mode = (params["value"] ?: params["mode"])?.toString()?.lowercase() ?: APPEARANCE_SYSTEM
        val nightMode = when (mode) {
            APPEARANCE_SYSTEM -> UiModeManager.MODE_NIGHT_AUTO
            "light" -> UiModeManager.MODE_NIGHT_NO
            "dark" -> UiModeManager.MODE_NIGHT_YES
            else -> {
                done(null, "Unknown appearance '$mode' (use system, light or dark)", false)
                return
            }
        }
        if (Build.VERSION.SDK_INT < 31) {
            done(null, "Switching this app's appearance needs Android 12 (API 31) or newer.", false)
            return
        }
        main.post {
            try {
                val manager = app.getSystemService(Context.UI_MODE_SERVICE) as UiModeManager
                manager.setApplicationNightMode(nightMode)
                appearance = mode
                done(mode, null, true)
            } catch (t: Throwable) {
                done(null, t.message ?: t.javaClass.simpleName, false)
            }
        }
    }

    /** File name (without `.xml`) → its entries; string sets become sorted lists. */
    private fun readPreferences(): Map<String, Map<String, Any?>> {
        val dir = File(app.applicationInfo.dataDir ?: return emptyMap(), "shared_prefs")
        val names = dir.list()?.filter { it.endsWith(".xml") }?.map { it.removeSuffix(".xml") }?.sorted().orEmpty()
        val result = LinkedHashMap<String, Map<String, Any?>>()
        for (name in names.take(MAX_PREF_FILES)) {
            val entries = try {
                app.getSharedPreferences(name, Context.MODE_PRIVATE).all
            } catch (t: Throwable) {
                mapOf("(unreadable)" to (t.message ?: t.javaClass.simpleName))
            }
            result[name] = entries.toSortedMap().mapValuesTo(LinkedHashMap()) { (_, value) ->
                if (value is Set<*>) value.map { it.toString() }.sorted() else value
            }
        }
        return result
    }

    /** Started (visible) activities, oldest first; weak, so a leaked activity is never kept alive. */
    private class ActivityTracker : Application.ActivityLifecycleCallbacks {
        private val started = ArrayList<WeakReference<Activity>>()

        @Synchronized
        fun visible(): List<Activity> = started.mapNotNull { it.get() }.filter { !it.isFinishing }

        @Synchronized
        override fun onActivityStarted(activity: Activity) {
            started.removeAll { it.get() == null || it.get() === activity }
            started += WeakReference(activity)
        }

        @Synchronized
        override fun onActivityStopped(activity: Activity) {
            started.removeAll { it.get() == null || it.get() === activity }
        }

        override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
        override fun onActivityResumed(activity: Activity) = Unit
        override fun onActivityPaused(activity: Activity) = Unit
        override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
        override fun onActivityDestroyed(activity: Activity) = Unit
    }

    companion object {
        const val GROUP = "android"
        const val APPEARANCE = "android.appearance"
        const val DUMP_VIEWS = "android.dumpViewHierarchy"
        const val DUMP_PREFS = "android.dumpPrefs"
        const val APPEARANCE_SYSTEM = "system"
        private const val MAX_PREF_FILES = 200
    }
}

/** Text dump of view trees, one line per view, in the same shape as the iOS SDK's. Main thread only. */
internal object ViewDump {
    class Result(val text: String, val windows: Int, val views: Int)

    private const val MAX_VIEWS = 5_000

    fun of(activities: List<Activity>): Result {
        val lines = ArrayList<String>()
        var count = 0
        var windows = 0
        for (activity in activities) {
            val root = activity.window?.peekDecorView() ?: continue
            windows++
            lines += activity.javaClass.name
            count = describe(root, 1, lines, count)
        }
        if (count >= MAX_VIEWS) lines += "… (truncated at $MAX_VIEWS views)"
        if (windows == 0) lines += "(no visible activity)"
        return Result(lines.joinToString("\n"), windows, count)
    }

    private fun describe(view: View, depth: Int, lines: MutableList<String>, countIn: Int): Int {
        if (countIn >= MAX_VIEWS) return countIn
        var count = countIn + 1
        val parts = ArrayList<String>(6)
        parts += view.javaClass.simpleName.ifEmpty { view.javaClass.name }
        parts += "(${view.left} ${view.top}; ${view.width}×${view.height})"
        when (view.visibility) {
            View.GONE -> parts += "gone"
            View.INVISIBLE -> parts += "invisible"
        }
        if (view.alpha < 1f) parts += "alpha=${Math.round(view.alpha * 100) / 100.0}"
        idName(view)?.let { parts += "id=\"$it\"" }
        if (view is TextView) {
            val text = view.text?.toString().orEmpty()
            if (text.isNotEmpty()) parts += "text=\"${text.take(40).replace("\n", " ")}\""
        }
        view.contentDescription?.toString()?.takeIf { it.isNotEmpty() }?.let { parts += "desc=\"${it.take(40)}\"" }
        lines += "  ".repeat(depth) + parts.joinToString(" ")
        if (view is ViewGroup) {
            for (i in 0 until view.childCount) {
                val child = view.getChildAt(i) ?: continue
                count = describe(child, depth + 1, lines, count)
                if (count >= MAX_VIEWS) break
            }
        }
        return count
    }

    private fun idName(view: View): String? {
        val id = view.id
        if (id == View.NO_ID || id ushr 24 == 0) return null // ids made at run time (View.generateViewId) have no resource name
        return try {
            view.resources?.getResourceEntryName(id)
        } catch (_: Throwable) {
            null
        }
    }
}
