package dev.durbun

import dev.durbun.internal.OkHttpCapture
import okhttp3.Interceptor
import okhttp3.Response

/**
 * OkHttp interceptor that shows every request and response in Dürbün — headers, bodies (gzip-aware; copied
 * while OkHttp writes the request and while the app reads the response, so nothing is written twice or read
 * ahead), status, timings, errors — and applies the desktop's mock rules (fake responses, added latency,
 * simulated timeouts / DNS / TLS / connection failures).
 *
 * ```kotlin
 * val client = OkHttpClient.Builder()
 *     .addInterceptor(DurbunInterceptor())          // application interceptor: sees the final response
 *     .build()
 * ```
 *
 * Server-Sent Events (`text/event-stream`) show up as one entry with their events, and a WebSocket's handshake as
 * one entry; for the WebSocket's messages, open it with [DurbunWebSocketFactory].
 *
 * Until [Durbun.start] has run (and always in release builds, or with [DurbunOptions.captureNetwork] off —
 * in Flutter apps `DurbunOptions(captureNetwork: false)` on the Dart side) it is a plain pass-through.
 *
 * @param redactHeaders header names (case-insensitive) whose values are shown as `••••`,
 *   for example `setOf("Authorization", "Cookie")`.
 */
class DurbunInterceptor @JvmOverloads constructor(
    redactHeaders: Set<String> = emptySet(),
) : Interceptor {
    private val capture = OkHttpCapture(redactHeaders.map { it.lowercase() }.toSet())

    override fun intercept(chain: Interceptor.Chain): Response {
        val core = Durbun.coreOrNull()
        if (core == null || !core.options.captureNetwork) return chain.proceed(chain.request())
        val ignored = try {
            val request = chain.request()
            val url = request.url
            val upgrade = "websocket".equals(request.header("Upgrade"), ignoreCase = true)
            core.ignoresHost(url.host) || core.isDesktopEndpoint(url.host, url.port, url.encodedPath, upgrade)
        } catch (_: Throwable) {
            false
        }
        if (ignored) return chain.proceed(chain.request())
        return capture.intercept(core, chain)
    }
}
