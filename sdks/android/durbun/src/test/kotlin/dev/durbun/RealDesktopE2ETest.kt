package dev.durbun

import dev.durbun.internal.CrashHandler
import dev.durbun.internal.DurbunCore
import dev.durbun.internal.Json
import dev.durbun.internal.MetricsSampler
import dev.durbun.internal.bool
import dev.durbun.internal.list
import dev.durbun.internal.num
import dev.durbun.internal.obj
import dev.durbun.internal.str
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.ConnectException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.zip.GZIPOutputStream
import kotlin.concurrent.thread

/**
 * End-to-end against a REAL Dürbün desktop (not the fake one). Skipped unless `DURBUN_E2E_PORT` is set:
 *
 *     DURBUN_E2E_PORT=9751 ./gradlew --offline --no-daemon --max-workers=2 :durbun:testDebugUnitTest --tests '*E2E*'
 *
 * `DURBUN_E2E_HTTP_PORT` (default: the SDK port − 1) is the desktop's HTTP port. The test drives `/ui` like
 * the desktop UI does (`mocks.set`, `app.action`) and checks what the UI would show: the app session, logs
 * (levels, tags, data, Java stack traces, the crash), the event, network entries with bodies (REST
 * `/api/network/:id`), metrics and the disconnect line. Traffic goes through a real OkHttp client with
 * [DurbunInterceptor] against a local HTTP server ([TestHttpServer]: `com.sun.net.httpserver` is not on the
 * Android unit-test compile classpath).
 */
class RealDesktopE2ETest {
    private val sdkPort = System.getenv("DURBUN_E2E_PORT")?.toIntOrNull()
    private val httpPort = System.getenv("DURBUN_E2E_HTTP_PORT")?.toIntOrNull() ?: sdkPort?.minus(1)

    private lateinit var origin: TestHttpServer
    private lateinit var ui: UiClient
    private var core: DurbunCore? = null
    private val appPackage = "dev.durbun.android.e2e.${System.currentTimeMillis() % 100_000}"

    @Before
    fun setUp() {
        assumeTrue("set DURBUN_E2E_PORT to run against a real Dürbün desktop", sdkPort != null && httpPort != null)
        origin = TestHttpServer(::serve)
        ui = UiClient(httpPort!!)
        ui.await { it["type"] == "history" && it["done"] == true }
    }

    @After
    fun tearDown() {
        if (sdkPort == null) return
        try {
            ui.command(mapOf("name" to "mocks.set", "rules" to emptyList<Any>()))
        } catch (_: Throwable) {
        }
        core?.let {
            CrashHandler.uninstall(it)
            it.stop()
        }
        Durbun.installForTesting(null)
        ui.close()
        origin.close()
    }

    private fun originUrl(path: String) = origin.url(path)

    private fun serve(request: RecordedRequest): TestResponse {
        fun json(status: Int, text: String, reason: String = "OK", extra: List<Pair<String, String>> = emptyList()) =
            TestResponse(status = status, reason = reason, headers = listOf("Content-Type" to "application/json; charset=utf-8") + extra, body = text.toByteArray())
        return when (request.path.substringBefore('?')) {
            "/api/users" -> json(200, """{"users":[{"id":1,"name":"Ayşe"},{"id":2,"name":"Mehmet"}]}""")
            "/api/orders" -> json(201, """{"id":1001,"echo":${String(request.body)}}""", "Created", listOf("Location" to "/api/orders/1001"))
            "/api/feed" -> {
                val out = ByteArrayOutputStream()
                GZIPOutputStream(out).use { gz -> gz.write((1..50).joinToString(",", "[", "]") { """{"id":$it,"title":"Gönderi $it"}""" }.toByteArray()) }
                TestResponse(headers = listOf("Content-Type" to "application/json", "Content-Encoding" to "gzip"), body = out.toByteArray())
            }
            "/api/probe" -> json(200, """{"real":true}""")
            else -> json(404, """{"error":"not_found"}""", "Not Found")
        }
    }

