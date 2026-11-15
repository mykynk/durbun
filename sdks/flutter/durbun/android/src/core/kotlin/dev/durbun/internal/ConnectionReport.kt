package dev.durbun.internal

import java.net.NoRouteToHostException
import java.net.SocketTimeoutException
import java.net.UnknownHostException

/**
 * Why the app is not connected to the Dürbün desktop, in words a developer can act on. The diagnosis table and
 * the wording are shared by every Dürbün SDK (Flutter, Android, iOS), so all of them say the same thing.
 */
internal object AttemptKind {
    /** Nothing listens on that port (the host answered with a reset). */
    const val REFUSED = "refused"

    /** No answer within the connect timeout (wrong address, other network, firewall). */
    const val TIMEOUT = "timeout"

    /** No route to the host or network. */
    const val UNREACHABLE = "unreachable"

    /** The operating system refused the socket (no INTERNET permission, a firewall app, data saver). */
    const val DENIED = "denied"

    /** The host name could not be resolved. */
    const val LOOKUP = "lookup"

    /** The peer accepted the connection and closed it before the welcome. */
    const val CLOSED = "closed"

    /** The peer accepted the connection but sent no welcome in time. */
    const val NO_WELCOME = "no-welcome"

    /** Anything else. */
    const val ERROR = "error"

    /** Sorts a connect error into one of the kinds above. */
    fun classify(error: Throwable): String {
        val text = buildString {
            append(error.toString())
            error.cause?.let { append(' ').append(it.toString()) }
        }.lowercase()
        return when {
            error is UnknownHostException || "unable to resolve host" in text -> LOOKUP
            error is SecurityException || "eacces" in text || "eperm" in text ||
                "permission denied" in text || "operation not permitted" in text -> DENIED
            error is NoRouteToHostException || "ehostunreach" in text || "enetunreach" in text ||
                "no route to host" in text || "network is unreachable" in text -> UNREACHABLE
            error is SocketTimeoutException || "etimedout" in text || "timed out" in text -> TIMEOUT
            "econnrefused" in text || "connection refused" in text -> REFUSED
            else -> ERROR
        }
    }
}

/** One failed client attempt of the last round: `host:port`, a kind from [AttemptKind], the system's message. */
internal class ConnectAttempt(val endpoint: String, val kind: String, val detail: String = "") {
    val isLoopback: Boolean get() = endpoint.startsWith("127.0.0.1:")

    override fun toString(): String = "$endpoint: $kind"
}

/** What most likely keeps the app from the desktop. The names are the codes `DurbunConnectionStatus.issue` uses. */
internal enum class ConnectIssue {
    /** Simulator, emulator or desktop app: nothing listens on this computer's SDK port. */
    desktopNotRunning,

    /** Android phone without a Wi-Fi address: no `adb reverse` on the cable. */
    usbNotSetUp,

    /** Android phone: `adb reverse` is set up but nothing answers on the Mac. */
    usbDesktopClosed,

    /** iPhone without a Wi-Fi address: the Mac app connects over the cable; it has not come yet. */
    iosUsbWaiting,

    /** The Mac answered but its SDK port is closed to the network. */
    lanRefused,

    /** No answer from the address: wrong address, another network, firewall. */
    lanTimeout,

    /** No route to the address (another network); on iOS also the Local Network permission. */
    lanUnreachable,

    /** The address is not a name or IP the phone can resolve. */
    lanBadAddress,

    /** The operating system did not allow the connection. */
    permissionDenied,

    /** Something answered on the port, but not a Dürbün desktop that took this app. */
    notDurbun,

    /** Any other failure (see the attempts). */
    other,
}

