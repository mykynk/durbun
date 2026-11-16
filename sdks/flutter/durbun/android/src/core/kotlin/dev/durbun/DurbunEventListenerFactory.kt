package dev.durbun

import dev.durbun.internal.CallPhases
import okhttp3.Call
import okhttp3.EventListener

/**
 * Adds DNS, connect, TLS, send and wait times to the calls [DurbunInterceptor] reports (OkHttp tells them only to
 * an `EventListener`). Install it next to the interceptor:
 *
 * ```kotlin
 * val client = OkHttpClient.Builder()
 *     .addInterceptor(DurbunInterceptor())
 *     .eventListenerFactory(DurbunEventListenerFactory())
 *     .build()
 * ```
 *
 * OkHttp takes one listener factory per client: pass the app's own as [delegate] and it keeps getting every
 * callback, in the same order, on the same threads. Until [Durbun.start] has run (and always in release builds)
 * only the delegate is called.
 */
class DurbunEventListenerFactory @JvmOverloads constructor(
    private val delegate: EventListener.Factory? = null,
) : EventListener.Factory {
    /** For an app that sets one listener with `eventListener(listener)`: it keeps getting every callback. */
    constructor(delegate: EventListener) : this(
        object : EventListener.Factory {
            override fun create(call: Call): EventListener = delegate
        },
    )

    override fun create(call: Call): EventListener {
        val inner = delegate?.create(call)
        return CallPhases.listener(inner)
    }
}
