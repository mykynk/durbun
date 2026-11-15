package dev.durbun

import android.content.Context

/**
 * No-op Dürbün for release builds: the same public API as the `durbun` module, with empty bodies.
 * Nothing is captured, no socket is opened, no thread is started.
 *
 * ```kotlin
 * debugImplementation(project(":durbun"))
 * releaseImplementation(project(":durbun-noop"))
 * ```
 */
object Durbun {
    /** SDK version (kept identical to the `durbun` module). */
    const val VERSION: String = "0.2.0"

    @JvmStatic
    @JvmOverloads
    @Suppress("UNUSED_PARAMETER")
    fun start(context: Context, options: DurbunOptions = DurbunOptions()) = Unit

    @JvmStatic
    fun stop() = Unit

    /** Always false in the no-op module. */
    @JvmStatic
    val isStarted: Boolean
        get() = false

    /** Always false in the no-op module. */
    @JvmStatic
    val isConnected: Boolean
        get() = false

    /** Always "not included" in the no-op module. */
    @JvmStatic
    val connectionStatus: DurbunConnectionStatus
        get() = notIncluded

    private val notIncluded = DurbunConnectionStatus(
        isConnected = false,
        via = null,
        desktopHost = null,
        desktopHostSource = null,
        issue = "notIncluded",
        hint = "This build uses durbun-noop: it contains no Dürbün code.",
        failedAttempts = 0,
    )

    @JvmStatic
    @Suppress("UNUSED_PARAMETER")
    fun addConnectionListener(listener: DurbunConnectionListener) = Unit

    @JvmStatic
    @Suppress("UNUSED_PARAMETER")
    fun removeConnectionListener(listener: DurbunConnectionListener) = Unit

    /** Always false in the no-op module. */
    @JvmStatic
    @Suppress("UNUSED_PARAMETER")
    fun setDesktopHost(context: Context, address: String?): Boolean = false

    @JvmStatic
    @JvmOverloads
    @Suppress("UNUSED_PARAMETER")
    fun log(level: Level, tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) = Unit

    @JvmStatic
    @JvmOverloads
    @Suppress("UNUSED_PARAMETER")
    fun v(tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) = Unit

    @JvmStatic
    @JvmOverloads
    @Suppress("UNUSED_PARAMETER")
    fun d(tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) = Unit

    @JvmStatic
    @JvmOverloads
    @Suppress("UNUSED_PARAMETER")
    fun i(tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) = Unit

    @JvmStatic
    @JvmOverloads
    @Suppress("UNUSED_PARAMETER")
    fun w(tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) = Unit

    @JvmStatic
    @JvmOverloads
    @Suppress("UNUSED_PARAMETER")
    fun e(tag: String?, message: String, data: Any? = null, throwable: Throwable? = null) = Unit

    @JvmStatic
    @JvmOverloads
    @Suppress("UNUSED_PARAMETER")
    fun event(name: String, props: Map<String, Any?>? = null) = Unit

    @JvmStatic
    @Suppress("UNUSED_PARAMETER")
    fun addAction(action: DurbunAction) = Unit

    @JvmStatic
    @Suppress("UNUSED_PARAMETER")
    fun removeAction(id: String) = Unit
}