    @Test
    fun realDesktopSeesLogsNetworkMocksCrashAndActions() {
        val env = FakeEnvironment(appId = appPackage)
        val c = DurbunCore(DurbunOptions(port = sdkPort!!), E2EEnvironment(env), FAST_TIMING)
        c.metricsSampler = object : MetricsSampler {
            override fun sample(): Map<String, Any?> {
                val rt = Runtime.getRuntime()
                return linkedMapOf("heapMB" to (rt.totalMemory() - rt.freeMemory()) / 1_048_576.0, "threads" to Thread.activeCount())
            }

            override fun pause() {}
        }
        var toggled = false
        c.addAction(DurbunAction.toggle("e2e.toggle", "E2E toggle", initial = false, group = "e2e") { toggled = it })
        core = c
        Durbun.installForTesting(c)
        c.start()
        CrashHandler.install(c)
        waitUntil("SDK connected") { c.isConnected }
        val appId = c.serverAppId!!

        /* session + device as the UI sees them */
        val app = ui.waitApp(appId) { it.bool("connected") == true }
        assertEquals("durbun-android", app.obj("sdk")!!.str("name"))
        assertEquals("android", app.obj("sdk")!!.str("platform"))
        assertEquals(appPackage, app.obj("app")!!.str("id"))
        val deviceId = app.str("deviceId")!!
        assertTrue("no Android device online → own net: device, got $deviceId", deviceId.startsWith("net:android-"))
        assertTrue(app.list("capabilities")!!.containsAll(listOf("logs", "network", "mocks", "events", "commands", "crash", "metrics")))

        /* logs, event, crash */
        Durbun.v("cache", "cache miss for home_feed")
        Durbun.d("ui", "render HomeScreen", data = mapOf("items" to 24))
        Durbun.i("auth", "Kullanıcı giriş yaptı", data = mapOf("userId" to 42, "method" to "google"))
        Durbun.w("api", "Slow response", data = mapOf("ms" to 2300))
        Durbun.e("payment", "Ödeme başarısız", throwable = IllegalStateException("card declined", IOException("socket closed")))
        Durbun.log(Level.FATAL, "db", "migration failed\nline 2\nline 3")
        Durbun.event("purchase", mapOf("amount" to 49.9, "currency" to "TRY"))
        val crashThread = thread(name = "e2e-crash") { throw IllegalArgumentException("E2E crash on purpose") }
        crashThread.join(5_000)

        val logs = ui.waitLogs(appId) { list -> list.any { it.str("kind") == "crash" } && list.any { it.str("kind") == "event" } }
        val levels = logs.filter { it.str("source") == "app" }.mapNotNull { it.str("level") }.toSet()
        assertTrue("levels: $levels", levels.containsAll(listOf("verbose", "debug", "info", "warn", "error", "fatal")))
        val auth = logs.first { it.str("message") == "Kullanıcı giriş yaptı" }
        assertEquals("auth", auth.str("tag"))
        assertEquals(42, auth.obj("data")!!.num("userId")!!.toInt())
        val payment = logs.first { it.str("tag") == "payment" }
        assertEquals("error", payment.str("level"))
        val paymentStack = payment.obj("error")!!.str("stack")!!
        assertTrue(paymentStack, paymentStack.contains("\tat ") && paymentStack.contains("Caused by: java.io.IOException: socket closed"))
        val crash = logs.first { it.str("kind") == "crash" }
        assertEquals("fatal", crash.str("level"))
        assertTrue(crash.str("message")!!, crash.str("message")!!.startsWith("FATAL EXCEPTION in thread \"e2e-crash\": java.lang.IllegalArgumentException: E2E crash on purpose"))
        assertTrue(crash.obj("error")!!.str("stack")!!.contains("\tat "))
        val event = logs.first { it.str("kind") == "event" }
        assertEquals("purchase", event.str("message"))
        assertEquals("TRY", event.obj("data")!!.str("currency"))

        /* network through OkHttp + DurbunInterceptor */
        val http = OkHttpClient.Builder().addInterceptor(DurbunInterceptor()).callTimeout(15, TimeUnit.SECONDS).build()
        http.newCall(Request.Builder().url(originUrl("/api/users?page=1")).header("Authorization", "Bearer e2e").build()).execute().use {
            assertEquals(200, it.code)
            assertTrue(it.body!!.string().contains("Ayşe"))
        }
        http.newCall(Request.Builder().url(originUrl("/api/orders")).post("""{"sku":"TSHIRT-M","qty":2}""".toRequestBody("application/json".toMediaType())).build()).execute().use {
            assertEquals(201, it.code)
        }
        http.newCall(Request.Builder().url(originUrl("/api/missing")).build()).execute().use { assertEquals(404, it.code) }
        http.newCall(Request.Builder().url(originUrl("/api/feed")).build()).execute().use { assertTrue(it.body!!.string().contains("Gönderi 50")) }

        // Mocks set from the desktop UI apply to the very next request.
        val rule = { id: String, action: Map<String, Any?> ->
            linkedMapOf("id" to id, "enabled" to true, "method" to "GET", "url" to "/api/probe", "match" to "contains", "action" to action, "createdAt" to System.currentTimeMillis())
        }
        fun setMocks(vararg rules: Map<String, Any?>) {
            val reply = ui.command(mapOf("name" to "mocks.set", "rules" to rules.toList()))
            assertEquals(true, reply["ok"])
            waitUntil("mock rules reached the SDK") { c.mockRules.map { it.id } == rules.map { it["id"] } }
        }
        setMocks(rule("android-respond", linkedMapOf("type" to "respond", "status" to 418, "headers" to listOf(listOf("content-type", "application/json")), "body" to """{"mocked":true}""")))
        http.newCall(Request.Builder().url(originUrl("/api/probe?n=1")).build()).execute().use {
            assertEquals(418, it.code)
            assertEquals("""{"mocked":true}""", it.body!!.string())
        }
        setMocks(rule("android-delay", linkedMapOf("type" to "delay", "delayMs" to 500)))
        val started = System.nanoTime()
        http.newCall(Request.Builder().url(originUrl("/api/probe?n=2")).build()).execute().use {
            assertEquals(200, it.code)
            assertTrue((System.nanoTime() - started) / 1_000_000 >= 490)
        }
        setMocks(rule("android-fail", linkedMapOf("type" to "fail", "error" to "connection")))
        val failure = runCatching { http.newCall(Request.Builder().url(originUrl("/api/probe?n=3")).build()).execute().close() }.exceptionOrNull()
        assertTrue("expected a ConnectException, got $failure", failure is ConnectException)
        setMocks()

        val net = ui.waitNetwork(appId) { list -> list.size >= 7 && list.none { it.str("state") == "pending" } }
        fun entry(path: String) = net.first { it.str("path")!!.startsWith(path) }
        val users = entry("/api/users")
        assertEquals(200, users.num("status")!!.toInt())
        assertEquals("okhttp", users.str("source"))
        val usersDetail = ui.get("/api/network/${users.str("id")}")
        assertTrue(usersDetail.obj("responseBody")!!.str("data")!!.contains("Ayşe"))
        assertTrue(users.list("requestHeaders")!!.any { (it as List<*>)[0].toString().equals("authorization", true) })
        val orders = entry("/api/orders")
        assertEquals(201, orders.num("status")!!.toInt())
        assertTrue(ui.get("/api/network/${orders.str("id")}").obj("requestBody")!!.str("data")!!.contains("TSHIRT-M"))
        assertEquals(404, entry("/api/missing").num("status")!!.toInt())
        val feed = ui.get("/api/network/${entry("/api/feed").str("id")}").obj("responseBody")!!
        assertTrue("gzip body is stored decoded", feed.str("data")!!.contains("Gönderi 50"))
        val mocked = entry("/api/probe?n=1")
        assertEquals(true, mocked["mocked"])
        assertEquals("android-respond", mocked.str("mockRuleId"))
        assertEquals(418, mocked.num("status")!!.toInt())
        val delayed = entry("/api/probe?n=2")
        assertEquals(true, delayed["mocked"])
        assertEquals(200, delayed.num("status")!!.toInt())
        val failed = entry("/api/probe?n=3")
        assertEquals("failed", failed.str("state"))
        assertEquals(true, failed["mocked"])
        assertEquals(net.size, ui.logs().count { it.str("appId") == appId && it.str("kind") == "network" })

        /* app.action round trip ({ value } params) + actions update */
        val reply = ui.command(mapOf("name" to "app.action", "appId" to appId, "action" to "e2e.toggle", "params" to mapOf("value" to true)))
        assertEquals(true, reply["ok"])
        assertTrue(toggled)
        ui.waitApp(appId) { a -> a.list("actions")!!.any { (it as Map<*, *>)["id"] == "e2e.toggle" && it["value"] == true } }
        val dump = ui.command(mapOf("name" to "app.action", "appId" to appId, "action" to "android.dumpThreads", "params" to emptyMap<String, Any>()))
        assertEquals(true, dump["ok"])
        ui.waitLogs(appId) { list -> list.any { it.str("message")?.startsWith("Thread dump") == true } }

        /* metrics */
        val metrics = ui.waitMetrics(appId) { it.isNotEmpty() }
        assertTrue(metrics.all { it.str("source") == "sdk" && it.num("heapMB") != null })

        /* disconnect */
        c.stop()
        ui.waitLogs(appId) { list -> list.any { it.str("code") == "app.disconnected" } }
        ui.waitApp(appId) { it.bool("connected") == false }
    }

