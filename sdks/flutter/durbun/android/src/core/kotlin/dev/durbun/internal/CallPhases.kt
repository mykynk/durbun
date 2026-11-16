package dev.durbun.internal

import dev.durbun.Durbun
import okhttp3.Call
import okhttp3.Connection
import okhttp3.EventListener
import okhttp3.Handshake
import okhttp3.HttpUrl
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import java.io.IOException
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.Proxy
import java.util.Collections
import java.util.WeakHashMap

/**
 * Connection phases of OkHttp calls, recorded by `DurbunEventListenerFactory` and read by [OkHttpCapture] when it
 * reports a response. Calls are held weakly: a call that is never closed does not keep anything alive.
 */
internal object CallPhases {
    private val listeners: MutableMap<Call, PhaseListener> = Collections.synchronizedMap(WeakHashMap())

    /** The listener for a new call: records phases while Dürbün captures, and always forwards to [delegate]. */
    fun listener(delegate: EventListener?): EventListener {
        val core = Durbun.coreOrNull()
        if (core == null || !core.options.captureNetwork) return delegate ?: EventListener.NONE
        return PhaseListener(delegate)
    }

    /** `dns`, `connect`, `tls`, `send` and `wait` (ms) of the call's latest attempt, or null when unknown. */
    fun timings(call: Call): Map<String, Double>? = try {
        listeners[call]?.timings()
    } catch (_: Throwable) {
        null
    }

    internal fun register(call: Call, listener: PhaseListener) {
        try {
            listeners[call] = listener
        } catch (_: Throwable) {
        }
    }

    internal fun forget(call: Call) {
        try {
            listeners.remove(call)
        } catch (_: Throwable) {
        }
    }

    /** Test hook: calls still tracked. */
    internal fun trackedCount(): Int = listeners.size

    /**
     * Timestamps (System.nanoTime, 0 = not seen) of one attempt: a redirect, retry or follow-up starts a new one
     * once the previous attempt had sent its request.
     */
    internal class Attempt {
        var dnsStart = 0L
        var dnsEnd = 0L
        var connectStart = 0L
        var secureStart = 0L
        var secureEnd = 0L
        var connectEnd = 0L
        var requestStart = 0L
        var requestEnd = 0L
        var responseHeaders = 0L

        fun timings(): Map<String, Double>? {
            val map = LinkedHashMap<String, Double>()
            span(dnsStart, dnsEnd)?.let { map["dns"] = it }
            if (secureStart != 0L) {
                span(connectStart, secureStart)?.let { map["connect"] = it }
                span(secureStart, secureEnd)?.let { map["tls"] = it }
            } else {
                span(connectStart, connectEnd)?.let { map["connect"] = it }
            }
            span(requestStart, requestEnd)?.let { map["send"] = it }
            span(requestEnd, responseHeaders)?.let { map["wait"] = it }
            return map.ifEmpty { null }
        }

        private fun span(start: Long, end: Long): Double? {
            if (start == 0L || end == 0L || end < start) return null
            return Math.round((end - start) / 100_000.0) / 10.0
        }
    }

    /**
     * Records the phases and forwards every callback to the app's own listener, first thing, so the app sees what
     * it would see without Dürbün. Recording never throws.
     */
    internal class PhaseListener(private val delegate: EventListener?) : EventListener() {
        private var attempt = Attempt()

        @Synchronized
        fun timings(): Map<String, Double>? = attempt.timings()

        @Synchronized
        private fun record(block: (Attempt) -> Unit) {
            try {
                block(attempt)
            } catch (_: Throwable) {
            }
        }

        /** A connection or request step after the previous attempt sent its request belongs to a new attempt. */
        private fun next(a: Attempt): Attempt {
            if (a.requestStart == 0L) return a
            return Attempt().also { attempt = it }
        }

        private fun now() = System.nanoTime()

        override fun callStart(call: Call) {
            delegate?.callStart(call)
            register(call, this)
            record { attempt = Attempt() }
        }

        override fun proxySelectStart(call: Call, url: HttpUrl) {
            delegate?.proxySelectStart(call, url)
        }

