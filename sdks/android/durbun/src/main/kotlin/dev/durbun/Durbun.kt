package dev.durbun

import android.content.Context
import android.content.pm.ApplicationInfo
import android.util.Log
import dev.durbun.internal.DurbunCore
import dev.durbun.internal.android.AndroidRuntime

/**
 * Dürbün Android SDK: sends this app's logs, network traffic, crashes, events and performance metrics to
 * the Dürbün desktop app, live.
 *
 * ```kotlin
 * class App : Application() {
 *     override fun onCreate() {
 *         super.onCreate()
 *         Durbun.start(this)                       // USB / emulator: nothing else needed
 *         // Durbun.start(this, DurbunOptions(host = "192.168.1.20"))   // Wi-Fi
 *     }
 * }
 * Durbun.i("auth", "Logged in", data = mapOf("userId" to 42))
 * Durbun.event("purchase", mapOf("amount" to 49.9))
 * ```
 *
 * Every method is safe to call from any thread, before or after [start], and never throws. Release builds
 * (not debuggable) stay silent unless [DurbunOptions.forceInRelease] is set; ship `durbun-noop` in release
 * builds to leave no Dürbün code in the app at all.
 */
object Durbun {
    /** SDK version reported to the desktop. */
    const val VERSION: String = "0.1.0"

    private const val TAG = "Durbun"

    @Volatile
    private var core: DurbunCore? = null
    private val lock = Any()
    private val actions = LinkedHashMap<String, DurbunAction>()

    /**
     * Starts capturing and connecting to the desktop (127.0.0.1:9751 through adb reverse, the emulator
     * host alias, then [DurbunOptions.host]). Call once, early in `Application.onCreate`.
     * A no-op when [DurbunOptions.enabled] is false or the app is not debuggable (unless forced).
     */
    @JvmStatic
    @JvmOverloads
    fun start(context: Context, options: DurbunOptions = DurbunOptions()) {
        synchronized(lock) {
            if (core != null) {
                Log.w(TAG, "Durbun.start() was already called; ignoring the second call.")
                return
            }
            if (!options.enabled) return
            try {
                val appContext = context.applicationContext ?: context
                val debuggable = (appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
                if (!debuggable && !options.forceInRelease) {
                    Log.i(TAG, "Dürbün is off: this build is not debuggable (set forceInRelease = true to override).")
                    return
                }
                core = AndroidRuntime.start(appContext, options, actions.values.toList())
            } catch (t: Throwable) {
                Log.w(TAG, "Dürbün could not start; the app continues without it.", t)
            }
        }
    }

    /** Disconnects and stops capturing. [start] may be called again afterwards. */
    @JvmStatic
    fun stop() {
        val current = synchronized(lock) {
            val c = core
            core = null
            c
        } ?: return
        try {
            AndroidRuntime.stop(current)
        } catch (t: Throwable) {
            Log.w(TAG, "Dürbün did not stop cleanly.", t)
        }
    }

    /** True after a successful [start] (false in release builds and in `durbun-noop`). */
    @JvmStatic
    val isStarted: Boolean
        get() = core != null

    /** True while a desktop connection is active. */
    @JvmStatic
    val isConnected: Boolean
        get() = core?.isConnected == true

    /**
     * Sends a structured log line. [data] (maps, lists, JSON objects, numbers…) is shown as an expandable
     * JSON tree; [throwable] adds the exception with its full stack trace.
     */
    @JvmStatic
    @JvmOverloads
    fun log(level: Level, tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) {
        core?.log(level, tag, message, data, throwable)
    }

    @JvmStatic
    @JvmOverloads
    fun v(tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) =
        log(Level.VERBOSE, tag, message, data, throwable)

    @JvmStatic
    @JvmOverloads
    fun d(tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) =
        log(Level.DEBUG, tag, message, data, throwable)

    @JvmStatic
    @JvmOverloads
    fun i(tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) =
        log(Level.INFO, tag, message, data, throwable)

    @JvmStatic
    @JvmOverloads
    fun w(tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) =
        log(Level.WARN, tag, message, data, throwable)

    @JvmStatic
    @JvmOverloads
    fun e(tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) =
        log(Level.ERROR, tag, message, data, throwable)

    /** Records a custom event (shown as an event row with its properties). */
    @JvmStatic
    @JvmOverloads
    fun event(name: String, props: Map<String, Any?>? = null) {
        core?.event(name, props)
    }

    /** Adds (or replaces, by id) a control shown on the desktop for this app. Works before [start] too. */
    @JvmStatic
    fun addAction(action: DurbunAction) {
        val current = synchronized(lock) {
            actions[action.id] = action
            core
        }
        current?.addAction(action)
    }

    /** Removes a control added with [addAction]. */
    @JvmStatic
    fun removeAction(id: String) {
        val current = synchronized(lock) {
            actions.remove(id)
            core
        }
        current?.removeAction(id)
    }

    internal fun coreOrNull(): DurbunCore? = core

    /** Unit tests install a plain-JVM core without Android. */
    internal fun installForTesting(testCore: DurbunCore?) {
        synchronized(lock) { core = testCore }
    }
}