internal object ConnectionDiagnosis {
    /**
     * Picks the most likely [ConnectIssue] for a failed round. [platform] is `android`, `ios` or anything else;
     * [isPhysical] is false on simulators and emulators; [lanEndpoint] is the Wi-Fi endpoint in the round, if any.
     */
    fun diagnose(
        attempts: List<ConnectAttempt>,
        platform: String,
        isPhysical: Boolean,
        lanEndpoint: String?,
    ): ConnectIssue {
        if (attempts.any { it.kind == AttemptKind.DENIED }) return ConnectIssue.permissionDenied
        val lan = lanEndpoint?.let { endpoint -> attempts.firstOrNull { it.endpoint == endpoint } }
        if (lan != null) {
            return when (lan.kind) {
                AttemptKind.REFUSED -> ConnectIssue.lanRefused
                AttemptKind.TIMEOUT -> ConnectIssue.lanTimeout
                AttemptKind.UNREACHABLE -> ConnectIssue.lanUnreachable
                AttemptKind.LOOKUP -> ConnectIssue.lanBadAddress
                AttemptKind.CLOSED, AttemptKind.NO_WELCOME -> ConnectIssue.notDurbun
                else -> ConnectIssue.other
            }
        }
        val loopback = attempts.firstOrNull { it.isLoopback }
        val android = platform == "android"
        if (android && isPhysical) {
            // adb reverse accepts on the phone and closes when nothing listens on the Mac.
            return if (loopback?.kind == AttemptKind.CLOSED) ConnectIssue.usbDesktopClosed else ConnectIssue.usbNotSetUp
        }
        if (platform == "ios" && isPhysical) return ConnectIssue.iosUsbWaiting
        if (loopback != null && (loopback.kind == AttemptKind.CLOSED || loopback.kind == AttemptKind.NO_WELCOME)) {
            // On the emulator adb reverse behaves like on a phone.
            return if (android) ConnectIssue.usbDesktopClosed else ConnectIssue.notDurbun
        }
        if (loopback == null || loopback.kind == AttemptKind.REFUSED) return ConnectIssue.desktopNotRunning
        return ConnectIssue.other
    }

    /** What to do next, in one or two English sentences (the same table as the other SDKs). */
    fun nextStep(issue: ConnectIssue?, port: Int, lanEndpoint: String?): String {
        val lan = lanEndpoint ?: "the Mac"
        return nextStepText(issue, port, lan)
    }

    private fun nextStepText(issue: ConnectIssue?, port: Int, lanEndpoint: String): String = when (issue) {
        ConnectIssue.desktopNotRunning ->
            "Nothing answers on this computer's port $port: open the Dürbün Mac app (or check its SDK port)."
        ConnectIssue.usbNotSetUp ->
            "No USB link to the Mac: connect the phone with USB debugging on and open the Dürbün Mac app " +
                "(it runs adb reverse tcp:$port by itself). For Wi-Fi, give the Mac's address with " +
                "Durbun.setDesktopHost(context, \"<Mac IP>\"), the launch extra durbun.host, the dev.durbun.host " +
                "manifest entry or DurbunOptions(host = \"<Mac IP>\")."
        ConnectIssue.usbDesktopClosed ->
            "adb reverse is set up, but nothing answers on the Mac: open the Dürbün Mac app."
        ConnectIssue.iosUsbWaiting ->
            "Waiting for the Mac over USB: open the Dürbün Mac app with this iPhone on the cable (and trusted). " +
                "For Wi-Fi, give the Mac's address with Durbun.setDesktopHost(\"<Mac IP>\"), the -DurbunHost " +
                "launch argument, the DurbunHost Info.plist key or DurbunOptions(host:)."
        ConnectIssue.lanRefused ->
            "The Mac at $lanEndpoint refuses the connection: open Dürbün there and turn on Settings → " +
                "\"Allow local network (Wi-Fi) connections\"."
        ConnectIssue.lanTimeout ->
            "No answer from $lanEndpoint: check the address (Dürbün → Settings lists this Mac's addresses), " +
                "that the phone and the Mac are on the same Wi-Fi, and the Mac's firewall."
        ConnectIssue.lanUnreachable ->
            "No route to $lanEndpoint: the phone is on another network than the Mac, or (iOS) Local Network " +
                "access is off for this app (Settings → Privacy & Security → Local Network; Info.plist needs " +
                "NSLocalNetworkUsageDescription)."
        ConnectIssue.lanBadAddress ->
            "The address $lanEndpoint cannot be resolved: use the Mac's IP address, e.g. 192.168.1.20."
        ConnectIssue.permissionDenied ->
            "The system did not allow the connection: on Android add <uses-permission " +
                "android:name=\"android.permission.INTERNET\"/> to the main AndroidManifest.xml and check firewall or " +
                "data saver apps; on iOS allow Local Network access."
        ConnectIssue.notDurbun ->
            "Something answered, but it is not a Dürbün desktop that accepted this app (another program on the " +
                "port, or a Dürbün version that does not match this SDK)."
        ConnectIssue.other, null -> "The connection failed."
    }

