package dev.durbun.internal

import java.io.PrintWriter
import java.io.StringWriter

/**
 * Builders for the SDK → desktop messages (`SdkToServer` in the protocol). Each returns one encoded JSON
 * object without the trailing newline. Optional fields are omitted when unknown.
 */
internal object Wire {
    const val PROTOCOL_VERSION = 1
    const val SDK_NAME = "durbun-android"

    /** Longest log message kept (longer ones are cut with a note). */
    const val MAX_MESSAGE_CHARS = 512 * 1024

    /** Longest encoded `data` / `props` payload kept. */
    const val MAX_DATA_CHARS = 1024 * 1024

    private const val MAX_STACK_CHARS = 256 * 1024

    fun hello(
        sdkVersion: String,
        app: Map<String, Any?>,
        device: Map<String, Any?>,
        session: String,
        capabilities: List<String>,
        actions: List<Map<String, Any?>>,
        ts: Long,
    ): String = Json.encode(
        linkedMapOf(
            "type" to "hello",
            "protocol" to PROTOCOL_VERSION,
            "sdk" to linkedMapOf("name" to SDK_NAME, "version" to sdkVersion, "platform" to "android"),
            "app" to app.filterValues { it != null },
            "device" to device.filterValues { it != null },
            "session" to session,
            "capabilities" to capabilities,
            "actions" to actions,
            "ts" to ts,
        ),
    )

    fun log(
        ts: Number,
        level: String,
        tag: String?,
        message: String,
        data: Any? = null,
        error: Map<String, Any?>? = null,
        kind: String? = null,
        tid: Int? = null,
    ): String {
        val map = linkedMapOf<String, Any?>("type" to "log", "ts" to ts, "level" to level)
        if (!tag.isNullOrEmpty()) map["tag"] = tag
        map["message"] = capMessage(message)
        if (data != null) map["data"] = payload(data)
        if (error != null) map["error"] = error
        if (kind != null) map["kind"] = kind
        if (tid != null) map["tid"] = tid
        return Json.encode(map)
    }

    fun event(ts: Long, name: String, props: Map<String, Any?>?): String {
        val map = linkedMapOf<String, Any?>("type" to "event", "ts" to ts, "name" to name)
        if (props != null) map["props"] = payload(props)
        return Json.encode(map)
    }

    fun netRequest(
        id: String,
        ts: Double,
        method: String,
        url: String,
        headers: List<Header>,
        body: WireBody?,
        source: String,
    ): String {
        val map = linkedMapOf<String, Any?>(
            "type" to "net.request",
            "id" to id,
            "ts" to ts,
            "method" to method,
            "url" to url,
            "headers" to headerList(headers),
        )
        if (body != null) map["body"] = body.toJson()
        map["source"] = source
        return Json.encode(map)
    }

    fun netResponse(
        id: String,
        ts: Double,
        status: Int,
        statusText: String?,
        headers: List<Header>,
        body: WireBody?,
        protocol: String?,
        remoteAddress: String?,
        timings: Map<String, Any?>?,
        mocked: Boolean,
        mockRuleId: String?,
    ): String {
        val map = linkedMapOf<String, Any?>("type" to "net.response", "id" to id, "ts" to ts, "status" to status)
        if (!statusText.isNullOrEmpty()) map["statusText"] = statusText
        map["headers"] = headerList(headers)
        if (body != null) map["body"] = body.toJson()
        if (!protocol.isNullOrEmpty()) map["protocol"] = protocol
        if (!remoteAddress.isNullOrEmpty()) map["remoteAddress"] = remoteAddress
        if (!timings.isNullOrEmpty()) map["timings"] = timings
        if (mocked) {
            map["mocked"] = true
            if (mockRuleId != null) map["mockRuleId"] = mockRuleId
        }
        return Json.encode(map)
    }

    fun netError(id: String, ts: Double, error: String, cancelled: Boolean, mocked: Boolean, mockRuleId: String?): String {
        val map = linkedMapOf<String, Any?>("type" to "net.error", "id" to id, "ts" to ts, "error" to error)
        if (cancelled) map["cancelled"] = true
        if (mocked) {
            map["mocked"] = true
            if (mockRuleId != null) map["mockRuleId"] = mockRuleId
        }
        return Json.encode(map)
    }

    fun metric(ts: Long, values: Map<String, Any?>): String {
        val map = linkedMapOf<String, Any?>("type" to "metric", "ts" to ts)
        for ((k, v) in values) if (v != null) map[k] = v
        return Json.encode(map)
    }

    fun commandResult(id: String, ok: Boolean, data: Any?, error: String?): String {
        val map = linkedMapOf<String, Any?>("type" to "command.result", "id" to id, "ok" to ok)
        if (data != null) map["data"] = payload(data)
        if (error != null) map["error"] = error
        return Json.encode(map)
    }

    fun actions(actions: List<Map<String, Any?>>): String =
        Json.encode(linkedMapOf("type" to "actions", "actions" to actions))

    fun pong(ts: Long): String = Json.encode(linkedMapOf("type" to "pong", "ts" to ts))

    /** `ErrorInfo` for a throwable: class name, message and the full stack (with causes). */
    fun errorInfo(t: Throwable, fullStack: String = fullStackTrace(t)): Map<String, Any?> {
        val map = linkedMapOf<String, Any?>("type" to t.javaClass.name)
        t.message?.let { map["message"] = it }
        map["stack"] = capStack(fullStack)
        return map
    }

    fun stackTraceOf(t: Throwable): String = capStack(fullStackTrace(t))

    /** `printStackTrace` output (what Log / Timber append to messages), without trailing whitespace. */
    fun fullStackTrace(t: Throwable): String = try {
        val sw = StringWriter()
        PrintWriter(sw).use { t.printStackTrace(it) }
        sw.toString().trimEnd()
    } catch (_: Throwable) {
        t.toString()
    }

    private fun capStack(text: String): String =
        if (text.length > MAX_STACK_CHARS) text.substring(0, MAX_STACK_CHARS) + "\n\t… (stack truncated)" else text

    /**
     * Loggers such as Timber append the throwable's stack trace to the message AND pass the throwable.
     * Drop that exact copy so the desktop shows the message once and the stack once (folded).
     */
    fun withoutAppendedStack(message: String, t: Throwable, fullStack: String): String {
        val trimmed = message.trimEnd()
        if (fullStack.isEmpty() || !trimmed.endsWith(fullStack)) return message
        val rest = trimmed.substring(0, trimmed.length - fullStack.length).trimEnd()
        return rest.ifEmpty { t.toString() }
    }

    private fun headerList(headers: List<Header>): List<List<String>> = headers.map { listOf(it.first, it.second) }

    private fun capMessage(message: String): String =
        if (message.length <= MAX_MESSAGE_CHARS) {
            message
        } else {
            message.substring(0, MAX_MESSAGE_CHARS) + "… [truncated by Dürbün: ${message.length} characters]"
        }

    /** Pre-encodes app data so oversized payloads are replaced by a readable note instead of a huge frame. */
    private fun payload(data: Any): Any {
        val encoded = try {
            Json.encode(data)
        } catch (t: Throwable) {
            return "<data could not be encoded: ${t.javaClass.simpleName}>"
        }
        return if (encoded.length <= MAX_DATA_CHARS) {
            RawJson(encoded)
        } else {
            "<data omitted by Dürbün: ${encoded.length / 1024} KB of JSON>"
        }
    }
}
