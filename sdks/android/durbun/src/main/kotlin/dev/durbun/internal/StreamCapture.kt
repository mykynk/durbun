package dev.durbun.internal

import okhttp3.Call
import okhttp3.Headers
import okhttp3.MediaType
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.Buffer
import okio.BufferedSource
import okio.ByteString
import okio.Source
import okio.Timeout
import okio.buffer
import java.io.IOException
import java.io.OutputStream
import java.util.ArrayDeque
import java.util.concurrent.atomic.AtomicBoolean

/*
 * Long-lived connections (SPEC §6.1.1): one network entry (the handshake's `net.request` / `net.response`) plus
 * its messages with the same id. Messages go out only while the desktop's config says `captureStreams: true`
 * (read per message); the handshake is an ordinary request and is always reported.
 */

/**
 * Put on the WebSocket request by [dev.durbun.DurbunWebSocketFactory]; [dev.durbun.DurbunInterceptor] writes the
 * id of the handshake it reported into it, so the messages use the same id.
 */
internal class StreamTag {
    @Volatile
    var id: String? = null
}

internal object StreamRequests {
    fun isWebSocketUpgrade(request: Request): Boolean =
        request.header("Upgrade")?.equals("websocket", ignoreCase = true) == true

    /** OkHttp keeps `ws://` and `wss://` URLs as `http://` and `https://`; the desktop shows them as written. */
    fun webSocketUrl(url: String): String = when {
        url.startsWith("http://", ignoreCase = true) -> "ws://" + url.substring(7)
        url.startsWith("https://", ignoreCase = true) -> "wss://" + url.substring(8)
        else -> url
    }

    fun describe(error: Throwable): String {
        val message = error.message
        return if (message.isNullOrBlank()) error.javaClass.simpleName else "${error.javaClass.simpleName}: $message"
    }

    fun isCanceled(call: Call?): Boolean = try {
        call?.isCanceled() == true
    } catch (_: LinkageError) {
        false
    } catch (_: RuntimeException) {
        false
    }
}

/* ───────────── Server-Sent Events ───────────── */

/**
 * A `text/event-stream` response seen by `DurbunInterceptor`: its headers are reported at once (no body), and its
 * events are parsed from a copy of what the app reads. Nothing is read ahead, buffered or reordered; the app's
 * reads return the same bytes at the same moment as without Dürbün.
 */
internal object SseCapture {
    /** 2xx `text/event-stream` with no content coding the SDK would have to undo (the app asked for gzip itself). */
    fun applies(response: Response, contentType: String?): Boolean {
        if (response.code !in 200..299) return false
        val ct = contentType?.trim()?.lowercase() ?: return false
        if (!ct.startsWith("text/event-stream")) return false
        val encoding = response.header("Content-Encoding", null)
        return encoding.isNullOrBlank() || encoding.trim().equals("identity", ignoreCase = true)
    }

    /**
     * The same response with a body that parses what the app reads; null when this OkHttp cannot rebuild it.
     * [started]: the headers went out while the desktop wanted messages (it opened the stream then).
     */
    fun wrap(core: DurbunCore, call: Call?, id: String, response: Response, started: Boolean): Response? {
        val body = response.body ?: return null
        val wrapped = EventStreamBody(body, EventStreamSource(core, call, id, started))
        return try {
            response.newBuilder().body(wrapped).build()
        } catch (_: Throwable) {
            null
        }
    }

    private class EventStreamBody(private val delegate: ResponseBody, private val tee: EventStreamSource) : ResponseBody() {
        private var source: BufferedSource? = null

        override fun contentType(): MediaType? = delegate.contentType()

        override fun contentLength(): Long = delegate.contentLength()

        @Synchronized
        override fun source(): BufferedSource = source ?: tee.attach(delegate.source()).buffer().also { source = it }
    }

