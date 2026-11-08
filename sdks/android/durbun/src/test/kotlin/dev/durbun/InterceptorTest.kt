package dev.durbun

import dev.durbun.internal.DurbunCore
import okhttp3.FormBody
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import okio.source
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.ConnectException
import java.net.InetAddress
import java.net.Proxy
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.Base64
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPOutputStream
import javax.net.ssl.SSLHandshakeException

/** DurbunInterceptor against a real OkHttp client, a local HTTP server and a fake desktop. */
class InterceptorTest {
    private lateinit var desktop: FakeDesktop
    private lateinit var server: TestHttpServer
    private var core: DurbunCore? = null

    private val bigText = (1..400).joinToString("\n") { "satır $it — Dürbün ağ testi" }

    private fun gzip(bytes: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(bytes) }
        return out.toByteArray()
    }

    @Before
    fun setUp() {
        desktop = FakeDesktop()
        server = TestHttpServer { request ->
            when {
                request.path.startsWith("/users") -> TestResponse(
                    headers = listOf("Content-Type" to "application/json; charset=utf-8", "X-Request-Id" to "abc-123"),
                    body = "{\"users\":[{\"id\":1,\"name\":\"Ayşe\"},{\"id\":2,\"name\":\"Mehmet\"}]}".toByteArray(),
                )
                request.path.startsWith("/echo") -> TestResponse(
                    status = 201,
                    reason = "Created",
                    headers = listOf("Content-Type" to (request.header("Content-Type") ?: "application/octet-stream")),
                    body = request.body,
                )
                request.path.startsWith("/gzip") -> {
                    val zipped = gzip(bigText.toByteArray())
                    TestResponse(headers = listOf("Content-Type" to "text/plain; charset=utf-8", "Content-Encoding" to "gzip"), body = zipped)
                }
                request.path.startsWith("/big") -> TestResponse(
                    headers = listOf("Content-Type" to "text/plain; charset=utf-8"),
                    body = bigText.toByteArray(),
                )
                request.path.startsWith("/image") -> TestResponse(
                    headers = listOf("Content-Type" to "image/png"),
                    body = ByteArray(64) { (it * 3).toByte() },
                )
                request.path.startsWith("/slow-json") -> TestResponse(
                    headers = listOf("Content-Type" to "application/json"),
                    body = "{\"tick\":1}".toByteArray(),
                    holdOpenMs = 2_000,
                )
                request.path.startsWith("/events") -> TestResponse(
                    headers = listOf("Content-Type" to "text/event-stream"),
                    body = "data: merhaba\n\n".toByteArray(),
                    holdOpenMs = 3_000,
                )
                request.path.startsWith("/missing") -> TestResponse(
                    status = 404,
                    reason = "Not Found",
                    headers = listOf("Content-Type" to "application/problem+json"),
                    body = "{\"title\":\"Kayıt bulunamadı\"}".toByteArray(),
                )
                else -> TestResponse(status = 500, reason = "Server Error")
            }
        }
    }

    @After
    fun tearDown() {
        Durbun.installForTesting(null)
        core?.stop()
        desktop.close()
        server.close()
    }

    private fun connect(options: DurbunOptions = DurbunOptions()): DurbunCore {
        val c = startCore(desktop, options)
        core = c
        Durbun.installForTesting(c)
        val deadline = System.currentTimeMillis() + 5_000
        while (!c.isConnected && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertTrue("SDK should connect to the fake desktop", c.isConnected)
        return c
    }

    private fun client(interceptor: DurbunInterceptor = DurbunInterceptor()) = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .addInterceptor(interceptor)
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private fun requestFor(url: String) = desktop.await("net.request") { it["url"] == url }

    private fun responseFor(request: Map<String, Any?>) = desktop.await("net.response") { it["id"] == request["id"] }

    /** The last `net.request` of a call: bodies captured during OkHttp's write are reported again (same id). */
    private fun finalRequestFor(url: String): Map<String, Any?> {
        val first = requestFor(url)
        desktop.await("net.response") { it["id"] == first["id"] }
        return desktop.messages("net.request").last { it["id"] == first["id"] }
    }

    @Test
    fun capturesGetWithJsonResponse() {
        connect()
        val url = server.url("/users?page=1")
        val body = client().newCall(Request.Builder().url(url).header("X-Trace", "t-1").build()).execute().use { it.body!!.string() }
        assertTrue("the app still gets the full body", body.contains("Mehmet"))

        val request = requestFor(url)
        assertEquals("GET", request["method"])
        assertEquals("okhttp", request["source"])
        assertEquals("t-1", headerValue(request, "X-Trace"))
        assertNull(request["body"])

        val response = responseFor(request)
        assertEquals(200L, response["status"])
        assertEquals("OK", response["statusText"])
        assertEquals("abc-123", headerValue(response, "X-Request-Id"))
        assertEquals("http/1.1", response["protocol"])
        val captured = response.objAt("body")
        assertEquals("utf8", captured["encoding"])
        assertEquals(body, captured["data"])
        assertEquals(body.toByteArray().size.toLong(), captured["size"])
        assertNull(captured["truncated"])
        assertTrue((response["ts"] as Number).toDouble() >= (request["ts"] as Number).toDouble())
        val timings = response.objAt("timings")
        assertTrue(timings.containsKey("wait"))
        assertNull(response["mocked"])
    }

    @Test
    fun capturesRequestBodyWithoutConsumingIt() {
        connect()
        val url = server.url("/echo")
        val json = "{\"email\":\"ayse@example.com\",\"remember\":true}"
        val echoed = client().newCall(
            Request.Builder().url(url).post(json.toRequestBody("application/json; charset=utf-8".toMediaType())).build(),
        ).execute().use { it.body!!.string() }
        assertEquals("the server received the untouched body", json, echoed)
        assertEquals(json, String(server.requests.last().body))

        val first = requestFor(url)
        assertEquals("size first, bytes once OkHttp wrote them", "", first.objAt("body")["data"])
        assertEquals(json.length.toLong(), first.objAt("body")["size"])
        val request = finalRequestFor(url)
        assertEquals(first["ts"], request["ts"])
        assertEquals("POST", request["method"])
        assertEquals("application/json; charset=utf-8", headerValue(request, "Content-Type"))
        assertEquals(json.length.toString(), headerValue(request, "Content-Length"))
        assertEquals(json, request.objAt("body")["data"])
        assertEquals(2, desktop.messages("net.request").count { it["id"] == first["id"] })
        val response = responseFor(request)
        assertEquals(201L, response["status"])
        assertEquals("Created", response["statusText"])
    }

    @Test
    fun oneShotRequestBodiesAreCapturedFromOkHttpsOwnWrite() {
        connect()
        var writes = 0
        val oneShot = object : RequestBody() {
            override fun contentType() = "text/plain".toMediaType()
            override fun contentLength() = 5L
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                writes++
                sink.writeUtf8("hello")
            }
        }
        val url = server.url("/echo")
        client().newCall(Request.Builder().url(url).post(oneShot).build()).execute().close()
        assertEquals("written once, by OkHttp only", 1, writes)
        assertEquals("hello", String(server.requests.last().body))
        val body = finalRequestFor(url).objAt("body")
        assertEquals("hello", body["data"])
        assertEquals(5L, body["size"])
        assertNull(body["truncated"])
    }

    @Test
    fun streamingCustomBodiesOfUnknownLengthAreNotWrittenTwice() {
        connect()
        var writes = 0
        val streaming = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = -1L
            override fun writeTo(sink: BufferedSink) {
                writes++
                sink.writeUtf8("chunk")
            }
        }
        val url = server.url("/echo")
        client().newCall(Request.Builder().url(url).post(streaming).build()).execute().close()
        assertEquals(1, writes)
        assertEquals("chunk", String(server.requests.last().body))
        assertNull("unknown size: nothing to show before the write", requestFor(url)["body"])
        val captured = finalRequestFor(url).objAt("body")
        assertEquals("base64", captured["encoding"])
        assertEquals("chunk", String(Base64.getDecoder().decode(captured["data"] as String)))
    }

    @Test
    fun inputStreamUploadsReachTheServerWhole() {
        connect(DurbunOptions(maxBodyBytes = 1_000))
        val payload = ByteArray(3 * 1024 * 1024) { (it % 251).toByte() }
        var writes = 0
        val stream = ByteArrayInputStream(payload)
        val upload = object : RequestBody() {
            override fun contentType() = "application/octet-stream".toMediaType()
            override fun contentLength() = payload.size.toLong()
            override fun writeTo(sink: BufferedSink) {
                writes++
                sink.writeAll(stream.source()) // like a content-URI / file stream: can be read once
            }
        }
        val url = server.url("/echo")
        client().newCall(Request.Builder().url(url).post(upload).build()).execute().use { it.body!!.bytes() }
        assertEquals(1, writes)
        assertArrayEquals("the server got every byte", payload, server.requests.last().body)
        val body = finalRequestFor(url).objAt("body")
        assertEquals(payload.size.toLong(), body["size"])
        assertEquals(true, body["truncated"])
        assertArrayEquals(payload.copyOf(1_000), Base64.getDecoder().decode(body["data"] as String))
    }

    @Test
    fun formBodiesStayFormBodiesForLaterInterceptors() {
        connect()
        var seen: RequestBody? = null
        val client = OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
            .addInterceptor(DurbunInterceptor())
            .addInterceptor { chain -> seen = chain.request().body; chain.proceed(chain.request()) }
            .build()
        val url = server.url("/echo")
        val form = FormBody.Builder().add("kullanıcı", "ayşe").add("plan", "pro").build()
        client.newCall(Request.Builder().url(url).post(form).build()).execute().use { it.body!!.string() }
        assertTrue("the next interceptor still sees the app's FormBody", seen === form)
        val request = requestFor(url)
        assertEquals("captured at once (plain in-memory data)", "kullan%C4%B1c%C4%B1=ay%C5%9Fe&plan=pro", request.objAt("body")["data"])
        assertEquals(1, desktop.messages("net.request").count { it["id"] == request["id"] })
    }

    @Test
    fun theAppGetsTheResponseBeforeTheBodyArrives() {
        connect()
        val url = server.url("/slow-json")
        val started = System.nanoTime()
        client().newCall(Request.Builder().url(url).build()).execute().use { response ->
            val headersMs = (System.nanoTime() - started) / 1_000_000
            assertTrue("execute() must not wait for the body (took $headersMs ms)", headersMs < 1_500)
            val id = requestFor(url)["id"]
            assertTrue("reported once the app read the body", desktop.messages("net.response").none { it["id"] == id })
            assertEquals("{\"tick\":1}", response.body!!.string())
        }
        val captured = responseFor(requestFor(url)).objAt("body")
        assertEquals("{\"tick\":1}", captured["data"])
        assertNull(captured["truncated"])
    }

    @Test
    fun bodiesClosedUnreadAreReportedWithTheirSize() {
        connect()
        val url = server.url("/users")
        client().newCall(Request.Builder().url(url).build()).execute().close()
        val response = responseFor(requestFor(url))
        assertEquals(200L, response["status"])
        val body = response.objAt("body")
        assertEquals("", body["data"])
        assertEquals(true, body["truncated"])
        assertTrue((body["size"] as Long) > 0)
    }

    @Test
    fun respondMocksAreSkippedInNetworkInterceptorPosition() {
        desktop.mocks = listOf(mockRule("m", "/users", mapOf("type" to "respond", "status" to 299, "body" to "mock")))
        connect()
        val client = OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
            .addNetworkInterceptor(DurbunInterceptor())
            .build()
        val url = server.url("/users")
        client.newCall(Request.Builder().url(url).build()).execute().use {
            assertEquals("the real server answered", 200, it.code)
        }
        val response = responseFor(requestFor(url))
        assertEquals(200L, response["status"])
        assertNull(response["mocked"])
        // Network position sees the wire: OkHttp's own headers and the socket address.
        assertEquals("gzip", headerValue(requestFor(url), "Accept-Encoding"))
        assertEquals("127.0.0.1:${server.port}", response["remoteAddress"])
    }

    @Test
    fun decodesGzipTheAppAskedForAndLeavesItCompressedForTheApp() {
        connect()
        val url = server.url("/gzip")
        val raw = client().newCall(Request.Builder().url(url).header("Accept-Encoding", "gzip").build())
            .execute().use { it.body!!.bytes() }
        assertArrayEquals("the app receives the compressed bytes it asked for", gzip(bigText.toByteArray()), raw)
        val captured = responseFor(requestFor(url)).objAt("body")
        assertEquals("utf8", captured["encoding"])
        assertEquals(bigText, captured["data"])
        assertEquals(bigText.toByteArray().size.toLong(), captured["size"])
    }

    @Test
    fun transparentGzipIsSeenDecoded() {
        connect()
        val url = server.url("/gzip-auto")
        val text = client().newCall(Request.Builder().url(url).build()).execute().use { it.body!!.string() }
        assertEquals(bigText, text)
        assertEquals(bigText, responseFor(requestFor(url)).objAt("body")["data"])
    }

    @Test
    fun truncatesLargeBodiesButTheAppGetsEverything() {
        connect(DurbunOptions(maxBodyBytes = 1_000))
        val url = server.url("/big")
        val text = client().newCall(Request.Builder().url(url).build()).execute().use { it.body!!.string() }
        assertEquals(bigText, text)
        val captured = responseFor(requestFor(url)).objAt("body")
        assertEquals(true, captured["truncated"])
        assertEquals(bigText.toByteArray().size.toLong(), captured["size"])
        assertTrue((captured["data"] as String).toByteArray().size <= 1_000)
        assertTrue(bigText.startsWith(captured["data"] as String))
    }

    @Test
    fun binaryBodiesAreBase64AndErrorsBodiesAreKept() {
        connect()
        val imageUrl = server.url("/image.png")
        client().newCall(Request.Builder().url(imageUrl).build()).execute().use { it.body!!.bytes() }
        val image = responseFor(requestFor(imageUrl)).objAt("body")
        assertEquals("base64", image["encoding"])
        assertArrayEquals(ByteArray(64) { (it * 3).toByte() }, Base64.getDecoder().decode(image["data"] as String))

        val missingUrl = server.url("/missing/42")
        client().newCall(Request.Builder().url(missingUrl).build()).execute().use { it.body!!.string() }
        val missing = responseFor(requestFor(missingUrl))
        assertEquals(404L, missing["status"])
        assertEquals("{\"title\":\"Kayıt bulunamadı\"}", missing.objAt("body")["data"])
    }

    @Test
    fun streamingResponsesAreNotPeeked() {
        connect()
        val url = server.url("/events")
        val started = System.nanoTime()
        client().newCall(Request.Builder().url(url).build()).execute().use { response ->
            assertEquals("data: merhaba", response.body!!.source().readUtf8Line())
            val elapsedMs = (System.nanoTime() - started) / 1_000_000
            assertTrue("SSE must not wait for the stream to end (took $elapsedMs ms)", elapsedMs < 2_000)
        }
        val response = responseFor(requestFor(url))
        assertEquals(200L, response["status"])
        assertNull(response["body"])
    }

    @Test
    fun reportsNetworkErrors() {
        connect()
        val closedPort = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
        val url = "http://127.0.0.1:$closedPort/nothing"
        try {
            client().newCall(Request.Builder().url(url).build()).execute()
            fail("expected a connection error")
        } catch (_: IOException) {
        }
        val request = requestFor(url)
        val error = desktop.await("net.error") { it["id"] == request["id"] }
        assertTrue(error["error"] as String, (error["error"] as String).startsWith("ConnectException"))
        assertNull(error["mocked"])
    }

    private fun mockRule(id: String, url: String, action: Map<String, Any?>, method: String = "*", match: String = "contains") =
        linkedMapOf("id" to id, "enabled" to true, "method" to method, "url" to url, "match" to match, "action" to action, "createdAt" to 1)

    @Test
    fun respondMockNeverTouchesTheNetwork() {
        desktop.mocks = listOf(
            mockRule(
                "m-users",
                "/users",
                mapOf(
                    "type" to "respond",
                    "status" to 418,
                    "headers" to listOf(listOf("Content-Type", "application/json"), listOf("X-Mocked", "yes")),
                    "body" to "{\"mock\":true,\"isim\":\"Çaycı\"}",
                    "delayMs" to 150,
                ),
                method = "GET",
            ),
            mockRule("m-pixel", "*/pixel.gif", mapOf("type" to "respond", "status" to 200, "body" to "R0lGODlhAQABAAAAACw=", "bodyEncoding" to "base64",
                "headers" to listOf(listOf("Content-Type", "image/gif"))), match = "glob"),
        )
        connect()
        val url = server.url("/users/7")
        val started = System.nanoTime()
        client().newCall(Request.Builder().url(url).build()).execute().use { response ->
            assertEquals(418, response.code)
            assertEquals("yes", response.header("X-Mocked"))
            assertEquals("{\"mock\":true,\"isim\":\"Çaycı\"}", response.body!!.string())
            assertEquals("application/json", response.body!!.contentType().toString())
        }
        assertTrue("delayMs is honoured", (System.nanoTime() - started) / 1_000_000 >= 140)
        assertTrue("the server was never called", server.requests.none { it.path.startsWith("/users") })
        val response = responseFor(requestFor(url))
        assertEquals(418L, response["status"])
        assertEquals(true, response["mocked"])
        assertEquals("m-users", response["mockRuleId"])
        assertEquals("{\"mock\":true,\"isim\":\"Çaycı\"}", response.objAt("body")["data"])

        val gifUrl = server.url("/assets/pixel.gif")
        val gif = client().newCall(Request.Builder().url(gifUrl).build()).execute().use { it.body!!.bytes() }
        assertArrayEquals(Base64.getDecoder().decode("R0lGODlhAQABAAAAACw="), gif)
    }

    @Test
    fun respondMocksShowTheRequestBodyBeforeTheResponse() {
        desktop.mocks = listOf(mockRule("m-login", "/login", mapOf("type" to "respond", "status" to 200, "body" to "{}")))
        connect()
        val url = server.url("/login")
        val json = "{\"email\":\"ayse@example.com\"}"
        client().newCall(Request.Builder().url(url).post(json.toRequestBody("application/json".toMediaType())).build())
            .execute().use { assertEquals("{}", it.body!!.string()) }
        val request = finalRequestFor(url)
        assertEquals(json, request.objAt("body")["data"])
        val order = desktop.messages().filter { it["id"] == request["id"] }.map { it["type"] }
        assertEquals(listOf("net.request", "net.request", "net.response"), order)
    }

    @Test
    fun delayMockStillPerformsTheRealRequest() {
        desktop.mocks = listOf(mockRule("slow", "/users", mapOf("type" to "delay", "delayMs" to 300)))
        connect()
        val url = server.url("/users")
        val started = System.nanoTime()
        client().newCall(Request.Builder().url(url).build()).execute().use {
            assertEquals(200, it.code)
            it.body!!.string()
        }
        assertTrue((System.nanoTime() - started) / 1_000_000 >= 290)
        assertEquals(1, server.requests.count { it.path == "/users" })
        val response = responseFor(requestFor(url))
        assertEquals(true, response["mocked"])
        assertEquals("slow", response["mockRuleId"])
        assertTrue(response.objAt("body")["data"].toString().contains("Ayşe"))
    }

    @Test
    fun failMocksRaiseThePlatformsNaturalErrors() {
        desktop.mocks = listOf(
            mockRule("t", "/fail/timeout", mapOf("type" to "fail", "error" to "timeout")),
            mockRule("d", "/fail/dns", mapOf("type" to "fail", "error" to "dns")),
            mockRule("c", "/fail/connection", mapOf("type" to "fail", "error" to "connection")),
            mockRule("s", "/fail/tls", mapOf("type" to "fail", "error" to "tls")),
            mockRule("x", "/fail/custom", mapOf("type" to "fail", "error" to "custom", "message" to "Bakım modu")),
        )
        connect()
        val expected = mapOf(
            "timeout" to SocketTimeoutException::class.java,
            "dns" to UnknownHostException::class.java,
            "connection" to ConnectException::class.java,
            "tls" to SSLHandshakeException::class.java,
            "custom" to IOException::class.java,
        )
        for ((kind, type) in expected) {
            val url = server.url("/fail/$kind")
            try {
                client().newCall(Request.Builder().url(url).build()).execute()
                fail("$kind should fail")
            } catch (e: IOException) {
                assertTrue("$kind → ${e.javaClass}", type.isInstance(e))
                if (kind == "custom") assertEquals("Bakım modu", e.message)
            }
            val request = requestFor(url)
            val error = desktop.await("net.error") { it["id"] == request["id"] }
            assertEquals(true, error["mocked"])
            assertEquals(type.simpleName, (error["error"] as String).substringBefore(':'))
        }
        assertTrue(server.requests.none { it.path.startsWith("/fail") })
    }

    @Test
    fun redactsSensitiveHeaders() {
        connect()
        val url = server.url("/users")
        client(DurbunInterceptor(setOf("Authorization"))).newCall(
            Request.Builder().url(url).header("Authorization", "Bearer secret-token").build(),
        ).execute().close()
        assertEquals("••••", headerValue(requestFor(url), "Authorization"))
        assertEquals("Bearer secret-token", server.requests.last().header("Authorization"))
    }

    @Test
    fun flutterRedactionListUsesTheSameMarkerOnRequestsAndResponses() {
        // Hosted by Flutter: DurbunOptions(redactHeaders:) from Dart reaches every OkHttp client.
        connect().redactedHeaders = setOf("authorization", "x-request-id")
        val url = server.url("/users")
        client().newCall(
            Request.Builder().url(url).header("Authorization", "Bearer secret-token").header("X-Trace", "t-1").build(),
        ).execute().use { it.body!!.string() }
        val request = requestFor(url)
        assertEquals("same marker as dart:io and URLSession", "••••", headerValue(request, "Authorization"))
        assertEquals("t-1", headerValue(request, "X-Trace"))
        assertEquals("••••", headerValue(responseFor(request), "X-Request-Id"))
        assertEquals("Bearer secret-token", server.requests.last().header("Authorization"))
    }

    @Test
    fun captureNetworkOffIsAPlainPassThroughWithoutMocks() {
        desktop.mocks = listOf(
            mapOf(
                "id" to "m1", "enabled" to true, "method" to "GET", "url" to "/users", "match" to "contains",
                "action" to mapOf("type" to "respond", "status" to 418), "createdAt" to 1,
            ),
        )
        val core = connect(DurbunOptions(captureNetwork = false))
        val caps = desktop.await("hello").listAt("capabilities")
        assertFalse("network" in caps)
        assertFalse("mocks" in caps)
        assertTrue(core.mockRules.isNotEmpty())
        val url = server.url("/users")
        client().newCall(Request.Builder().url(url).build()).execute().use { assertEquals(200, it.code) }
        assertEquals("the real server answered (no mock)", 1, server.requests.size)
        core.log(Level.INFO, "test", "after the call", null, null)
        desktop.await("log") { it["message"] == "after the call" }
        assertFalse(desktop.messages().any { it["type"] == "net.request" })
    }

    @Test
    fun captureCanBeSwitchedOffByTheDesktop() {
        desktop.config = linkedMapOf("captureBodies" to false, "maxBodyBytes" to 1_048_576, "metricsIntervalMs" to 1000, "deviceLogsAvailable" to true)
        connect()
        val url = server.url("/users")
        client().newCall(Request.Builder().url(url).build()).execute().use { it.body!!.string() }
        val body = responseFor(requestFor(url)).objAt("body")
        assertEquals("", body["data"])
        assertEquals(true, body["truncated"])
        assertTrue((body["size"] as Long) > 0)
    }

    @Test
    fun passesThroughWhenDurbunIsNotStarted() {
        Durbun.installForTesting(null)
        val url = server.url("/users")
        client().newCall(Request.Builder().url(url).build()).execute().use { assertEquals(200, it.code) }
        assertFalse(desktop.messages().any { it["type"] == "net.request" })
    }
}
