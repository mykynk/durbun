package dev.durbun.internal

import okhttp3.Headers
import okhttp3.Interceptor
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.Response
import okio.Buffer
import okio.Sink
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
 * and applies mock rules. Bodies are captured without consuming the app's streams (request bodies are
 * written into a side buffer, response bodies are peeked). Capture failures never affect the call.
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
        guard(core) {
            core.send(
                Wire.netRequest(
                    id = id,
                    ts = startWall.toDouble(),
                    method = method,
                    url = url,
                    headers = requestHeaders(core, request),
                    body = captureRequestBody(core, request),
                    source = SOURCE,
                ),
            )
        }

        if (mock != null) {
            when (val action = mock.action) {
                is MockAction.Respond -> {
                    waitForMock(core, chain, id, mock, action.delayMs, startWall, startNs)
                    val mocked = guard(core) { mockResponse(core, request, id, mock, action, startWall, startNs) }
                    if (mocked != null) return mocked
                    applied = null // could not synthesize a response with this OkHttp: perform the real call
                }
                is MockAction.Delay -> waitForMock(core, chain, id, mock, action.delayMs, startWall, startNs)
                is MockAction.Fail -> failWithMock(core, chain, request, id, mock, action, startWall, startNs)
            }
        }

        val response = try {
            chain.proceed(request)
        } catch (e: IOException) {
            reportError(core, chain, id, e, startWall, startNs, applied)
            throw e
        } catch (e: RuntimeException) {
            reportError(core, chain, id, e, startWall, startNs, applied)
            throw e
        }
        val reported = applied
        guard(core) { reportResponse(core, chain, request, response, id, startWall, startNs, reported) }
        return response
    }

    /* ───────────── mocks ───────────── */

    /** Synthesizes the response of a `respond` mock and reports it (the network is never touched). */
    private fun mockResponse(
        core: DurbunCore,
        request: Request,
        id: String,
        rule: MockRule,
        action: MockAction.Respond,
        startWall: Long,
        startNs: Long,
    ): Response {
        val headers = Headers.Builder()
        for ((name, value) in action.headers) {
            try {
                headers.add(name, value)
            } catch (_: IllegalArgumentException) {
                // invalid header name/value for OkHttp: leave it out of the synthesized response
            }
        }
        val contentType = action.headers.lastOrNull { it.first.equals("Content-Type", ignoreCase = true) }?.second
        val bytes = when (action.bodyEncoding) {
            "base64" -> Base64Codec.decode(action.body.orEmpty()) ?: ByteArray(0)
            else -> action.body.orEmpty().toByteArray(Charsets.UTF_8)
        }
        val statusText = reasonPhrase(action.status)
        val response = Response.Builder()
            .request(request)
            .protocol(Protocol.HTTP_1_1)
            .code(action.status)
            .message(statusText)
            .headers(headers.build())
            .body(OkHttpCompat.responseBody(OkHttpCompat.mediaType(contentType), bytes))
            .sentRequestAtMillis(startWall)
            .receivedResponseAtMillis(System.currentTimeMillis())
            .build()
        guard(core) {
            val body = if (bytes.isEmpty()) {
                null
            } else if (!core.captureBodies) {
                WireBody.sizeOnly(bytes.size.toLong())
            } else {
                BodyCapture.encode(bytes, bytes.size, true, bytes.size.toLong(), contentType, null, core.maxBodyBytes)
            }
            core.send(
                Wire.netResponse(
                    id = id,
                    ts = endTs(startWall, startNs),
                    status = action.status,
                    statusText = statusText,
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
        return response
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

    private fun reportResponse(
        core: DurbunCore,
        chain: Interceptor.Chain,
        request: Request,
        response: Response,
        id: String,
        startWall: Long,
        startNs: Long,
        mock: MockRule?,
    ) {
        val peekStart = System.nanoTime()
        val body = captureResponseBody(core, request, response)
        val receiveMs = (System.nanoTime() - peekStart) / 1_000_000.0
        val code = response.code
        core.send(
            Wire.netResponse(
                id = id,
                ts = endTs(startWall, startNs),
                status = code,
                statusText = response.message.ifEmpty { reasonPhrase(code) },
                headers = headerList(core, response.headers),
                body = body,
                protocol = response.protocol.toString(),
                remoteAddress = remoteAddress(chain),
                timings = timings(response, startWall, if (body != null) receiveMs else null),
                mocked = mock != null,
                mockRuleId = mock?.id,
            ),
        )
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

    private fun captureRequestBody(core: DurbunCore, request: Request): WireBody? {
        val body = request.body ?: return null
        val declared = contentLength(body)
        if (!core.captureBodies || isOneShotOrDuplex(body)) return WireBody.sizeOnly(declared)
        // A custom body of unknown length is usually a stream (file / content URI upload); writing it twice
        // could consume it, so only OkHttp's own (repeatable) bodies are captured in that case.
        if (declared < 0 && !body.javaClass.name.startsWith("okhttp3.")) return null
        val contentType = body.contentType()?.toString() ?: request.header("Content-Type")
        val limit = core.maxBodyBytes
        val sink = CappedSink(limit, stopAfterLimit = declared >= 0)
        try {
            val buffered = sink.buffer()
            body.writeTo(buffered)
            buffered.flush()
        } catch (_: CapReached) {
            // enough captured
        } catch (_: IOException) {
            return WireBody.sizeOnly(declared)
        }
        val complete = sink.total <= limit && (declared < 0 || sink.total >= declared)
        val transferSize = if (declared >= 0) declared else sink.total
        return BodyCapture.encode(
            raw = sink.bytes(),
            rawLength = sink.stored,
            rawComplete = complete,
            transferSize = transferSize,
            contentType = contentType,
            contentEncoding = request.header("Content-Encoding"),
            limit = limit,
        )
    }

    private fun captureResponseBody(core: DurbunCore, request: Request, response: Response): WireBody? {
        if (!promisesBody(request, response)) return null
        val body = response.body ?: return null
        val length = body.contentLength()
        val contentType = body.contentType()?.toString() ?: response.header("Content-Type", null)
        if (!core.captureBodies || isStream(request, response, contentType)) return WireBody.sizeOnly(length)
        val limit = core.maxBodyBytes
        val peeked = try {
            response.peekBody(limit.toLong() + 1).bytes()
        } catch (_: IOException) {
            return WireBody.sizeOnly(length)
        }
        return BodyCapture.encode(
            raw = peeked,
            rawLength = peeked.size,
            rawComplete = peeked.size <= limit,
            transferSize = length,
            contentType = contentType,
            contentEncoding = response.header("Content-Encoding", null),
            limit = limit,
        )
    }

    /** Responses that never end or are taken over by the app (SSE, WebSocket, media) are not peeked. */
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

    private fun isOneShotOrDuplex(body: RequestBody): Boolean = try {
        body.isOneShot() || body.isDuplex()
    } catch (_: LinkageError) {
        false // OkHttp < 3.14
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

    /** Collects the first [limit] bytes written; counts all of them. */
    private class CappedSink(private val limit: Int, private val stopAfterLimit: Boolean) : Sink {
        private val out = ByteArrayOutputStream(minOf(limit, 64 * 1024).coerceAtLeast(16))
        var total = 0L
            private set
        val stored: Int get() = out.size()

        fun bytes(): ByteArray = out.toByteArray()

        override fun write(source: Buffer, byteCount: Long) {
            val room = (limit - out.size()).coerceAtLeast(0).toLong()
            val keep = minOf(byteCount, room)
            if (keep > 0) out.write(source.readByteArray(keep))
            val rest = byteCount - keep
            if (rest > 0) source.skip(rest)
            total += byteCount
            if ((stopAfterLimit && total > limit) || total > HARD_LIMIT) throw CapReached()
        }

        override fun flush() = Unit

        override fun timeout(): Timeout = Timeout.NONE

        override fun close() = Unit
    }

    /** Stops writing a request body into the side buffer once enough was captured. */
    private class CapReached : RuntimeException() {
        override fun fillInStackTrace(): Throwable = this
    }

    companion object {
        const val SOURCE = "okhttp"
        /** Same marker as the Dart (dart:io) and Swift (URLSession) layers. */
        private const val REDACTED = "••••"
        private const val HARD_LIMIT = 64L * 1024 * 1024

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