        override fun proxySelectEnd(call: Call, url: HttpUrl, proxies: List<Proxy>) {
            delegate?.proxySelectEnd(call, url, proxies)
        }

        override fun dnsStart(call: Call, domainName: String) {
            delegate?.dnsStart(call, domainName)
            record { next(it).dnsStart = now() }
        }

        override fun dnsEnd(call: Call, domainName: String, inetAddressList: List<InetAddress>) {
            delegate?.dnsEnd(call, domainName, inetAddressList)
            record { it.dnsEnd = now() }
        }

        override fun connectStart(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy) {
            delegate?.connectStart(call, inetSocketAddress, proxy)
            record {
                val a = next(it)
                a.connectStart = now()
                a.secureStart = 0L
                a.secureEnd = 0L
                a.connectEnd = 0L
            }
        }

        override fun secureConnectStart(call: Call) {
            delegate?.secureConnectStart(call)
            record { it.secureStart = now() }
        }

        override fun secureConnectEnd(call: Call, handshake: Handshake?) {
            delegate?.secureConnectEnd(call, handshake)
            record { it.secureEnd = now() }
        }

        override fun connectEnd(call: Call, inetSocketAddress: InetSocketAddress, proxy: Proxy, protocol: Protocol?) {
            delegate?.connectEnd(call, inetSocketAddress, proxy, protocol)
            record { it.connectEnd = now() }
        }

        override fun connectFailed(
            call: Call,
            inetSocketAddress: InetSocketAddress,
            proxy: Proxy,
            protocol: Protocol?,
            ioe: IOException,
        ) {
            delegate?.connectFailed(call, inetSocketAddress, proxy, protocol, ioe)
        }

        override fun connectionAcquired(call: Call, connection: Connection) {
            delegate?.connectionAcquired(call, connection)
            record { next(it) }
        }

        override fun connectionReleased(call: Call, connection: Connection) {
            delegate?.connectionReleased(call, connection)
        }

        override fun requestHeadersStart(call: Call) {
            delegate?.requestHeadersStart(call)
            record {
                val a = next(it)
                a.requestStart = now()
                a.requestEnd = 0L
                a.responseHeaders = 0L
            }
        }

        override fun requestHeadersEnd(call: Call, request: Request) {
            delegate?.requestHeadersEnd(call, request)
            record { it.requestEnd = now() }
        }

        override fun requestBodyStart(call: Call) {
            delegate?.requestBodyStart(call)
        }

        override fun requestBodyEnd(call: Call, byteCount: Long) {
            delegate?.requestBodyEnd(call, byteCount)
            record { it.requestEnd = now() }
        }

        override fun requestFailed(call: Call, ioe: IOException) {
            delegate?.requestFailed(call, ioe)
        }

        override fun responseHeadersStart(call: Call) {
            delegate?.responseHeadersStart(call)
        }

        override fun responseHeadersEnd(call: Call, response: Response) {
            delegate?.responseHeadersEnd(call, response)
            record { it.responseHeaders = now() }
        }

        override fun responseBodyStart(call: Call) {
            delegate?.responseBodyStart(call)
        }

        override fun responseBodyEnd(call: Call, byteCount: Long) {
            delegate?.responseBodyEnd(call, byteCount)
        }

        override fun responseFailed(call: Call, ioe: IOException) {
            delegate?.responseFailed(call, ioe)
        }

        override fun callEnd(call: Call) {
            delegate?.callEnd(call)
            forget(call)
        }

        override fun callFailed(call: Call, ioe: IOException) {
            delegate?.callFailed(call, ioe)
            forget(call)
        }

        override fun canceled(call: Call) {
            delegate?.canceled(call)
        }

        override fun satisfactionFailure(call: Call, response: Response) {
            delegate?.satisfactionFailure(call, response)
        }

        override fun cacheHit(call: Call, response: Response) {
            delegate?.cacheHit(call, response)
        }

        override fun cacheMiss(call: Call) {
            delegate?.cacheMiss(call)
        }

        override fun cacheConditionalHit(call: Call, cachedResponse: Response) {
            delegate?.cacheConditionalHit(call, cachedResponse)
        }
    }
}
