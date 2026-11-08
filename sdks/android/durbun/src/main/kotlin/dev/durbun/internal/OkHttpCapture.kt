package dev.durbun.internal

import okhttp3.FormBody
import okhttp3.Headers
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okhttp3.ResponseBody
import okio.Buffer
import okio.BufferedSink
import okio.BufferedSource
import okio.Sink
import okio.Source
import okio.Timeout
import okio.buffer
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InterruptedIOException
import java.net.ConnectException
import java.net.InetSocketAddress
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.atomic.AtomicBoolean
import javax.net.ssl.SSLHandshakeException

/**
 * The work behind `DurbunInterceptor`: reports each call as `net.request` → `net.response` / `net.error`
 * and applies mock rules. Bodies are copied while OkHttp writes the request and while the app reads the
 * response: the app's bodies are never written twice and nothing is read ahead of the app. A request whose
 * body is captured this way is reported again (same id) once the body was written. Capture failures never
 * affect the call.
 *
 * Only OkHttp/Okio APIs that exist in OkHttp 3.12 … 5.x are used (see [OkHttpCompat]).
 */
internal class OkHttpCapture(private val redactedHeaders: Set<String>) {
    private val warned = AtomicBoolean(false)
    private val networkMockWarned = AtomicBoolean(false)

    fun intercept(core: DurbunCore, chain: Interceptor.Chain): Response {
        val request = chain.request()
        val id = core.nextRequestId()
        val startWall = System.currentTimeMillis()
        val startNs = System.nanoTime()
        val method = request.method
        val url = request.url.toString()

        val found = guard(core) { core.findMock(method, url) }
        // A network interceptor must call proceed() exactly once, so it cannot answer from a mock.
        val mock = if (found != null && found.action is MockAction.Respond && isNetworkInterceptor(chain)) {
            if (networkMockWarned.compareAndSet(false, true)) {
                core.logger.warn(
                    "Mock '${found.id}' was not applied: respond mocks need DurbunInterceptor as an application " +
                        "interceptor (OkHttpClient.Builder().addInterceptor(...)).",
                )
            }
            null
        } else {
            found
        }
        // The rule reported with the call (`mocked: true`).
        var applied = mock
        val headers = guard(core) { requestHeaders(core, request) } ?: emptyList()
        val sendRequest = { body: WireBody? ->
            guard(core) {
                core.send(Wire.netRequest(id, startWall.toDouble(), method, url, headers, body, SOURCE))
            }
            Unit
        }
        val plan = guard(core) { planRequestBody(core, request, sendRequest) }
        sendRequest(plan?.initial)

        if (mock != null) {
            when (val action = mock.action) {
                is MockAction.Respond -> {
                    waitForMock(core, chain, id, mock, action.delayMs, startWall, startNs)
                    val mocked = guard(core) { mockResponse(request, action, startWall) }
                    if (mocked != null) {
                        // The network never sees this body, so this is its only write.
                        plan?.tee?.let { tee -> guard(core) { tee.captureWithoutNetwork() } }
                        guard(core) { reportMockResponse(core, id, mock, action, mocked.second, startWall, startNs) }
                        return mocked.first
                    }
                    applied = null // could not synthesize a response with this OkHttp: perform the real call
                }
                is MockAction.Delay -> waitForMock(core, chain, id, mock, action.delayMs, startWall, startNs)
                is MockAction.Fail -> failWithMock(core, chain, request, id, mock, action, startWall, startNs)
            }
        }

        val outgoing = plan?.tee?.let { tee -> guard(core) { request.newBuilder().method(method, tee).build() } } ?: request
        val response = try {
            chain.proceed(outgoing)
        } catch (e: IOException) {
            reportError(core, chain, id, e, startWall, startNs, applied)
            throw e
        } catch (e: RuntimeException) {
            reportError(core, chain, id, e, startWall, startNs, applied)
            throw e
        }
        val reported = applied
        return guard(core) { reportResponse(core, chain, request, response, id, startWall, startNs, reported) } ?: response
    }