    private class EventStreamSource(
        private val core: DurbunCore,
        private val call: Call?,
        private val id: String,
        /**
         * The desktop has a stream for this entry (headers or an event went out while it asked for messages): its
         * end or failure is reported even after the desktop stops asking.
         */
        @Volatile private var started: Boolean,
    ) : Source {
        private lateinit var upstream: Source
        private val done = AtomicBoolean(false)
        private val parser = SseParser(::onEvent)

        /** Set per read: whether the desktop wants events now, and how much of one to keep. */
        private var active = false
        private var cap = 0

        /** A parser failure stops the parsing, never the app's read. */
        private var broken = false

        /** Okio copies the bytes the app just read into this, segment by segment, without consuming them. */
        private val feeder = object : OutputStream() {
            override fun write(b: Int) {
                write(byteArrayOf(b.toByte()), 0, 1)
            }

            override fun write(b: ByteArray, off: Int, len: Int) {
                parser.feed(b, off, len, active, cap)
            }
        }

        fun attach(source: Source): EventStreamSource {
            upstream = source
            return this
        }

        override fun read(sink: Buffer, byteCount: Long): Long {
            val read = try {
                upstream.read(sink, byteCount)
            } catch (e: IOException) {
                finish(error = e, closed = false)
                throw e
            }
            if (read == -1L) {
                finish(error = null, closed = false)
                return read
            }
            if (read > 0 && !broken && !done.get()) {
                try {
                    active = core.captureStreams
                    cap = if (active) core.maxStreamMessageBytes else 0
                    sink.copyTo(feeder, sink.size - read, read)
                } catch (t: Throwable) {
                    broken = true
                    core.logger.warn("Dürbün stopped reading the events of a stream", t)
                }
            }
            return read
        }

        override fun timeout(): Timeout = upstream.timeout()

        override fun close() {
            try {
                upstream.close()
            } finally {
                finish(error = null, closed = true)
            }
        }

        private fun onEvent(event: SseParser.Event) {
            if (done.get() || !core.captureStreams) return
            val cap = core.maxStreamMessageBytes
            val body = if (cap > 0 && event.size > 0) {
                val keep = BodyCodec.utf8SafeLength(event.data, minOf(event.stored, cap))
                WireBody("utf8", String(event.data, 0, keep, Charsets.UTF_8), event.size, keep < event.size)
            } else {
                null
            }
            core.sendStream(Wire.netSse(id, System.currentTimeMillis(), event.event, event.eventId, event.retry, event.size, body))
            started = true
        }

        /** Once: the end of the stream, a read error, or the app closing it before the end (a cancel). */
        private fun finish(error: IOException?, closed: Boolean) {
            if (!done.compareAndSet(false, true)) return
            try {
                if (!closed && error == null) parser.endOfStream()
                if (!started && !core.captureStreams) return
                val now = System.currentTimeMillis()
                when {
                    closed -> core.send(Wire.netError(id, now.toDouble(), "Canceled", true, false, null))
                    error != null -> core.send(
                        Wire.netError(id, now.toDouble(), StreamRequests.describe(error), StreamRequests.isCanceled(call), false, null),
                    )
                    else -> core.send(Wire.netSseEnd(id, now))
                }
            } catch (t: Throwable) {
                core.logger.warn("Dürbün could not report the end of a stream", t)
            }
        }
    }
}

/* ───────────── WebSockets ───────────── */

/**
 * One WebSocket opened through `DurbunWebSocketFactory`: the app gets [socket] (wraps OkHttp's socket, sees what
 * the app sends) and OkHttp calls [listener] (wraps the app's listener, sees what arrives). Messages are reported
 * in the order the app saw them, with the handshake's id: the one `DurbunInterceptor` reported (through
 * [StreamTag]), or, on a client without it, a handshake this class reports itself: when the socket opens while
 * the desktop asks for messages, or else with the first message reported (never, if none is).
 *
 * Reporting never runs the app's code under Dürbün's lock, never blocks OkHttp's threads beyond queueing a line,
 * and never throws into the app: capture failures are swallowed.
 */
