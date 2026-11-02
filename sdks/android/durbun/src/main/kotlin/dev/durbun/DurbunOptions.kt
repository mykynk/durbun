package dev.durbun

/**
 * Configuration for [Durbun.start]. Every value has a sensible default; USB and emulators need none.
 *
 * ```kotlin
 * Durbun.start(this, DurbunOptions(host = "192.168.1.20"))   // Wi-Fi: the Mac's IP address
 * ```
 */
data class DurbunOptions @JvmOverloads constructor(
    /**
     * Desktop address for Wi-Fi connections (for example `"192.168.1.20"`). `127.0.0.1` (adb reverse, set up
     * automatically by Dürbün over USB) and, on emulators, `10.0.2.2` are always tried first.
     */
    val host: String? = null,
    /** Desktop SDK port. */
    val port: Int = DEFAULT_PORT,
    /** Master switch: `false` makes every Dürbün call a no-op. */
    val enabled: Boolean = true,
    /** Run even when the app is not debuggable (release builds). Off by default so nothing leaks to users. */
    val forceInRelease: Boolean = false,
    /** Override the desktop's "capture bodies" setting; `null` follows the desktop. */
    val captureBodies: Boolean? = null,
    /** Override the desktop's per-body capture limit in bytes; `null` follows the desktop. */
    val maxBodyBytes: Int? = null,
    /** Outgoing messages kept while the desktop is unreachable; the oldest are dropped first. */
    val maxBufferedMessages: Int = DEFAULT_MAX_BUFFERED_MESSAGES,
    /** Report uncaught exceptions as crashes. The previously installed handler always runs afterwards. */
    val captureCrashes: Boolean = true,
    /** Send CPU, memory, FPS and janky-frame samples. */
    val captureMetrics: Boolean = true,
    /**
     * Forward this app's own logcat lines when the desktop cannot read the device's logs (Wi-Fi without adb).
     * Over USB the desktop already streams logcat, so nothing is duplicated.
     */
    val captureLogcat: Boolean = true,
    /** Display name shown on the desktop; defaults to the app label. */
    val appName: String? = null,
) {
    companion object {
        /** Default desktop SDK port (raw TCP, newline-delimited JSON). */
        const val DEFAULT_PORT: Int = 9751

        /** Default size of the offline ring buffer. */
        const val DEFAULT_MAX_BUFFERED_MESSAGES: Int = 5_000
    }
}