    /* ───────────── mocks ───────────── */

    /** Synthesizes the response of a `respond` mock (the network is never touched) and its decoded body. */
    private fun mockResponse(request: Request, action: MockAction.Respond, startWall: Long): Pair<Response, ByteArray> {
        val headers = Headers.Builder()
        for ((name, value) in action.headers) {
            try {
                headers.add(name, value)
            } catch (_: IllegalArgumentException) {
                // invalid header name/value for OkHttp: leave it out of the synthesized response
            }
        }
        val bytes = mockBodyBytes(action)
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(action.status)
            .message(reasonPhrase(action.status))
            .headers(headers.build())
            .body(OkHttpCompat.responseBody(OkHttpCompat.mediaType(mockContentType(action)), bytes))
            .sentRequestAtMillis(startWall)
            .receivedResponseAtMillis(System.currentTimeMillis())
            .build()
        return response to bytes
    }

    private fun reportMockResponse(
        core: DurbunCore,
        id: String,
        rule: MockRule,
        action: MockAction.Respond,
        bytes: ByteArray,
        startWall: Long,
        startNs: Long,
    ) {
        val body = if (bytes.isEmpty()) {
            null
        } else if (!core.captureBodies) {
            WireBody.sizeOnly(bytes.size.toLong())
        } else {
            BodyCapture.encode(bytes, bytes.size, true, bytes.size.toLong(), mockContentType(action), null, core.maxBodyBytes)
        }
        core.send(
            Wire.netResponse(
                id = id,
                ts = endTs(startWall, startNs),
                status = action.status,
                statusText = reasonPhrase(action.status),
                headers = action.headers.map { it.first to redact(core, it.first, it.second) },
                body = body,
                protocol = null,
                remoteAddress = null,
                timings = null,
                mocked = true,
                mockRuleId = rule.id,
            ),
        )
    }

    private fun mockContentType(action: MockAction.Respond): String? =
        action.headers.lastOrNull { it.first.equals("Content-Type", ignoreCase = true) }?.second

    private fun mockBodyBytes(action: MockAction.Respond): ByteArray = when (action.bodyEncoding) {
        "base64" -> Base64Codec.decode(action.body.orEmpty()) ?: ByteArray(0)
        else -> action.body.orEmpty().toByteArray(Charsets.UTF_8)
    }

    private fun failWithMock(
        core: DurbunCore,
        chain: Interceptor.Chain,
        request: Request,
        id: String,
        rule: MockRule,
        action: MockAction.Fail,
        startWall: Long,
        startNs: Long,
    ): Nothing {
        waitForMock(core, chain, id, rule, action.delayMs, startWall, startNs)
        val error = simulatedFailure(action, request.url.host, request.url.port)
        guard(core) {
            core.send(Wire.netError(id, endTs(startWall, startNs), describe(error), false, true, rule.id))
        }
        throw error
    }

    /** Sleeps for a mock's delay, honouring call cancellation. */
    private fun waitForMock(
        core: DurbunCore,
        chain: Interceptor.Chain,
        id: String,
        rule: MockRule,
        delayMs: Long,
        startWall: Long,
        startNs: Long,
    ) {
        if (delayMs <= 0) return
        val deadline = System.nanoTime() + delayMs * 1_000_000L
        while (true) {
            if (isCanceled(chain)) {
                val error = IOException("Canceled")
                guard(core) { core.send(Wire.netError(id, endTs(startWall, startNs), describe(error), true, true, rule.id)) }
                throw error
            }
            val remainingMs = (deadline - System.nanoTime()) / 1_000_000L
            if (remainingMs <= 0) return
            try {
                Thread.sleep(minOf(remainingMs, 50L))
            } catch (_: InterruptedException) {
                Thread.currentThread().interrupt()
                val error = InterruptedIOException("interrupted")
                guard(core) { core.send(Wire.netError(id, endTs(startWall, startNs), describe(error), true, true, rule.id)) }
                throw error
            }
        }
    }