internal class WebSocketCapture private constructor(
    private val core: DurbunCore,
    private val appRequest: Request,
    private val appListener: WebSocketListener,
    private val tag: StreamTag,
) {
    private val startWall = System.currentTimeMillis()
    private val url = StreamRequests.webSocketUrl(appRequest.url.toString())
    private val lock = Any()
    private val warned = AtomicBoolean(false)

    @Volatile
    private var real: WebSocket? = null

    @Volatile
    private var cancelRequested = false

    /**
     * The desktop has a stream for this connection (the handshake or a message went out while it asked for
     * messages): its close frames and failure are reported even after the desktop stops asking.
     */
    @Volatile
    private var started = false

    /* under [lock] */
    private var state = CONNECTING
    private var id: String? = null
    private val pending = ArrayDeque<WsMessage>()

    /**
     * Without `DurbunInterceptor`, a handshake that opened while the desktop did not ask for messages: nobody saw
     * it, so it is sent only if a message is reported later (the connection shows up from that moment).
     */
    private var deferredHandshake: List<String>? = null

    /** What the app holds. */
    val socket: WebSocket = CapturedSocket()

    /** What OkHttp calls. */
    val listener: WebSocketListener = CapturedListener()

    private class WsMessage(
        val ts: Long,
        val dir: String,
        val opcode: String,
        val size: Long,
        val body: WireBody?,
        val closeCode: Int? = null,
        val closeReason: String? = null,
    ) {
        fun line(id: String): String = Wire.netWs(id, ts, dir, opcode, size, body, closeCode, closeReason)
    }

    private fun attach(webSocket: WebSocket) {
        if (real == null) real = webSocket
    }

    private fun realSocket(): WebSocket = real ?: throw IllegalStateException("WebSocket is not created yet")

    /* ───────────── messages ───────────── */

    /** Whether to report now; [ending] (close frames) also goes out for a stream the desktop already has. */
    private fun reporting(ending: Boolean): Boolean = core.captureStreams || (ending && started)

    /**
     * An app write: [action] runs under the lock so a reply that arrives at once is reported after it.
     * [ending]: a close frame.
     */
    private fun sendOut(action: () -> Boolean, ending: Boolean, message: () -> WsMessage): Boolean {
        if (!reporting(ending)) return action()
        synchronized(lock) {
            val ok = action()
            if (ok) recordLocked(ending, message)
            return ok
        }
    }

    private fun incoming(ending: Boolean, message: () -> WsMessage) {
        if (!reporting(ending)) return
        synchronized(lock) { recordLocked(ending, message) }
    }

    private fun recordLocked(ending: Boolean, message: () -> WsMessage) {
        try {
            if (!reporting(ending)) return
            when (state) {
                // Sent before the socket opened (OkHttp queues it): reported right after the handshake.
                CONNECTING -> if (core.captureStreams) {
                    pending.addLast(message())
                    while (pending.size > MAX_PENDING) pending.removeFirst()
                }
                OPEN -> {
                    val handshakeId = id ?: return
                    sendDeferredHandshakeLocked()
                    core.sendStream(message().line(handshakeId))
                    started = true
                }
                else -> Unit
            }
        } catch (t: Throwable) {
            warn(t)
        }
    }

    private fun sendDeferredHandshakeLocked() {
        val lines = deferredHandshake ?: return
        deferredHandshake = null
        lines.forEach(core::send)
    }

    private fun textMessage(dir: String, text: String): WsMessage {
        val size = Utf8.size(text)
        val cap = core.maxStreamMessageBytes
        val body = when {
            cap <= 0 || size == 0L -> null
            size <= cap -> WireBody("utf8", text, size, truncated = false)
            else -> WireBody("utf8", text.substring(0, Utf8.prefixLength(text, cap)), size, truncated = true)
        }
        return WsMessage(System.currentTimeMillis(), dir, "text", size, body)
    }

    private fun binaryMessage(dir: String, bytes: ByteString): WsMessage {
        val size = bytes.size.toLong()
        val cap = core.maxStreamMessageBytes
        val body = when {
            cap <= 0 || size == 0L -> null
            size <= cap -> WireBody("base64", bytes.base64(), size, truncated = false)
            else -> WireBody("base64", bytes.substring(0, cap).base64(), size, truncated = true)
        }
        return WsMessage(System.currentTimeMillis(), dir, "binary", size, body)
    }

    /** OkHttp reports a close frame without a status as 1005 (it is never sent on the wire). */
    private fun closeMessage(dir: String, code: Int, reason: String?): WsMessage {
        val hasCode = code != NO_STATUS_CODE
        val size = if (hasCode) 2 + Utf8.size(reason.orEmpty()) else 0L
        return WsMessage(
            System.currentTimeMillis(),
            dir,
            "close",
            size,
            null,
            closeCode = if (hasCode) code else null,
            closeReason = if (hasCode) reason?.takeIf { it.isNotEmpty() } else null,
        )
    }

    /* ───────────── handshake and end ───────────── */

    private fun opened(response: Response) {
        try {
            synchronized(lock) {
                if (state != CONNECTING) return
                state = OPEN
                val streams = core.captureStreams
                val claimed = tag.id
                val handshakeId = if (claimed != null) {
                    claimed
                } else {
                    // No DurbunInterceptor on this client: the handshake is reported here (no mocks apply to it).
                    val ownId = core.nextRequestId()
                    val lines = listOf(requestLine(ownId, response), responseLine(ownId, response))
                    if (streams) lines.forEach(core::send) else deferredHandshake = lines
                    ownId
                }
                id = handshakeId
                if (streams) {
                    started = true
                    for (message in pending) core.sendStream(message.line(handshakeId))
                }
                pending.clear()
            }
        } catch (t: Throwable) {
            warn(t)
        }
    }

    private fun failed(error: Throwable, response: Response?) {
        try {
            synchronized(lock) {
                val cancelled = cancelRequested || error.message == "Canceled"
                when (state) {
                    CONNECTING -> if (core.captureStreams) handshakeFailed(error, response, cancelled)
                    OPEN -> if (reporting(ending = true)) {
                        val handshakeId = id
                        if (handshakeId != null) {
                            sendDeferredHandshakeLocked()
                            val now = System.currentTimeMillis().toDouble()
                            core.send(Wire.netError(handshakeId, now, StreamRequests.describe(error), cancelled, false, null))
                        }
                    }
                    else -> Unit
                }
                state = ENDED
                pending.clear()
                deferredHandshake = null
            }
        } catch (t: Throwable) {
            warn(t)
        }
    }

    private fun closed() {
        synchronized(lock) {
            state = ENDED
            pending.clear()
            deferredHandshake = null
        }
    }

    /**
     * The upgrade did not happen (only reported while the desktop asks for messages: before that, a WebSocket
     * entry looked exactly as it always did). `DurbunInterceptor` already reported what it saw (a response, a
     * mock, an error); only a 101 whose upgrade OkHttp then rejected needs the error. Without the interceptor, all
     * of it is reported here: a refused upgrade is an ordinary response, a connection that never answered an error.
     */
    private fun handshakeFailed(error: Throwable, response: Response?, cancelled: Boolean) {
        val now = System.currentTimeMillis().toDouble()
        val claimed = tag.id
        if (claimed != null) {
            if (response?.code == SWITCHING_PROTOCOLS) {
                core.send(Wire.netError(claimed, now, StreamRequests.describe(error), cancelled, false, null))
            }
            return
        }
        val handshakeId = core.nextRequestId()
        core.send(requestLine(handshakeId, response))
        if (response != null) core.send(responseLine(handshakeId, response))
        if (response == null || response.code == SWITCHING_PROTOCOLS) {
            core.send(Wire.netError(handshakeId, now, StreamRequests.describe(error), cancelled, false, null))
        }
    }

    private fun requestLine(handshakeId: String, response: Response?): String {
        // The response carries the request with the upgrade headers OkHttp added.
        val request = response?.request ?: appRequest
        return Wire.netRequest(handshakeId, startWall.toDouble(), request.method, url, headerList(request.headers), null, OkHttpCapture.SOURCE)
    }

    private fun responseLine(handshakeId: String, response: Response): String {
        val code = response.code
        val timings = LinkedHashMap<String, Any?>()
        val sent = response.sentRequestAtMillis
        val received = response.receivedResponseAtMillis
        if (sent >= startWall && received >= sent) {
            if (sent - startWall >= 1) timings["connect"] = sent - startWall
            timings["wait"] = received - sent
        }
        return Wire.netResponse(
            id = handshakeId,
            ts = System.currentTimeMillis().toDouble(),
            status = code,
            statusText = response.message.ifEmpty { OkHttpCapture.reasonPhrase(code) },
            headers = headerList(response.headers),
            body = null,
            protocol = response.protocol.toString(),
            remoteAddress = null,
            timings = timings.ifEmpty { null },
            mocked = false,
            mockRuleId = null,
        )
    }

    private fun headerList(headers: Headers): List<Header> {
        val redacted = core.redactedHeaders
        val list = ArrayList<Header>(headers.size)
        for (i in 0 until headers.size) {
            val name = headers.name(i)
            list += name to if (name.lowercase() in redacted) REDACTED else headers.value(i)
        }
        return list
    }

    private fun warn(t: Throwable) {
        if (warned.compareAndSet(false, true)) core.logger.warn("Dürbün could not capture a WebSocket", t)
    }

    /* ───────────── the two faces ───────────── */

    private inner class CapturedSocket : WebSocket {
        override fun request(): Request = appRequest

        override fun queueSize(): Long = realSocket().queueSize()

        override fun send(text: String): Boolean = sendOut({ realSocket().send(text) }, ending = false) { textMessage("out", text) }

        override fun send(bytes: ByteString): Boolean = sendOut({ realSocket().send(bytes) }, ending = false) { binaryMessage("out", bytes) }

        override fun close(code: Int, reason: String?): Boolean =
            sendOut({ realSocket().close(code, reason) }, ending = true) { closeMessage("out", code, reason) }

        override fun cancel() {
            cancelRequested = true
            realSocket().cancel()
        }

        override fun toString(): String = realSocket().toString()
    }

    private inner class CapturedListener : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            attach(webSocket)
            opened(response)
            appListener.onOpen(socket, response)
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            attach(webSocket)
            incoming(ending = false) { textMessage("in", text) }
            appListener.onMessage(socket, text)
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            attach(webSocket)
            incoming(ending = false) { binaryMessage("in", bytes) }
            appListener.onMessage(socket, bytes)
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            attach(webSocket)
            incoming(ending = true) { closeMessage("in", code, reason) }
            appListener.onClosing(socket, code, reason)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            attach(webSocket)
            closed()
            appListener.onClosed(socket, code, reason)
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            attach(webSocket)
            failed(t, response)
            appListener.onFailure(socket, t, response)
        }
    }

    companion object {
        private const val CONNECTING = 0
        private const val OPEN = 1
        private const val ENDED = 2
        private const val SWITCHING_PROTOCOLS = 101
        private const val NO_STATUS_CODE = 1005

        /** Messages the app sends before the socket opens, kept until the handshake is reported. */
        private const val MAX_PENDING = 256
        private const val REDACTED = "••••"

        /**
         * Opens a WebSocket through [factory] with capture, or exactly as the app asked when it should not be
         * captured (ignored host, the desktop itself) or the capture cannot be set up.
         */
        fun open(core: DurbunCore, factory: WebSocket.Factory, request: Request, listener: WebSocketListener): WebSocket {
            val capture = try {
                val url = request.url
                if (core.ignoresHost(url.host) || core.isDesktopEndpoint(url.host, url.port, url.encodedPath)) {
                    null
                } else {
                    WebSocketCapture(core, request, listener, StreamTag())
                }
            } catch (t: Throwable) {
                core.logger.warn("Dürbün could not capture a WebSocket", t)
                null
            }
            if (capture == null) return factory.newWebSocket(request, listener)
            val tagged = try {
                request.newBuilder().tag(StreamTag::class.java, capture.tag).build()
            } catch (_: Throwable) {
                request // the handshake is then reported by the capture itself
            }
            val webSocket = factory.newWebSocket(tagged, capture.listener)
            capture.attach(webSocket)
            return capture.socket
        }
    }
}
