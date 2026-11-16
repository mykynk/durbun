package dev.durbun

import android.content.Context
import android.content.pm.ApplicationInfo
import android.util.Log
import dev.durbun.internal.DesktopAddress
import dev.durbun.internal.DesktopHostStore
import dev.durbun.internal.DurbunCore
import dev.durbun.internal.android.AndroidEnvironment
import dev.durbun.internal.android.AndroidRuntime
import java.util.concurrent.CopyOnWriteArrayList

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
 * Apps without code can opt in to a start right after `Application.onCreate` with the `dev.durbun.autoStart`
 * manifest entry (see [DurbunInitProvider]). Every method is safe to call from any thread, before or after [start],
 * and never throws. Release builds
 * (not debuggable) stay silent unless [DurbunOptions.forceInRelease] is set; a build that depends on
 * `durbun-noop` instead carries no Dürbün code at all.
 */
object Durbun {
    /** SDK version reported to the desktop. */
    const val VERSION: String = "0.2.0"

    private const val TAG = "Durbun"

    /** Present in every Flutter app that uses `package:durbun` (the plugin compiles this core in). */
    private const val FLUTTER_PLUGIN_CLASS = "dev.durbun.flutter.DurbunFlutterPlugin"

    private const val FLUTTER_START_NOTE =
        "Durbun.start() is not needed in Flutter apps: package:durbun starts the native layer from Dart."

    @Volatile
    private var core: DurbunCore? = null
    private val lock = Any()

    /** [start] or [stop] was called by the app: the automatic start leaves the decision to it. */
    private var appDecided = false

    /** The running core was started automatically ([DurbunInitProvider]), with default options. */
    private var autoStarted = false
    private val actions = LinkedHashMap<String, DurbunAction>()
    private val connectionListeners = CopyOnWriteArrayList<DurbunConnectionListener>()

    private val notStarted = DurbunConnectionStatus(
        isConnected = false,
        via = null,
        desktopHost = null,
        desktopHostSource = null,
        issue = "notStarted",
        hint = "Dürbün is not running: Durbun.start(context) was not called, or this build is not debuggable " +
            "(see DurbunOptions.forceInRelease).",
        failedAttempts = 0,
    )

    /** Whether the Flutter plugin is part of this app (it starts this core from Dart). Tests replace it. */
    @Volatile
    internal var flutterPluginPresent: () -> Boolean = { classPresent(FLUTTER_PLUGIN_CLASS) }

    /** Starts the Android runtime once every check passed. Tests replace it. */
    @Volatile
    internal var runtimeStarter: (Context, DurbunOptions, List<DurbunAction>) -> DurbunCore =
        { context, options, actions -> AndroidRuntime.start(context, options, actions) }

    /**
     * Starts capturing and connecting to the desktop (127.0.0.1:9751 through adb reverse, the emulator
     * host alias, then [DurbunOptions.host]). Call once, early in `Application.onCreate`.
     * A no-op when [DurbunOptions.enabled] is false, when the app is not debuggable (unless forced), and in
     * Flutter apps (`package:durbun` starts the native layer from Dart, so `--dart-define=DURBUN=false` keeps it
     * off too).
     */
    @JvmStatic
    @JvmOverloads
    fun start(context: Context, options: DurbunOptions = DurbunOptions()) {
        start(context, options, automatic = false)
    }

    /**
     * Posted by [DurbunInitProvider] to run once `Application.onCreate` has returned. Unless the app called [start]
     * or [stop] itself by then, the `dev.durbun.autoStart` manifest entry is read on a Dürbün thread (like
     * `dev.durbun.host`; [DurbunInitProvider.AUTO_START_DEFAULT] without one) and, when on, Dürbün starts with the
     * default options.
     */
    internal fun startAutomatically(context: Context) {
        synchronized(lock) { if (appDecided) return }
        autoStartRunner(
            Runnable {
                try {
                    val entry = try {
                        autoStartEntry(context)
                    } catch (t: Throwable) {
                        Log.w(TAG, "Could not read ${DurbunInitProvider.AUTO_START_META_DATA}; using the default.", t)
                        null
                    }
                    if (entry ?: DurbunInitProvider.AUTO_START_DEFAULT) start(context, DurbunOptions(), automatic = true)
                } catch (t: Throwable) {
                    Log.w(TAG, "Dürbün could not start automatically; the app continues without it.", t)
                }
            },
        )
    }

    /** The `dev.durbun.autoStart` manifest entry: true / false, or null when there is none. Tests replace it. */
    @Volatile
    internal var autoStartEntry: (Context) -> Boolean? = { context ->
        DurbunInitProvider.parseAutoStart(AndroidEnvironment.manifestEntry(context, DurbunInitProvider.AUTO_START_META_DATA))
    }

    /** Runs the automatic start off the main thread (the manifest read is a binder call). Tests run it inline. */
    @Volatile
    internal var autoStartRunner: (Runnable) -> Unit = { task ->
        Thread(task, "durbun-autostart").apply {
            isDaemon = true
            priority = Thread.NORM_PRIORITY - 1
        }.start()
    }