    /* ───────────── reporting ───────────── */

    private fun reportError(
        core: DurbunCore,
        chain: Interceptor.Chain,
        id: String,
        error: Exception,
        startWall: Long,
        startNs: Long,
        mock: MockRule?,
    ) {
        guard(core) {
            val cancelled = isCanceled(chain) || error.message == "Canceled"
            core.send(Wire.netError(id, endTs(startWall, startNs), describe(error), cancelled, mock != null, mock?.id))
        }
    }

    /**
     * Reports the response. When its body is captured, the app gets the response at once with a body that copies
     * what the app reads (up to the capture limit); `net.response` follows at end of body, at the capture limit,
     * or when the app closes the body, whichever comes first. Nothing waits for bytes the app has not asked for.
     */
    private fun reportResponse(
        core: DurbunCore,
        chain: Interceptor.Chain,
        request: Request,
        response: Response,
        id: String,
        startWall: Long,
        startNs: Long,
        mock: MockRule?,
    ): Response {
        val code = response.code
        val statusText = response.message.ifEmpty { reasonPhrase(code) }
        val headers = headerList(core, response.headers)
        val protocol = response.protocol.toString()
        val remote = remoteAddress(chain)
        val send = { body: WireBody?, receiveMs: Double? ->
            core.send(
                Wire.netResponse(
                    id = id,
                    ts = endTs(startWall, startNs),
                    status = code,
                    statusText = statusText,
                    headers = headers,
                    body = body,
                    protocol = protocol,
                    remoteAddress = remote,
                    timings = timings(response, startWall, receiveMs),
                    mocked = mock != null,
                    mockRuleId = mock?.id,
                ),
            )
        }
        val body = response.body
        if (body == null || !promisesBody(request, response)) {
            send(null, null)
            return response
        }
        val length = body.contentLength()
        val contentType = body.contentType()?.toString() ?: response.header("Content-Type", null)
        if (!core.captureBodies || length == 0L || isStream(request, response, contentType)) {
            send(WireBody.sizeOnly(length), null)
            return response
        }
        val limit = core.maxBodyBytes
        val contentEncoding = response.header("Content-Encoding", null)
        val readStart = System.nanoTime()
        val tee = TeeResponseBody(body, limit, length) { capture, eof ->
            guard(core) {
                val wire = if (capture.stored == 0 && !eof) {
                    WireBody.sizeOnly(length)
                } else {
                    BodyCapture.encode(
                        raw = capture.bytes(),
                        rawLength = capture.stored,
                        rawComplete = eof && capture.total <= limit,
                        transferSize = if (length >= 0) length else capture.total,
                        contentType = contentType,
                        contentEncoding = contentEncoding,
                        limit = limit,
                    )
                }
                send(wire, (System.nanoTime() - readStart) / 1_000_000.0)
            }
        }
        return try {
            response.newBuilder().body(tee).build()
        } catch (t: Throwable) {
            // Could not hand out the copying body with this OkHttp: report what is known and return the original.
            tee.abandon()
            send(WireBody.sizeOnly(length), null)
            response
        }
    }

    private fun requestHeaders(core: DurbunCore, request: Request): List<Header> {
        val list = headerList(core, request.headers).toMutableList()
        val body = request.body ?: return list
        // OkHttp adds these from the body after application interceptors run; show them like the wire does.
        if (request.header("Content-Type") == null) {
            body.contentType()?.let { list += "Content-Type" to it.toString() }
        }
        if (request.header("Content-Length") == null && request.header("Transfer-Encoding") == null) {
            val length = contentLength(body)
            if (length >= 0) list += "Content-Length" to length.toString()
        }
        return list
    }