    /** One English paragraph for the developer console: what failed and what to do next. */
    fun consoleHint(issue: ConnectIssue?, attempts: List<ConnectAttempt>, port: Int, lanEndpoint: String?): String {
        val tried = attempts.joinToString { "${it.endpoint} ${it.kind}" }
        return "Dürbün: not connected to the desktop. ${nextStep(issue, port, lanEndpoint)} " +
            (if (tried.isEmpty()) "" else "Tried: $tried. ") +
            "The app keeps working and keeps retrying; Durbun.connectionStatus says the same."
    }
}

/**
 * Checks a desktop address typed by a person: `192.168.1.20`, `192.168.1.20:9751`, `my-mac.local`, `[fe80::1]:9751`;
 * a leading `http://` and a trailing `/` are dropped. Same rules as the Flutter SDK's in-app panel.
 */
internal object DesktopAddress {
    class Parsed(val host: String, val port: Int?) {
        /** `host` or `host:port` (IPv6 in brackets when a port follows). */
        override fun toString(): String = when {
            port == null -> host
            host.contains(':') -> "[$host]:$port"
            else -> "$host:$port"
        }
    }

    /** The cleaned address, or null when it is empty or not a host name / IP address with an optional port. */
    fun parse(input: String?): Parsed? {
        var v = input?.trim() ?: return null
        if (v.isEmpty()) return null
        v = v.replaceFirst(Regex("^[a-zA-Z]+://"), "")
        while (v.endsWith("/")) v = v.dropLast(1)
        if (v.isEmpty() || v.any { it.isWhitespace() || it in "/?#@" }) return null
        val host: String
        var port: String? = null
        if (v.startsWith("[")) {
            val end = v.indexOf(']')
            if (end < 2) return null
            host = v.substring(1, end)
            val rest = v.substring(end + 1)
            if (rest.isNotEmpty()) {
                if (!rest.startsWith(":")) return null
                port = rest.substring(1)
            }
            if (!IPV6.matches(host) || !host.contains(':')) return null
        } else if (v.count { it == ':' } > 1) {
            host = v // a bare IPv6 address: no port
            if (!IPV6.matches(host)) return null
        } else {
            val colon = v.indexOf(':')
            host = if (colon < 0) v else v.substring(0, colon)
            if (colon >= 0) port = v.substring(colon + 1)
            val labels = host.split('.')
            if (host.isEmpty() || host.length > 253 || labels.any { !LABEL.matches(it) }) return null
            // All digits and dots: an IPv4 address, four parts of 0-255.
            if (host.all { it.isDigit() || it == '.' } && (labels.size != 4 || labels.any { (it.toIntOrNull() ?: 256) > 255 })) {
                return null
            }
        }
        if (port != null) {
            val n = port.toIntOrNull() ?: return null
            if (n !in 1..65535) return null
            return Parsed(host, n)
        }
        return Parsed(host, null)
    }

    private val LABEL = Regex("^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?$")
    private val IPV6 = Regex("^[0-9a-zA-Z:.%]+$")
}
