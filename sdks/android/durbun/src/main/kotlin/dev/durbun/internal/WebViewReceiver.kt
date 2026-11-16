package dev.durbun.internal

import dev.durbun.Level
import java.net.URI

/**
 * Turns the messages of the web view bridge script ([WebViewBridgeScript], source: `sdks/js/webview/bridge.ts`)
 * into the SDK's own `net.*` and `log` messages. One receiver per web view.
 *
 * Everything here comes from page content, which is untrusted: every field is type-checked and capped, the message
 * rate and size are limited, and requests in flight are bounded. What reaches the desktop is whatever the page
 * claims. Called on the WebView's JavaScript bridge thread; never throws and never blocks.
 */
internal class WebViewReceiver(
    private val core: () -> DurbunCore?,
    private val nowMs: () -> Long = System::currentTimeMillis,
    private val monotonicMs: () -> Long = { System.nanoTime() / 1_000_000 },
) {
    private class Pending(
        val id: String,
        val ts: Long,
        val method: String,
        val url: String,
        val headers: List<Header>,
        val source: String,
    )

    private val lock = Any()
    private val pending = LinkedHashMap<String, Pending>()
    private var tokens = BURST.toDouble()
    private var refilledAt = monotonicMs()
    private var dropped = 0L
    private var dropReportedAt = Long.MIN_VALUE

    fun receive(json: String?) {
        try {
            handle(json)
        } catch (_: Throwable) {
            // Page content must never break the app.
        }
    }

    private fun handle(json: String?) {
        if (json == null) return
        val core = core() ?: return
        if (json.length > MAX_MESSAGE_CHARS || !takeToken()) {
            noteDropped(core, 1)
            return
        }
        val message = Json.parseObject(json) ?: return
        if ((message["v"] as? Number)?.toInt() != 1) return
        when (message["t"]) {
            "req" -> if (core.options.captureNetwork) request(core, message)
            "reqbody" -> if (core.options.captureNetwork) requestBody(core, message)
            "res" -> if (core.options.captureNetwork) response(core, message)
            "err" -> if (core.options.captureNetwork) error(core, message)
            "log" -> log(core, message)
            "dropped" -> (message["count"] as? Number)?.toLong()?.takeIf { it in 1..1_000_000_000L }?.let { noteDropped(core, it) }
        }
    }

    private fun request(core: DurbunCore, message: Map<String, Any?>) {
        val pageId = string(message["id"], MAX_ID_CHARS) ?: return
        val url = string(message["url"], MAX_URL_CHARS) ?: return
        if (!url.startsWith("http://", ignoreCase = true) && !url.startsWith("https://", ignoreCase = true)) return
        val host = try {
            URI(url).host
        } catch (_: Exception) {
            null
        } ?: return
        if (core.ignoresHost(host)) return
        val method = string(message["method"], 16)?.uppercase()?.takeIf { METHOD.matches(it) } ?: "GET"
        val source = when (message["api"]) {
            "fetch" -> SOURCE_FETCH
            "xhr" -> SOURCE_XHR
            else -> SOURCE_OTHER
        }
        val headers = headers(core, message["headers"])
        val ts = timestamp(message["ts"])
        val entry = Pending(core.nextWebViewRequestId(), ts, method, url, headers, source)
        synchronized(lock) {
            pending.remove(pageId)
            pending[pageId] = entry
            if (pending.size > MAX_PENDING) {
                val oldest = pending.keys.iterator()
                oldest.next()
                oldest.remove()
            }
        }
        core.send(Wire.netRequest(entry.id, ts.toDouble(), method, url, headers, body(core, message["body"]), source))
    }

    /** A `Request` object's body, read by the page after the request was reported: the same entry again. */
    private fun requestBody(core: DurbunCore, message: Map<String, Any?>) {
        val pageId = string(message["id"], MAX_ID_CHARS) ?: return
        val entry = synchronized(lock) { pending[pageId] } ?: return
        val body = body(core, message["body"]) ?: return
        core.send(Wire.netRequest(entry.id, entry.ts.toDouble(), entry.method, entry.url, entry.headers, body, entry.source))
    }

    private fun response(core: DurbunCore, message: Map<String, Any?>) {
        val entry = take(message) ?: return
        val status = (message["status"] as? Number)?.toInt()?.takeIf { it in 0..999 } ?: 0
        val timings = linkedMapOf<String, Any?>()
        duration(message["wait"])?.let { timings["wait"] = it }
        duration(message["receive"])?.let { timings["receive"] = it }
        core.send(
            Wire.netResponse(
                id = entry.id,
                ts = timestamp(message["ts"]).toDouble(),
                status = status,
                statusText = string(message["statusText"], 256),
                headers = headers(core, message["headers"]),
                body = body(core, message["body"]),
                protocol = null,
                remoteAddress = null,
                timings = timings,
                mocked = false,
                mockRuleId = null,
            ),
        )
    }

    private fun error(core: DurbunCore, message: Map<String, Any?>) {
        val entry = take(message) ?: return
        val text = string(message["error"], 1024)?.takeIf { it.isNotBlank() } ?: "Error"
        core.send(Wire.netError(entry.id, timestamp(message["ts"]).toDouble(), text, message["cancelled"] == true, mocked = false, mockRuleId = null))
    }

    private fun take(message: Map<String, Any?>): Pending? {
        val pageId = string(message["id"], MAX_ID_CHARS) ?: return null
        return synchronized(lock) { pending.remove(pageId) }
    }

    private fun log(core: DurbunCore, message: Map<String, Any?>) {
        val level = when (message["level"]) {
            "debug" -> Level.DEBUG
            "warn" -> Level.WARN
            "error" -> Level.ERROR
            else -> Level.INFO
        }
        val text = string(message["message"], MAX_LOG_CHARS) ?: return
        val data = string(message["page"], 2048)?.takeIf { it.isNotEmpty() }?.let { linkedMapOf<String, Any?>("page" to it) }
        val error = (message["error"] as? Map<*, *>)?.let { raw ->
            val info = linkedMapOf<String, Any?>()
            string(raw["type"], 256)?.let { info["type"] = it }
            string(raw["message"], 4096)?.let { info["message"] = it }
            string(raw["stack"], 32 * 1024)?.let { info["stack"] = it }
            info.takeIf { it.isNotEmpty() }
        }
        core.send(Wire.log(timestamp(message["ts"]), level.wireName, TAG, text, data = data, error = error, kind = "text"))
    }

    // ───────────── limits ─────────────

    private fun takeToken(): Boolean = synchronized(lock) {
        val now = monotonicMs()
        tokens = minOf(BURST.toDouble(), tokens + (now - refilledAt) * RATE_PER_SECOND / 1000.0)
        refilledAt = now
        if (tokens < 1.0) {
            false
        } else {
            tokens -= 1.0
            true
        }
    }

    /** Counts dropped messages; one warning line per [DROP_REPORT_INTERVAL_MS] says how many. */
    private fun noteDropped(core: DurbunCore, count: Long) {
        val report = synchronized(lock) {
            dropped += count
            val now = monotonicMs()
            if (dropReportedAt != Long.MIN_VALUE && now - dropReportedAt < DROP_REPORT_INTERVAL_MS) {
                null
            } else {
                dropReportedAt = now
                dropped.also { dropped = 0 }
            }
        } ?: return
        core.send(
            Wire.log(
                nowMs(),
                Level.WARN.wireName,
                TAG,
                "Dürbün dropped $report message(s) from a web view: the page sent too many, or too large ones.",
                kind = "text",
            ),
        )
    }

    // ───────────── field checks ─────────────

    private fun string(value: Any?, max: Int): String? {
        val text = value as? String ?: return null
        return if (text.length <= max) text else text.substring(0, safeEnd(text, max))
    }

    private fun safeEnd(text: String, max: Int): Int = if (max > 0 && Character.isHighSurrogate(text[max - 1])) max - 1 else max

    /** The page's wall clock time when it is close to the device's (same clock), otherwise now. */
    private fun timestamp(value: Any?): Long {
        val now = nowMs()
        val ts = (value as? Number)?.toLong() ?: return now
        return if (Math.abs(ts - now) <= MAX_CLOCK_SKEW_MS) ts else now
    }

    private fun duration(value: Any?): Double? {
        val ms = (value as? Number)?.toDouble() ?: return null
        if (ms.isNaN() || ms < 0 || ms > MAX_DURATION_MS) return null
        return Math.round(ms * 10.0) / 10.0
    }

    private fun headers(core: DurbunCore, value: Any?): List<Header> {
        val list = value as? List<*> ?: return emptyList()
        val redacted = core.redactedHeaders
        val out = ArrayList<Header>(minOf(list.size, MAX_HEADERS))
        for (item in list) {
            if (out.size >= MAX_HEADERS) break
            val pair = item as? List<*> ?: continue
            if (pair.size < 2) continue
            val name = string(pair[0], 256)?.takeIf { it.isNotBlank() } ?: continue
            val raw = string(pair[1], 8 * 1024) ?: continue
            out += name to if (name.lowercase() in redacted) REDACTED else raw
        }
        return out
    }

    /** The page's body, cut to the SDK's capture settings ([DurbunCore.captureBodies], [DurbunCore.maxBodyBytes]). */
    private fun body(core: DurbunCore, value: Any?): WireBody? {
        val map = value as? Map<*, *> ?: return null
        val encoding = map["encoding"] as? String
        if (encoding != "utf8" && encoding != "base64") return null
        val data = map["data"] as? String ?: ""
        val claimed = (map["size"] as? Number)?.toLong()?.takeIf { it in 0..MAX_CLAIMED_SIZE } ?: 0L
        if (!core.captureBodies) return WireBody.sizeOnly(claimed)
        val limit = core.maxBodyBytes
        var truncated = map["truncated"] == true
        val kept = if (encoding == "utf8") {
            if (data.length > limit) {
                truncated = true
                data.substring(0, safeEnd(data, limit))
            } else {
                data
            }
        } else {
            if (!BASE64.matches(data)) return WireBody.sizeOnly(claimed)
            val maxChars = limit / 3 * 4
            if (data.length > maxChars) {
                truncated = true
                data.substring(0, maxChars)
            } else {
                data
            }
        }
        val keptBytes = if (encoding == "utf8") kept.length.toLong() else kept.length / 4 * 3L
        if (kept.isEmpty() && claimed == 0L) return null
        return WireBody(encoding, kept, maxOf(claimed, keptBytes), truncated)
    }

    companion object {
        const val TAG = "webview"
        const val SOURCE_FETCH = "webview:fetch"
        const val SOURCE_XHR = "webview:xhr"
        const val SOURCE_OTHER = "webview"

        /** Longest message taken from a page (a body at the script's 64 KB cap, base64-encoded, fits easily). */
        const val MAX_MESSAGE_CHARS = 512 * 1024
        const val MAX_PENDING = 256
        const val MAX_HEADERS = 100
        const val MAX_URL_CHARS = 8 * 1024
        const val MAX_LOG_CHARS = 64 * 1024
        const val MAX_ID_CHARS = 64
        const val BURST = 400
        const val RATE_PER_SECOND = 150.0
        const val DROP_REPORT_INTERVAL_MS = 10_000L
        private const val MAX_CLOCK_SKEW_MS = 5 * 60_000L
        private const val MAX_DURATION_MS = 24 * 3_600_000.0
        private const val MAX_CLAIMED_SIZE = 1L shl 40
        private const val REDACTED = "••••"
        private val METHOD = Regex("[A-Z][A-Z0-9_-]{0,15}")
        private val BASE64 = Regex("[A-Za-z0-9+/]*={0,2}")
    }
}