    private fun headerList(core: DurbunCore, headers: Headers): List<Header> {
        val list = ArrayList<Header>(headers.size)
        for (i in 0 until headers.size) {
            val name = headers.name(i)
            list += name to redact(core, name, headers.value(i))
        }
        return list
    }

    /** Redacts the interceptor's own header names and the core-wide ones (Flutter's `redactHeaders`). */
    private fun redact(core: DurbunCore, name: String, value: String): String {
        val extra = core.redactedHeaders
        if (redactedHeaders.isEmpty() && extra.isEmpty()) return value
        val lower = name.lowercase()
        return if (lower in redactedHeaders || lower in extra) REDACTED else value
    }

    /* ───────────── bodies ───────────── */

    /** How a request body is captured: [initial] goes with the first `net.request`; [tee] reports later. */
    private class RequestBodyPlan(val initial: WireBody?, val tee: TeeRequestBody?)

    /**
     * The app's request body is never written twice. A [FormBody] is plain in-memory data and is captured right
     * away (and stays a `FormBody` for later interceptors); any other body is wrapped so that OkHttp's own write
     * is copied into a side buffer, and the request is reported again with the captured body once written.
     */
    private fun planRequestBody(core: DurbunCore, request: Request, sendRequest: (WireBody?) -> Unit): RequestBodyPlan? {
        val body = request.body ?: return null
        val declared = contentLength(body)
        if (!core.captureBodies || isDuplex(body) || hasUnrepeatableMarker(body)) {
            return RequestBodyPlan(WireBody.sizeOnly(declared), null)
        }
        val contentType = body.contentType()?.toString() ?: request.header("Content-Type")
        val contentEncoding = request.header("Content-Encoding")
        val limit = core.maxBodyBytes
        if (body is FormBody) {
            return RequestBodyPlan(captureInMemory(body, declared, contentType, contentEncoding, limit), null)
        }
        val tee = TeeRequestBody(body, limit, declared) { capture ->
            guard(core) {
                sendRequest(
                    BodyCapture.encode(
                        raw = capture.bytes(),
                        rawLength = capture.stored,
                        rawComplete = capture.total <= limit,
                        transferSize = capture.total,
                        contentType = contentType,
                        contentEncoding = contentEncoding,
                        limit = limit,
                    ),
                )
            }
        }
        return RequestBodyPlan(WireBody.sizeOnly(declared), tee)
    }

    /** Writes an in-memory body (no side effects, known length) into a side buffer, stopping after [limit]. */
    private fun captureInMemory(body: RequestBody, declared: Long, contentType: String?, contentEncoding: String?, limit: Int): WireBody? {
        val sink = CappedSink(limit, declared)
        try {
            val buffered = sink.buffer()
            body.writeTo(buffered)
            buffered.flush()
        } catch (_: CapReached) {
            // enough captured
        } catch (_: IOException) {
            return WireBody.sizeOnly(declared)
        }
        val capture = sink.capture
        return BodyCapture.encode(
            raw = capture.bytes(),
            rawLength = capture.stored,
            rawComplete = capture.total <= limit && (declared < 0 || capture.total >= declared),
            transferSize = if (declared >= 0) declared else capture.total,
            contentType = contentType,
            contentEncoding = contentEncoding,
            limit = limit,
        )
    }

    /** OkHttp < 3.14 marks bodies it must not retry with this interface; a wrapper would hide it. */
    private fun hasUnrepeatableMarker(body: RequestBody): Boolean {
        var type: Class<*>? = body.javaClass
        while (type != null && type != Any::class.java) {
            if (type.interfaces.any { it.name == "okhttp3.internal.http.UnrepeatableRequestBody" }) return true
            type = type.superclass
        }
        return false
    }

    /** Responses that never end or are taken over by the app (SSE, WebSocket, media) are reported at once, size only. */
    private fun isStream(request: Request, response: Response, contentType: String?): Boolean {
        if (response.code == 101 || request.header("Upgrade") != null) return true
        if (request.body?.let(::isDuplex) == true) return true
        val ct = contentType?.lowercase() ?: return false
        return STREAMING_TYPES.any { ct.startsWith(it) }
    }