    private fun start(context: Context, options: DurbunOptions, automatic: Boolean) {
        synchronized(lock) {
            if (automatic && appDecided) return
            if (!automatic) appDecided = true
            val existing = core
            if (existing != null) {
                if (existing.isHosted) {
                    Log.i(TAG, FLUTTER_START_NOTE)
                    return
                }
                if (automatic || !autoStarted) {
                    if (!automatic) Log.w(TAG, "Durbun.start() was already called; ignoring the second call.")
                    return
                }
                // Started automatically before the app's own call (for example from an Activity): the app's
                // options win, so the session is started again with them.
                autoStarted = false
                if (options == DurbunOptions()) return
                core = null
                Log.i(TAG, "Restarting Dürbün with the options given to Durbun.start() (it had started automatically).")
                try {
                    AndroidRuntime.stop(existing)
                } catch (t: Throwable) {
                    Log.w(TAG, "Dürbün did not stop cleanly.", t)
                }
            }
            if (!options.enabled) return
            try {
                if (flutterPluginPresent()) {
                    // Deferred to the plugin: a stray native call must not open a second session.
                    Log.i(TAG, FLUTTER_START_NOTE)
                    return
                }
                val appContext = context.applicationContext ?: context
                val debuggable = (appContext.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0
                if (!debuggable && !options.forceInRelease) {
                    Log.i(TAG, "Dürbün is off: this build is not debuggable (set forceInRelease = true to override).")
                    return
                }
                val started = runtimeStarter(appContext, options, actions.values.toList())
                watchStatus(started)
                core = started
                autoStarted = automatic
            } catch (t: Throwable) {
                Log.w(TAG, "Dürbün could not start; the app continues without it.", t)
            }
        }
    }

    /** Disconnects and stops capturing. [start] may be called again afterwards. */
    @JvmStatic
    fun stop() {
        val current = synchronized(lock) {
            appDecided = true
            autoStarted = false
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
     * Why the app is (not) connected to the desktop, with the next step when it is not (the same words the SDK
     * writes to logcat once, about 10 seconds after start). Handy for an app's own debug menu.
     */
    @JvmStatic
    val connectionStatus: DurbunConnectionStatus
        get() = try {
            core?.connectionStatus() ?: notStarted
        } catch (_: Throwable) {
            notStarted
        }

    /** Calls [listener] (on a Dürbün background thread) whenever [connectionStatus] changes. */
    @JvmStatic
    fun addConnectionListener(listener: DurbunConnectionListener) {
        connectionListeners.addIfAbsent(listener)
    }

    @JvmStatic
    fun removeConnectionListener(listener: DurbunConnectionListener) {
        connectionListeners.remove(listener)
    }

    /**
     * Sets the Mac's address for Wi-Fi at run time, without a rebuild: `"192.168.1.20"` or `"192.168.1.20:9751"`.
     * It wins over [DurbunOptions.host] and the `dev.durbun.host` manifest entry, is tried at once and is kept for
     * the next launches; `null` goes back to the address built into the app. Call it from the app's own debug menu,
     * or with the value of a link the app opens. Works before [start] too. Returns false when [address] is not a
     * host name or IP address (with an optional port).
     */
    @JvmStatic
    fun setDesktopHost(context: Context, address: String?): Boolean {
        try {
            val parsed = if (address.isNullOrBlank()) null else DesktopAddress.parse(address)
            if (parsed == null && !address.isNullOrBlank()) {
                Log.w(TAG, "Not a desktop address: \"$address\" (use the Mac's IP address, e.g. 192.168.1.20).")
                return false
            }
            val current = core
            if (current != null && current.isHosted) {
                Log.i(TAG, "In Flutter apps, set the Mac's address in the in-app panel (Tools → Mac connection).")
                return false
            }
            if (current != null) {
                current.setDesktopHost(parsed)
            } else {
                val appContext = context.applicationContext ?: context
                DesktopHostStore { AndroidEnvironment.settingsDirOf(appContext) }.save(parsed?.toString())
            }
            return true
        } catch (t: Throwable) {
            Log.w(TAG, "Could not set the desktop address.", t)
            return false
        }
    }

    private fun watchStatus(target: DurbunCore) {
        target.onStatusChanged = {
            if (core === target && connectionListeners.isNotEmpty()) {
                val status = target.connectionStatus()
                for (listener in connectionListeners) {
                    try {
                        listener.onConnectionChanged(status)
                    } catch (t: Throwable) {
                        Log.w(TAG, "A connection listener failed.", t)
                    }
                }
            }
        }
    }

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

    /** Actions added with [addAction] so far (the Flutter plugin hands them to its hosted core). */
    internal fun pendingActions(): List<DurbunAction> = synchronized(lock) { actions.values.toList() }

    /**
     * Installs a core hosted by the Flutter plugin, so [log], [event] and [DurbunInterceptor] report through
     * the Flutter SDK's connection. A core started with [start] before (same process) is stopped first: the
     * Flutter side owns the session. Returns the core that was replaced, if any.
     */
    internal fun attachHosted(hosted: DurbunCore): DurbunCore? {
        watchStatus(hosted)
        val previous = synchronized(lock) {
            val p = core
            core = hosted
            p
        }
        if (previous != null && previous !== hosted) {
            try {
                AndroidRuntime.stop(previous)
            } catch (t: Throwable) {
                Log.w(TAG, "Dürbün did not stop the previous session cleanly.", t)
            }
        }
        return previous
    }

    /** Removes [hosted] if it is still the active core (Flutter stopped or the engine went away). */
    internal fun detachHosted(hosted: DurbunCore) {
        val removed = synchronized(lock) {
            if (core === hosted) {
                core = null
                true
            } else {
                false
            }
        }
        try {
            AndroidRuntime.stop(hosted)
        } catch (t: Throwable) {
            if (removed) Log.w(TAG, "Dürbün did not stop cleanly.", t)
        }
    }

    /** Unit tests install a plain-JVM core without Android (and forget whether the app decided). */
    internal fun installForTesting(testCore: DurbunCore?) {
        synchronized(lock) {
            core = testCore
            appDecided = false
            autoStarted = false
        }
    }

    private fun classPresent(name: String): Boolean = try {
        Class.forName(name, false, Durbun::class.java.classLoader)
        true
    } catch (_: ClassNotFoundException) {
        false
    } catch (_: LinkageError) {
        false
    }
}
