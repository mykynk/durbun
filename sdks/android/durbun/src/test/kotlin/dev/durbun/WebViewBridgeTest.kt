package dev.durbun

import android.webkit.WebView
import dev.durbun.internal.DocumentStartScripts
import dev.durbun.internal.DurbunCore
import dev.durbun.internal.Json
import dev.durbun.internal.WebViewBridgeScript
import dev.durbun.internal.WebViewReceiver
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The native half of the web view bridge: messages as the injected script sends them (sdks/js/webview/bridge.ts)
 * become the SDK's own `net.*` and `log` messages, within its capture settings and limits. The WebView itself
 * cannot run in a JVM test; this covers everything around it.
 */
class WebViewBridgeTest {
    private val desktop = FakeDesktop()
    private var core: DurbunCore? = null
    private var clock = 1_000L

    @After
    fun tearDown() {
        Durbun.installForTesting(null)
        core?.stop()
        desktop.close()
        DocumentStartScripts.featureClass = "androidx.webkit.WebViewFeature"
        DocumentStartScripts.compatClass = "androidx.webkit.WebViewCompat"
    }

    private fun receiver(options: DurbunOptions = DurbunOptions()): WebViewReceiver {
        val c = startCore(desktop, options)
        core = c
        val deadline = System.currentTimeMillis() + 5_000
        while (!c.isConnected && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertTrue("SDK should connect to the fake desktop", c.isConnected)
        return WebViewReceiver({ core }, nowMs = { 1_700_000_000_000L }, monotonicMs = { clock })
    }

    private fun json(vararg pairs: Pair<String, Any?>): String = Json.encode(linkedMapOf("v" to 1, *pairs))

    private fun request(id: String = "w1-1", url: String = "https://shop.example.com/api/cart", extra: Map<String, Any?> = emptyMap()) = json(
        "t" to "req",
        "id" to id,
        "api" to "fetch",
        "ts" to 1_700_000_000_123L,
        "method" to "post",
        "url" to url,
        "headers" to listOf(listOf("Content-Type", "application/json"), listOf("Authorization", "Bearer secret")),
        "body" to mapOf("encoding" to "utf8", "data" to "{\"qty\":2}", "size" to 9),
        *extra.toList().toTypedArray(),
    )

    @Test
    fun aRequestAndItsResponseBecomeOneNetworkEntry() {
        val r = receiver(DurbunOptions(redactHeaders = setOf("authorization")))
        r.receive(request())
        r.receive(
            json(
                "t" to "res",
                "id" to "w1-1",
                "ts" to 1_700_000_000_400L,
                "status" to 201,
                "statusText" to "Created",
                "headers" to listOf(listOf("content-type", "application/json")),
                "body" to mapOf("encoding" to "utf8", "data" to "{\"ok\":true}", "size" to 11),
                "wait" to 120.25,
                "receive" to 3,
            ),
        )
        val req = desktop.await("net.request")
        assertEquals("POST", req["method"])
        assertEquals("https://shop.example.com/api/cart", req["url"])
        assertEquals("webview:fetch", req["source"])
        assertEquals(1_700_000_000_123L, (req["ts"] as Number).toLong())
        assertEquals(listOf(listOf("Content-Type", "application/json"), listOf("Authorization", "••••")), req["headers"])
        assertEquals(mapOf("encoding" to "utf8", "data" to "{\"qty\":2}", "size" to 9L), req["body"])
        assertTrue((req["id"] as String).startsWith("webview-"))
        val res = desktop.await("net.response") { it["id"] == req["id"] }
        assertEquals(201L, res["status"])
        assertEquals("Created", res["statusText"])
        assertEquals(mapOf("wait" to 120.3, "receive" to 3L), res["timings"])
        assertEquals("{\"ok\":true}", res.objAt("body")["data"])
    }

    @Test
    fun aRequestObjectBodyIsReportedAgainUnderTheSameId() {
        val r = receiver()
        r.receive(request(extra = mapOf("body" to null)))
        r.receive(json("t" to "reqbody", "id" to "w1-1", "body" to mapOf("encoding" to "utf8", "data" to "name=Ada", "size" to 8)))
        val both = desktop.awaitCount("net.request", 2)
        assertEquals(both[0]["id"], both[1]["id"])
        assertNull(both[0]["body"])
        assertEquals("name=Ada", both[1].objAt("body")["data"])
    }

    @Test
    fun failuresAndCancellationsBecomeNetErrors() {
        val r = receiver()
        r.receive(request(id = "a"))
        r.receive(request(id = "b"))
        r.receive(json("t" to "err", "id" to "a", "error" to "TypeError: Failed to fetch"))
        r.receive(json("t" to "err", "id" to "b", "error" to "AbortError", "cancelled" to true))
        val errors = desktop.awaitCount("net.error", 2)
        assertEquals("TypeError: Failed to fetch", errors[0]["error"])
        assertNull(errors[0]["cancelled"])
        assertEquals(true, errors[1]["cancelled"])
    }

    @Test
    fun consoleLinesBecomeLogsTaggedWebview() {
        val r = receiver()
        r.receive(json("t" to "log", "level" to "warn", "message" to "Slow image", "page" to "https://shop.example.com/"))
        r.receive(
            json(
                "t" to "log",
                "level" to "error",
                "message" to "Uncaught TypeError: x is undefined",
                "page" to "https://shop.example.com/",
                "error" to mapOf("type" to "TypeError", "message" to "x is undefined", "stack" to "at app.js:1:2", "extra" to 1),
            ),
        )
        r.receive(json("t" to "log", "level" to "bogus", "message" to "Plain"))
        val logs = desktop.awaitCount("log", 3) { it["tag"] == "webview" }
        assertEquals(listOf("warn", "error", "info"), logs.map { it["level"] })
        assertEquals(mapOf("page" to "https://shop.example.com/"), logs[0]["data"])
        assertEquals(mapOf("type" to "TypeError", "message" to "x is undefined", "stack" to "at app.js:1:2"), logs[1]["error"])
    }

    @Test
    fun followsTheCaptureSettings() {
        val r = receiver(DurbunOptions(maxBodyBytes = 4, ignoredHosts = listOf("analytics.example.com")))
        r.receive(request(id = "skipped", url = "https://eu.analytics.example.com/collect"))
        r.receive(json("t" to "res", "id" to "skipped", "status" to 204))
        r.receive(request(id = "kept"))
        val req = desktop.await("net.request")
        assertEquals("https://shop.example.com/api/cart", req["url"])
        assertEquals(mapOf("encoding" to "utf8", "data" to "{\"qt", "size" to 9L, "truncated" to true), req["body"])
        Thread.sleep(100)
        assertEquals(1, desktop.messages("net.request").size)
        assertTrue(desktop.messages("net.response").isEmpty())
    }

    @Test
    fun bodiesShrinkToSizesWhenBodyCaptureIsOff() {
        val r = receiver(DurbunOptions(captureBodies = false))
        r.receive(request())
        assertEquals(mapOf("encoding" to "utf8", "data" to "", "size" to 9L, "truncated" to true), desktop.await("net.request")["body"])
    }

    @Test
    fun networkCaptureOffKeepsTheConsole() {
        val r = receiver(DurbunOptions(captureNetwork = false))
        r.receive(request())
        r.receive(json("t" to "log", "level" to "info", "message" to "still here"))
        desktop.await("log") { it["message"] == "still here" }
        assertTrue(desktop.messages("net.request").isEmpty())
    }

    @Test
    fun ignoresWhatIsNotABridgeMessage() {
        val r = receiver()
        r.receive(null)
        r.receive("not json")
        r.receive("[1,2]")
        r.receive(Json.encode(mapOf("v" to 2, "t" to "log", "message" to "future version")))
        r.receive(json("t" to "log", "message" to 42))
        r.receive(request(url = "javascript:alert(1)"))
        r.receive(request(url = "file:///data/data/app/secret"))
        r.receive(json("t" to "req", "id" to listOf("x"), "url" to "https://a.example.com/"))
        r.receive(json("t" to "res", "id" to "never-requested", "status" to 200))
        r.receive(json("t" to "log", "message" to "x".repeat(WebViewReceiver.MAX_MESSAGE_CHARS)))
        r.receive(json("t" to "log", "level" to "info", "message" to "the last one"))
        desktop.await("log") { it["message"] == "the last one" }
        assertTrue(desktop.messages("net.request").isEmpty())
        assertTrue(desktop.messages("net.response").isEmpty())
        // The oversized message counts as dropped and is reported once.
        assertEquals(1, desktop.messages("log").count { (it["message"] as String).startsWith("Dürbün dropped") })
    }

    @Test
    fun capsLongFieldsAndForgedValues() {
        val r = receiver()
        r.receive(
            request(
                extra = mapOf(
                    "method" to "DROP TABLE",
                    "ts" to 1L,
                    "headers" to List(500) { listOf("X-$it", "v") } + listOf(listOf("X-Long", "y".repeat(20_000))),
                ),
            ),
        )
        val req = desktop.await("net.request")
        assertEquals("GET", req["method"])
        assertEquals(1_700_000_000_000L, (req["ts"] as Number).toLong()) // a clock far off is replaced by now
        assertEquals(WebViewReceiver.MAX_HEADERS, req.listAt("headers").size)
        r.receive(json("t" to "res", "id" to "w1-1", "status" to 99_999, "wait" to -5, "receive" to "slow"))
        val res = desktop.await("net.response")
        assertEquals(0L, res["status"])
        assertNull(res["timings"])
    }

    @Test
    fun limitsTheMessageRateAndSaysHowManyItDropped() {
        val r = receiver()
        repeat(WebViewReceiver.BURST + 100) { r.receive(json("t" to "log", "level" to "info", "message" to "line $it")) }
        desktop.awaitCount("log", WebViewReceiver.BURST) { (it["message"] as String).startsWith("line ") }
        val warning = desktop.await("log") { (it["message"] as String).startsWith("Dürbün dropped") }
        assertEquals("warn", warning["level"])
        assertEquals("Dürbün dropped 1 message(s) from a web view: the page sent too many, or too large ones.", warning["message"])
        Thread.sleep(150)
        assertEquals(WebViewReceiver.BURST, desktop.messages("log").count { (it["message"] as String).startsWith("line ") })
        // Later drops are summed into the next report, at most one per interval.
        assertEquals(1, desktop.messages("log").count { (it["message"] as String).startsWith("Dürbün dropped") })
        clock += WebViewReceiver.DROP_REPORT_INTERVAL_MS
        r.receive(json("t" to "dropped", "count" to 7))
        desktop.await("log") { it["message"] == "Dürbün dropped 106 message(s) from a web view: the page sent too many, or too large ones." }
    }

    @Test
    fun boundsRequestsInFlight() {
        val r = receiver()
        clock += 60_000
        repeat(WebViewReceiver.MAX_PENDING + 1) { r.receive(request(id = "id-$it")) }
        desktop.awaitCount("net.request", WebViewReceiver.MAX_PENDING + 1)
        r.receive(json("t" to "res", "id" to "id-0", "status" to 200)) // evicted: the oldest
        r.receive(json("t" to "res", "id" to "id-${WebViewReceiver.MAX_PENDING}", "status" to 200))
        val res = desktop.await("net.response")
        Thread.sleep(100)
        assertEquals(1, desktop.messages("net.response").size)
        val last = desktop.messages("net.request").last()
        assertEquals(last["id"], res["id"])
    }

    @Test
    fun nothingHappensWithoutARunningCore() {
        val r = WebViewReceiver({ null })
        r.receive(request()) // no core: dropped quietly
        // The JVM's android.jar stub of WebView: attach must not touch it while Dürbün is not running.
        val stub = WebView::class.java.getConstructor(android.content.Context::class.java).newInstance(null)
        assertFalse(DurbunWebView.attach(stub))
        DurbunWebView.onPageStarted(stub)
    }

    @Test
    fun usesAndroidxWebkitForDocumentStartScriptsWhenPresent() {
        DocumentStartScripts.featureClass = FakeWebViewFeature::class.java.name
        DocumentStartScripts.compatClass = FakeWebViewCompat::class.java.name
        val view = Any()
        FakeWebViewFeature.supported = true
        assertTrue(DocumentStartScripts.add(view, WebViewBridgeScript.SOURCE))
        assertEquals(Triple(view, WebViewBridgeScript.SOURCE, setOf("*")), FakeWebViewCompat.added)

        FakeWebViewCompat.added = null
        FakeWebViewFeature.supported = false
        assertFalse(DocumentStartScripts.add(view, "x"))
        assertNull(FakeWebViewCompat.added)

        DocumentStartScripts.featureClass = "androidx.webkit.Missing"
        assertFalse(DocumentStartScripts.add(view, "x"))
    }

    @Test
    fun theEmbeddedScriptIsTheBundledBridge() {
        val script = WebViewBridgeScript.SOURCE
        assertTrue(script.startsWith("\"use strict\";(()=>{"))
        assertTrue(script.contains("__durbun"))
        assertTrue(script.contains("messageHandlers"))
        assertTrue(script.length < 32 * 1024)
    }
}

/** Stand-ins for androidx.webkit's static API (looked up by name). */
object FakeWebViewFeature {
    @Volatile
    var supported = false

    @JvmStatic
    fun isFeatureSupported(feature: String): Boolean = supported && feature == "DOCUMENT_START_SCRIPT"
}

object FakeWebViewCompat {
    @Volatile
    var added: Triple<Any, String, Set<String>>? = null

    @JvmStatic
    fun addDocumentStartJavaScript(webView: Any, script: String, rules: Set<String>): Any {
        added = Triple(webView, script, rules)
        return Any()
    }
}