    private fun promisesBody(request: Request, response: Response): Boolean {
        if (request.method.equals("HEAD", ignoreCase = true)) return false
        val code = response.code
        return !(code in 100..199 || code == 204 || code == 304)
    }

    private fun contentLength(body: RequestBody): Long = try {
        body.contentLength()
    } catch (_: IOException) {
        -1L
    }

    private fun isDuplex(body: RequestBody): Boolean = try {
        body.isDuplex()
    } catch (_: LinkageError) {
        false
    }

    /* ───────────── helpers ───────────── */

    /** Application interceptors see no connection; network interceptors do. */
    private fun isNetworkInterceptor(chain: Interceptor.Chain): Boolean = try {
        chain.connection() != null
    } catch (_: Throwable) {
        false
    }

    private fun isCanceled(chain: Interceptor.Chain): Boolean = try {
        chain.call().isCanceled()
    } catch (_: LinkageError) {
        false
    } catch (_: RuntimeException) {
        false
    }

    private fun remoteAddress(chain: Interceptor.Chain): String? = try {
        val address: InetSocketAddress? = chain.connection()?.route()?.socketAddress
        address?.let {
            val ip = it.address?.hostAddress ?: it.hostString
            if (ip.contains(':')) "[$ip]:${it.port}" else "$ip:${it.port}"
        }
    } catch (_: Throwable) {
        null
    }

    /**
     * Without an EventListener only coarse phases are known: `connect` = time before the request was sent
     * (DNS + TCP + TLS on a new connection), `wait` = request sent → response headers, `receive` = time to
     * read the captured body.
     */
    private fun timings(response: Response, startWall: Long, receiveMs: Double?): Map<String, Any?>? {
        val map = LinkedHashMap<String, Any?>()
        val sent = response.sentRequestAtMillis
        val received = response.receivedResponseAtMillis
        val fromCache = response.networkResponse == null && response.cacheResponse != null
        if (!fromCache && sent >= startWall && received >= sent) {
            if (response.priorResponse == null && sent - startWall >= 1) map["connect"] = sent - startWall
            map["wait"] = received - sent
        }
        if (receiveMs != null) map["receive"] = Math.round(receiveMs * 10.0) / 10.0
        return map.ifEmpty { null }
    }

    private fun endTs(startWall: Long, startNs: Long): Double {
        val elapsedMs = (System.nanoTime() - startNs) / 1_000_000.0
        return Math.round((startWall + elapsedMs) * 1000.0) / 1000.0
    }

    private fun describe(error: Throwable): String {
        val message = error.message
        return if (message.isNullOrBlank()) error.javaClass.simpleName else "${error.javaClass.simpleName}: $message"
    }

    private inline fun <T> guard(core: DurbunCore, block: () -> T): T? = try {
        block()
    } catch (t: Throwable) {
        if (warned.compareAndSet(false, true)) core.logger.warn("Dürbün could not capture an HTTP call", t)
        null
    }

    /** Keeps the first [limit] bytes of a body and counts all of them. */
    private class Capture(private val limit: Int, sizeHint: Long) {
        private val out = ByteArrayOutputStream(
            (if (sizeHint in 1..Int.MAX_VALUE) minOf(sizeHint.toInt(), limit) else minOf(limit, 8 * 1024))
                .coerceIn(16, 64 * 1024),
        )
        var total = 0L
            private set
        val stored: Int get() = out.size()

        fun bytes(): ByteArray = out.toByteArray()

        /** Copies (without consuming) [byteCount] bytes of [buffer] starting at [offset]. */
        fun copy(buffer: Buffer, offset: Long, byteCount: Long) {
            val room = (limit - out.size()).toLong()
            if (room > 0 && byteCount > 0) buffer.copyTo(out, offset, minOf(room, byteCount))
            total += byteCount
        }
    }