    private fun waitUntil(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(20)
        }
        throw AssertionError("Timed out: $what")
    }

    /** Plain-JVM environment with emulator-like hints (no Android device is online in this test). */
    private class E2EEnvironment(private val base: FakeEnvironment) : dev.durbun.internal.Environment by base {
        override fun deviceHints(): Map<String, Any?> = linkedMapOf(
            "platform" to "android",
            "model" to "sdk_gphone64_arm64",
            "manufacturer" to "Google",
            "name" to "E2E Emulator",
            "osVersion" to "15",
            "apiLevel" to 35,
            "isPhysical" to false,
        )

        override fun appInfo(): Map<String, Any?> = base.appInfo() + ("name" to "Android E2E")
    }

    /** A tiny desktop UI: the `/ui` WebSocket (with an allowed Origin) plus the REST API. */
    private class UiClient(private val httpPort: Int) : WebSocketListener() {
        private val origin = "http://localhost:$httpPort"
        private val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).build()
        private val messages = CopyOnWriteArrayList<Map<String, Any?>>()
        private val seq = AtomicInteger()
        private val ws: WebSocket = client.newWebSocket(
            Request.Builder().url("ws://127.0.0.1:$httpPort/ui").header("Origin", origin).build(),
            this,
        )

        override fun onMessage(webSocket: WebSocket, text: String) {
            Json.parseObject(text)?.let { messages += it }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            messages += mapOf("type" to "failure", "error" to t.toString())
        }

        fun await(timeoutMs: Long = 10_000, predicate: (Map<String, Any?>) -> Boolean): Map<String, Any?> {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                messages.firstOrNull(predicate)?.let { return it }
                Thread.sleep(20)
            }
            throw AssertionError("UI: timed out (${messages.map { it["type"] }.distinct()})")
        }

        fun command(command: Map<String, Any?>, timeoutMs: Long = 15_000): Map<String, Any?> {
            val id = "e2e-${seq.incrementAndGet()}"
            ws.send(Json.encode(linkedMapOf("type" to "command", "requestId" to id, "command" to command)))
            return await(timeoutMs) { it["type"] == "reply" && it["requestId"] == id }
        }

        @Suppress("UNCHECKED_CAST")
        private fun collect(key: String): List<Map<String, Any?>> =
            messages.filter { it["type"] == "snapshot" || it["type"] == "batch" || it["type"] == "history" }
                .flatMap { (it[key] as? List<Map<String, Any?>>).orEmpty() }

        fun logs(): List<Map<String, Any?>> = collect("logs")

        /** Latest state per id (snapshot, then batches). */
        private fun latest(key: String): Map<String, Map<String, Any?>> = LinkedHashMap<String, Map<String, Any?>>().also { out ->
            for (item in collect(key)) item.str("id")?.let { out[it] = item }
        }

        fun waitApp(appId: String, timeoutMs: Long = 10_000, predicate: (Map<String, Any?>) -> Boolean): Map<String, Any?> =
            poll(timeoutMs, "app $appId") { latest("apps")[appId]?.takeIf(predicate) }

        fun waitLogs(appId: String, timeoutMs: Long = 10_000, predicate: (List<Map<String, Any?>>) -> Boolean): List<Map<String, Any?>> =
            poll(timeoutMs, "logs of $appId") { logs().filter { it.str("appId") == appId }.takeIf(predicate) }

        fun waitNetwork(appId: String, timeoutMs: Long = 10_000, predicate: (List<Map<String, Any?>>) -> Boolean): List<Map<String, Any?>> =
            poll(timeoutMs, "network of $appId") { latest("network").values.filter { it.str("appId") == appId }.takeIf(predicate) }

        fun waitMetrics(appId: String, timeoutMs: Long = 10_000, predicate: (List<Map<String, Any?>>) -> Boolean): List<Map<String, Any?>> =
            poll(timeoutMs, "metrics of $appId") { collect("metrics").filter { it.str("appId") == appId }.takeIf(predicate) }

        fun get(path: String): Map<String, Any?> {
            client.newCall(Request.Builder().url("http://127.0.0.1:$httpPort$path").header("Origin", origin).build()).execute().use {
                assertEquals("GET $path", 200, it.code)
                val body = Json.parseObject(it.body!!.string())
                assertNotNull("GET $path returned JSON", body)
                return body!!
            }
        }

        private fun <T> poll(timeoutMs: Long, what: String, block: () -> T?): T {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                block()?.let { return it }
                Thread.sleep(25)
            }
            throw AssertionError("UI: timed out waiting for $what")
        }

        fun close() {
            ws.close(1000, "done")
            client.dispatcher.executorService.shutdown()
            client.connectionPool.evictAll()
        }
    }
}
