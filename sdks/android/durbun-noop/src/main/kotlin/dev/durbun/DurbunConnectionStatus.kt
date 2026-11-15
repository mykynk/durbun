package dev.durbun

/**
 * The desktop connection as the app can show it, for example in its own debug menu ([Durbun.connectionStatus],
 * [Durbun.addConnectionListener]).
 */
class DurbunConnectionStatus internal constructor(
    /** A desktop connection completed the handshake. */
    val isConnected: Boolean,
    /** The endpoint of the live connection (`127.0.0.1:9751` over USB, the Mac's address over Wi-Fi). */
    val via: String?,
    /** The Wi-Fi address tried besides USB (`192.168.1.20:9751`), if any. */
    val desktopHost: String?,
    /**
     * Where [desktopHost] comes from: `runtime` ([Durbun.setDesktopHost] or the `durbun.host` launch extra, kept
     * for the next launches), `options` ([DurbunOptions.host]) or `manifest` (the `dev.durbun.host` meta-data).
     */
    val desktopHostSource: String?,
    /**
     * Why there is no connection, once a connect round failed: `desktopNotRunning`, `usbNotSetUp`,
     * `usbDesktopClosed`, `lanRefused`, `lanTimeout`, `lanUnreachable`, `lanBadAddress`, `permissionDenied`,
     * `notDurbun`, `other`; `notStarted` when Dürbün is not running, `notIncluded` in `durbun-noop`. Null while
     * connected or before the first round ended.
     */
    val issue: String?,
    /** What to do next, in one or two English sentences (null while connected). */
    val hint: String?,
    /** Failed connect rounds since the last connection or address change. */
    val failedAttempts: Int,
) {
    override fun toString(): String = when {
        isConnected -> "Connected to the Dürbün desktop via $via"
        hint != null -> "Not connected to the Dürbün desktop: $hint"
        else -> "Connecting to the Dürbün desktop…"
    }
}

/** Called when [Durbun.connectionStatus] changes, on a Dürbün background thread. */
fun interface DurbunConnectionListener {
    fun onConnectionChanged(status: DurbunConnectionStatus)
}