    /** A side buffer for bodies written only for the capture: stops the write after the limit. */
    private class CappedSink(private val limit: Int, sizeHint: Long) : Sink {
        val capture = Capture(limit, sizeHint)

        override fun write(source: Buffer, byteCount: Long) {
            capture.copy(source, 0, byteCount)
            source.skip(byteCount)
            if (capture.total > limit) throw CapReached()
        }

        override fun flush() = Unit

        override fun timeout(): Timeout = Timeout.NONE

        override fun close() = Unit
    }

    /** Stops writing a body into the side buffer once enough was captured. */
    private class CapReached : RuntimeException() {
        override fun fillInStackTrace(): Throwable = this
    }

    /** Passes everything to OkHttp's sink and copies a prefix on the way. Copy problems never fail the write. */
    private class TeeSink(private val downstream: Sink, val capture: Capture) : Sink {
        var closed = false
            private set
        var copyFailed = false
            private set

        override fun write(source: Buffer, byteCount: Long) {
            if (!copyFailed) {
                try {
                    capture.copy(source, 0, byteCount)
                } catch (_: Throwable) {
                    copyFailed = true
                }
            }
            downstream.write(source, byteCount)
        }

        override fun flush() = downstream.flush()

        override fun timeout(): Timeout = downstream.timeout()

        override fun close() {
            closed = true
            downstream.close()
        }
    }

    /**
     * The app's request body, unchanged for OkHttp (type, length, one-shot / duplex flags), whose first complete
     * write is copied: OkHttp writes it once, as without Dürbün; [onCaptured] runs after that write.
     */
    private class TeeRequestBody(
        private val delegate: RequestBody,
        private val limit: Int,
        private val sizeHint: Long,
        private val onCaptured: (Capture) -> Unit,
    ) : RequestBody() {
        private val captured = AtomicBoolean(false)

        override fun contentType(): MediaType? = delegate.contentType()

        override fun contentLength(): Long = delegate.contentLength()

        override fun isOneShot(): Boolean = try {
            delegate.isOneShot()
        } catch (_: LinkageError) {
            false // OkHttp < 3.14
        }

        override fun isDuplex(): Boolean = try {
            delegate.isDuplex()
        } catch (_: LinkageError) {
            false
        }

        override fun writeTo(sink: BufferedSink) {
            if (captured.get()) {
                delegate.writeTo(sink) // a retry or redirect: already captured
                return
            }
            val tee = TeeSink(sink, Capture(limit, sizeHint))
            val buffered = tee.buffer()
            delegate.writeTo(buffered)
            if (!tee.closed) buffered.emit()
            if (!tee.copyFailed && captured.compareAndSet(false, true)) onCaptured(tee.capture)
        }

        /** A `respond` mock answers without the network: this is the body's only write, into a side buffer. */
        fun captureWithoutNetwork() {
            if (!captured.compareAndSet(false, true)) return
            val sink = CappedSink(limit, sizeHint)
            try {
                val buffered = sink.buffer()
                delegate.writeTo(buffered)
                buffered.flush()
            } catch (_: CapReached) {
                // enough captured
            } catch (_: IOException) {
                return
            }
            onCaptured(sink.capture)
        }
    }

    /**
     * The app's response body; bytes are copied as the app reads them (OkHttp's source is never read ahead).
     * [onDone] runs once: at end of body (`eof`), past the capture limit, on a read error or when the body is closed.
     */
    private class TeeResponseBody(
        private val delegate: ResponseBody,
        private val limit: Int,
        private val length: Long,
        onDone: (Capture, eof: Boolean) -> Unit,
    ) : ResponseBody() {
        private val tee = TeeSource(limit, length, onDone)
        private var source: BufferedSource? = null

        override fun contentType(): MediaType? = delegate.contentType()

        override fun contentLength(): Long = delegate.contentLength()

        @Synchronized
        override fun source(): BufferedSource = source ?: tee.attach(delegate.source()).buffer().also { source = it }

        /** The wrapper was not handed out: report nothing more. */
        fun abandon() = tee.abandon()
    }

    private class TeeSource(limit: Int, sizeHint: Long, private val onDone: (Capture, eof: Boolean) -> Unit) : Source {
        private val capture = Capture(limit, sizeHint)
        private val limit = limit.toLong()
        private val done = AtomicBoolean(false)
        private lateinit var upstream: Source

        fun attach(source: Source): TeeSource {
            upstream = source
            return this
        }

        fun abandon() {
            done.set(true)
        }

        override fun read(sink: Buffer, byteCount: Long): Long {
            val read = try {
                upstream.read(sink, byteCount)
            } catch (e: IOException) {
                finish(eof = false)
                throw e
            }
            if (read == -1L) {
                finish(eof = true)
                return read
            }
            if (!done.get()) {
                try {
                    capture.copy(sink, sink.size - read, read)
                } catch (_: Throwable) {
                    // keep what was copied
                }
                if (capture.total > limit) finish(eof = false)
            }
            return read
        }

        override fun timeout(): Timeout = upstream.timeout()

        override fun close() {
            try {
                upstream.close()
            } finally {
                finish(eof = false)
            }
        }

        private fun finish(eof: Boolean) {
            if (!done.compareAndSet(false, true)) return
            try {
                onDone(capture, eof)
            } catch (_: Throwable) {
                // never fail the app's read
            }
        }
    }

    companion object {
        const val SOURCE = "okhttp"
        /** Same marker as the Dart (dart:io) and Swift (URLSession) layers. */
        private const val REDACTED = "••••"

        private val STREAMING_TYPES = listOf(
            "text/event-stream",
            "application/x-ndjson",
            "application/stream+json",
            "application/grpc",
            "multipart/x-mixed-replace",
            "video/",
            "audio/",
        )

        /** The platform's natural error for a `fail` mock. */
        fun simulatedFailure(action: MockAction.Fail, host: String, port: Int): IOException {
            val message = action.message
            return when (action.error) {
                "timeout" -> SocketTimeoutException(message ?: "timeout")
                "connection" -> ConnectException(message ?: "Failed to connect to $host:$port")
                "dns" -> UnknownHostException(message ?: "Unable to resolve host \"$host\": No address associated with hostname")
                "tls" -> SSLHandshakeException(
                    message ?: "java.security.cert.CertPathValidatorException: Trust anchor for certification path not found.",
                )
                else -> IOException(message ?: "Request failed (simulated by Dürbün)")
            }
        }

        fun reasonPhrase(code: Int): String = when (code) {
            100 -> "Continue"
            101 -> "Switching Protocols"
            200 -> "OK"
            201 -> "Created"
            202 -> "Accepted"
            204 -> "No Content"
            206 -> "Partial Content"
            301 -> "Moved Permanently"
            302 -> "Found"
            303 -> "See Other"
            304 -> "Not Modified"
            307 -> "Temporary Redirect"
            308 -> "Permanent Redirect"
            400 -> "Bad Request"
            401 -> "Unauthorized"
            403 -> "Forbidden"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            408 -> "Request Timeout"
            409 -> "Conflict"
            410 -> "Gone"
            413 -> "Payload Too Large"
            415 -> "Unsupported Media Type"
            422 -> "Unprocessable Entity"
            429 -> "Too Many Requests"
            500 -> "Internal Server Error"
            501 -> "Not Implemented"
            502 -> "Bad Gateway"
            503 -> "Service Unavailable"
            504 -> "Gateway Timeout"
            else -> when (code / 100) {
                1 -> "Informational"
                2 -> "Success"
                3 -> "Redirection"
                4 -> "Client Error"
                5 -> "Server Error"
                else -> ""
            }
        }
    }
}
