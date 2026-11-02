package dev.durbun

import dev.durbun.internal.CrashHandler
import dev.durbun.internal.DurbunCore
import dev.durbun.internal.LogcatController
import dev.durbun.internal.MetricsSampler
import dev.durbun.internal.PendingCrashStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.Collections

/** End-to-end tests of the SDK core + NDJSON transport against a fake desktop on a local socket. */
class CoreTransportTest {
    private val desktops = ArrayList<FakeDesktop>()
    private val cores = ArrayList<DurbunCore>()

    private fun desktop(configure: FakeDesktop.() -> Unit = {}) = FakeDesktop().also {
        it.configure()
        desktops += it
    }

    private fun core(
        desktop: FakeDesktop,
        options: DurbunOptions = DurbunOptions(),
        env: FakeEnvironment = FakeEnvironment(),
        configure: (DurbunCore) -> Unit = {},
    ) = startCore(desktop, options, env, configure).also { cores += it }

    @After
    fun tearDown() {
        cores.forEach { it.stop() }
        desktops.forEach { it.close() }
    }

    private fun waitUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition()) {
            if (System.currentTimeMillis() > deadline) throw AssertionError("condition not met in $timeoutMs ms")
            Thread.sleep(10)
        }
    }

    @Test
    fun helloDescribesAppDeviceAndCapabilities() {
        val desktop = desktop()
        val core = core(desktop)
        val hello = desktop.await("hello")
        assertEquals(1L, hello["protocol"])
        assertEquals(mapOf("name" to "durbun-android", "version" to Durbun.VERSION, "platform" to "android"), hello["sdk"])
        val app = hello.objAt("app")
        assertEquals("com.mykynk.pati", app["id"])
        assertEquals("Pati", app["name"])
        assertEquals(4321L, app["pid"])
        assertEquals(true, app["debug"])
        val device = hello.objAt("device")
        assertEquals("android", device["platform"])
        assertEquals("Pixel 8", device["model"])
        assertEquals(35L, device["apiLevel"])
        assertEquals(core.sessionId, hello["session"])
        val caps = hello.listAt("capabilities")
        assertTrue(caps.containsAll(listOf("logs", "network", "mocks", "events", "commands", "crash")))
        assertFalse("no metrics sampler configured", caps.contains("metrics"))
        val actionIds = hello.listAt("actions").map { (it as Map<*, *>)["id"] }
        assertTrue(actionIds.contains("android.dumpThreads"))
        assertTrue(actionIds.contains("android.gc"))
        waitUntil { core.isConnected }
    }

    @Test
    fun logsAndEventsReachTheDesktopInOrder() {
        val desktop = desktop()
        val core = core(desktop)
        core.log(Level.INFO, "auth", "Kullanıcı giriş yaptı", mapOf("userId" to 42, "plan" to "premium"), null)
        core.log(Level.ERROR, "payment", "Ödeme başarısız", null, IllegalStateException("Kart reddedildi"))
        core.log(Level.WARN, "legacy", "throwable passed as data", RuntimeException("as data"), null)
        core.event("purchase", mapOf("amount" to 49.9, "currency" to "TRY"))

        val info = desktop.await("log") { it["tag"] == "auth" }
        assertEquals("info", info["level"])
        assertEquals("Kullanıcı giriş yaptı", info["message"])
        assertEquals(mapOf("userId" to 42L, "plan" to "premium"), info["data"])
        assertEquals("text", info["kind"])
        assertEquals(4377L, info["tid"])

        val error = desktop.await("log") { it["tag"] == "payment" }.objAt("error")
        assertEquals("java.lang.IllegalStateException", error["type"])
        assertEquals("Kart reddedildi", error["message"])
        assertTrue((error["stack"] as String).contains("\tat dev.durbun.CoreTransportTest"))

        val promoted = desktop.await("log") { it["tag"] == "legacy" }
        assertEquals(null, promoted["data"])
        assertEquals("java.lang.RuntimeException", promoted.objAt("error")["type"])

        val event = desktop.await("event")
        assertEquals("purchase", event["name"])
        assertEquals(mapOf("amount" to 49.9, "currency" to "TRY"), event["props"])

        val order = desktop.messages().map { it["type"] }.filter { it == "log" || it == "event" }
        assertEquals(listOf("log", "log", "log", "event"), order)
    }

    @Test
    fun loggerAppendedStackTracesAreNotShownTwice() {
        val desktop = desktop()
        val core = core(desktop)
        val e = IllegalStateException("Kart reddedildi")
        val trace = java.io.StringWriter().also { e.printStackTrace(java.io.PrintWriter(it)) }.toString()
        core.log(Level.ERROR, "Timber", "Ödeme başarısız\n$trace", null, e) // Timber.e(e, "Ödeme başarısız")
        core.log(Level.ERROR, "Timber", trace, null, e) // Timber.e(e)
        core.log(Level.ERROR, "plain", "Ödeme başarısız\nikinci satır", null, e)
        val logs = desktop.awaitCount("log", 3)
        assertEquals("Ödeme başarısız", logs[0]["message"])
        assertEquals("java.lang.IllegalStateException: Kart reddedildi", logs[1]["message"])
        assertEquals("Ödeme başarısız\nikinci satır", logs[2]["message"])
        logs.forEach { assertTrue((it.objAt("error")["stack"] as String).contains("\tat dev.durbun.CoreTransportTest")) }
    }

    @Test
    fun answersPingAndRejectsUnknownCommands() {
        val desktop = desktop()
        val core = core(desktop)
        desktop.await("hello")
        waitUntil { core.isConnected }
        desktop.send(mapOf("type" to "ping", "ts" to 1))
        assertNotNull(desktop.await("pong")["ts"])
        desktop.send(mapOf("type" to "command", "id" to "c1", "name" to "flutter.debugPaint", "params" to mapOf("enabled" to true)))
        val result = desktop.await("command.result") { it["id"] == "c1" }
        assertEquals(false, result["ok"])
        assertEquals("Unknown command: flutter.debugPaint", result["error"])
    }

    @Test
    fun reconnectsAfterTheDesktopDropsTheConnection() {
        val desktop = desktop()
        val core = core(desktop)
        desktop.await("hello")
        waitUntil { core.isConnected }
        desktop.dropClient()
        // TCP gives no delivery receipts: wait for the new connection before logging.
        waitUntil { desktop.connections.get() >= 2 && core.isConnected }
        core.log(Level.INFO, "net", "after reconnect", null, null)
        desktop.await("log") { it["message"] == "after reconnect" }
        assertTrue(desktop.messages("hello").size >= 2)
        assertEquals("same session after reconnect", 1, desktop.messages("hello").map { it["session"] }.toSet().size)
    }

    @Test
    fun buffersWhileOfflineDropsOldestAndSaysSo() {
        val desktop = desktop { acceptHandshakes = false }
        val core = core(desktop, DurbunOptions(maxBufferedMessages = 100))
        repeat(150) { core.log(Level.DEBUG, "loop", "line $it", null, null) }
        desktop.await("hello") // the SDK keeps trying
        desktop.acceptHandshakes = true
        val logs = desktop.awaitCount("log", 101)
        val messages = logs.map { it["message"] as String }
        assertFalse(messages.contains("line 0"))
        assertTrue(messages.contains("line 50"))
        assertTrue(messages.contains("line 149"))
        val warning = logs.first { it["level"] == "warn" }
        assertEquals("durbun", warning["tag"])
        assertTrue(warning["message"] as String, (warning["message"] as String).contains("dropped 50 older messages"))
        assertEquals(mapOf("dropped" to 50L), warning["data"])
    }

    @Test
    fun appliesConfigAndMockRulesFromTheDesktop() {
        val desktop = desktop {
            config = linkedMapOf("captureBodies" to false, "maxBodyBytes" to 2048, "metricsIntervalMs" to 1000, "deviceLogsAvailable" to true)
            mocks = listOf(
                mapOf(
                    "id" to "m1", "enabled" to true, "method" to "GET", "url" to "/users", "match" to "contains",
                    "action" to mapOf("type" to "respond", "status" to 200), "createdAt" to 1,
                ),
            )
        }
        val core = core(desktop)
        waitUntil { core.mockRules.size == 1 }
        assertFalse(core.captureBodies)
        assertEquals(2048, core.maxBodyBytes)
        assertEquals("m1", core.findMock("GET", "https://api.example.com/users")?.id)
        assertEquals(null, core.findMock("POST", "https://api.example.com/users"))

        desktop.send(mapOf("type" to "mocks", "rules" to emptyList<Any>()))
        waitUntil { core.mockRules.isEmpty() }
        desktop.send(mapOf("type" to "config", "config" to mapOf("captureBodies" to true)))
        waitUntil { core.captureBodies }
        assertEquals("other fields keep their value", 2048, core.maxBodyBytes)
    }

    @Test
    fun appOptionsOverrideDesktopCaptureSettings() {
        val desktop = desktop()
        val core = core(desktop, DurbunOptions(captureBodies = false, maxBodyBytes = 512))
        waitUntil { core.isConnected }
        assertFalse(core.captureBodies)
        assertEquals(512, core.maxBodyBytes)
    }

    @Test
    fun customActionsRunOnTheMainThreadAndReportState() {
        val desktop = desktop()
        val env = FakeEnvironment()
        var staging = false
        val core = core(desktop, env = env) {
            it.addAction(DurbunAction.toggle("app.staging", "Use staging API", initial = false) { enabled -> staging = enabled })
            it.addAction(DurbunAction.button("app.crashy", "Throws") { throw IllegalStateException("Oturum bulunamadı") })
            it.addAction(
                DurbunAction.select(
                    "app.theme", "Theme",
                    listOf(DurbunAction.Option("light", "Light"), DurbunAction.Option("dark", "Dark")),
                    initial = "light",
                ) { },
            )
        }
        val hello = desktop.await("hello")
        val toggle = hello.listAt("actions").map { it as Map<*, *> }.first { it["id"] == "app.staging" }
        assertEquals(mapOf("id" to "app.staging", "kind" to "toggle", "label" to "Use staging API", "group" to "app", "value" to false), toggle)
        waitUntil { core.isConnected }

        desktop.send(mapOf("type" to "command", "id" to "t1", "name" to "app.staging", "params" to mapOf("value" to true)))
        val result = desktop.await("command.result") { it["id"] == "t1" }
        assertEquals(true, result["ok"])
        assertEquals(true, result["data"])
        assertTrue(staging)
        assertTrue(env.mainThreadTasks.get() >= 1)
        val update = desktop.await("actions")
        val updated = update.listAt("actions").map { it as Map<*, *> }.first { it["id"] == "app.staging" }
        assertEquals(true, updated["value"])

        desktop.send(mapOf("type" to "command", "id" to "t2", "name" to "app.crashy"))
        val failed = desktop.await("command.result") { it["id"] == "t2" }
        assertEquals(false, failed["ok"])
        assertEquals("Oturum bulunamadı", failed["error"])

        desktop.send(mapOf("type" to "command", "id" to "t3", "name" to "app.theme", "params" to mapOf("value" to "sepia")))
        assertEquals(false, desktop.await("command.result") { it["id"] == "t3" }["ok"])
        desktop.send(mapOf("type" to "command", "id" to "t4", "name" to "app.theme", "params" to mapOf("value" to "dark")))
        assertEquals("dark", desktop.await("command.result") { it["id"] == "t4" }["data"])

        core.removeAction("app.theme")
        desktop.await("actions") { msg -> msg.listAt("actions").none { (it as Map<*, *>)["id"] == "app.theme" } }
    }

    @Test
    fun builtInThreadDumpAndGcCommands() {
        val desktop = desktop()
        val core = core(desktop)
        waitUntil { core.isConnected }
        desktop.send(mapOf("type" to "command", "id" to "d1", "name" to "android.dumpThreads"))
        val dump = desktop.await("command.result") { it["id"] == "d1" }
        assertEquals(true, dump["ok"])
        assertTrue(((dump["data"] as Map<*, *>)["threads"] as Long) > 0)
        val dumpLog = desktop.await("log") { (it["message"] as String).startsWith("Thread dump · ") }
        assertTrue((dumpLog["message"] as String).contains("\tat "))

        desktop.send(mapOf("type" to "command", "id" to "g1", "name" to "android.gc"))
        val gc = desktop.await("command.result") { it["id"] == "g1" }
        assertEquals(true, gc["ok"])
        assertTrue((gc["data"] as Map<*, *>).containsKey("afterMB"))
    }

    @Test
    fun sendsMetricsOnlyWhileConnected() {
        val desktop = desktop {
            config = linkedMapOf("captureBodies" to true, "maxBodyBytes" to 1024, "metricsIntervalMs" to 250, "deviceLogsAvailable" to true)
        }
        val paused = Collections.synchronizedList(ArrayList<Boolean>())
        val core = core(desktop) {
            it.metricsSampler = object : MetricsSampler {
                override fun sample(): Map<String, Any?> =
                    mapOf("cpu" to 12.5, "memoryMB" to 182.4, "heapMB" to 41.0, "fps" to 59.8, "jankyFrames" to 2, "threads" to 37)

                override fun pause() {
                    paused += true
                }
            }
        }
        assertTrue(desktop.await("hello").listAt("capabilities").contains("metrics"))
        val metrics = desktop.awaitCount("metric", 2, timeoutMs = 4_000)
        val sample = metrics.first()
        assertEquals(12.5, sample["cpu"])
        assertEquals(59.8, sample["fps"])
        assertEquals(2L, sample["jankyFrames"])
        assertNotNull(sample["ts"])
        desktop.dropClient()
        waitUntil { paused.isNotEmpty() }
        core.stop()
    }

    @Test
    fun forwardsOwnLogcatOnlyWhenTheDesktopHasNoDeviceLogs() {
        val desktop = desktop {
            config = linkedMapOf("captureBodies" to true, "maxBodyBytes" to 1024, "metricsIntervalMs" to 1000, "deviceLogsAvailable" to false)
        }
        val switches = Collections.synchronizedList(ArrayList<Boolean>())
        val core = core(desktop) {
            it.logcat = object : LogcatController {
                override fun setEnabled(enabled: Boolean) {
                    switches += enabled
                }

                override fun stop() = Unit
            }
        }
        waitUntil { switches.contains(true) }
        desktop.await("log") { (it["message"] as String).startsWith("The desktop cannot read this device's logs") }

        val ts = System.currentTimeMillis()
        core.forwardLogcat(ts, Level.WARN, "OkHttp", "<-- HTTP FAILED: java.net.SocketTimeoutException", 4380)
        val forwarded = desktop.await("log") { it["tag"] == "OkHttp" }
        assertEquals(ts, forwarded["ts"])
        assertEquals("warn", forwarded["level"])
        assertEquals(4380L, forwarded["tid"])

        // The same line logged through the SDK and then seen in logcat (e.g. Timber with two trees) is sent once.
        core.log(Level.INFO, "Timber", "Sepete eklendi: 3 ürün", null, null)
        core.forwardLogcat(System.currentTimeMillis(), Level.INFO, "CartViewModel", "Sepete eklendi: 3 ürün", 1)
        core.log(Level.INFO, "marker", "after", null, null)
        desktop.await("log") { it["message"] == "after" }
        assertEquals(1, desktop.messages("log").count { it["message"] == "Sepete eklendi: 3 ürün" })

        desktop.send(mapOf("type" to "config", "config" to mapOf("deviceLogsAvailable" to true)))
        waitUntil { switches.last() == false }
    }

    @Test
    fun crashIsDeliveredOrKeptForTheNextLaunch() {
        val storage = Files.createTempDirectory("durbun-crash").toFile()
        try {
            // Connected: delivered right away.
            val desktop = desktop()
            val live = core(desktop) { it.crashStore = PendingCrashStore(storage) }
            waitUntil { live.isConnected }
            live.reportCrash(Thread.currentThread(), IllegalStateException("Ödeme sağlayıcısı hazır değil"))
            val crash = desktop.await("log") { it["kind"] == "crash" }
            assertEquals("fatal", crash["level"])
            assertEquals("crash", crash["tag"])
            val expectedPrefix = "FATAL EXCEPTION in thread \"${Thread.currentThread().name}\": java.lang.IllegalStateException"
            assertTrue(crash["message"] as String, (crash["message"] as String).startsWith(expectedPrefix))
            assertEquals("java.lang.IllegalStateException", crash.objAt("error")["type"])
            assertFalse(File(storage, "pending-crashes.ndjson").exists())

            // Desktop unreachable: stored on disk…
            val offline = desktop { acceptHandshakes = false }
            val dying = core(offline) { it.crashStore = PendingCrashStore(storage) }
            dying.reportCrash(Thread.currentThread(), NullPointerException("user was null"))
            assertTrue(File(storage, "pending-crashes.ndjson").exists())
            dying.stop()

            // …and sent by the next launch.
            val next = desktop()
            core(next) { it.crashStore = PendingCrashStore(storage) }
            val previous = next.await("log") { (it["message"] as String).startsWith("Previous launch crashed — ") }
            assertEquals("crash", previous["kind"])
            assertEquals(true, previous.objAt("data")["previousLaunch"])
            assertEquals("java.lang.NullPointerException", previous.objAt("error")["type"])
            assertFalse(File(storage, "pending-crashes.ndjson").exists())
        } finally {
            storage.deleteRecursively()
        }
    }

    @Test
    fun crashHandlerReportsThenChainsToThePreviousHandler() {
        val original = Thread.getDefaultUncaughtExceptionHandler()
        val seen = Collections.synchronizedList(ArrayList<Throwable>())
        val previous = Thread.UncaughtExceptionHandler { _, e -> seen += e }
        Thread.setDefaultUncaughtExceptionHandler(previous)
        val desktop = desktop()
        val core = core(desktop)
        try {
            waitUntil { core.isConnected }
            CrashHandler.install(core)
            val handler = Thread.getDefaultUncaughtExceptionHandler()
            val boom = IllegalArgumentException("boom")
            handler!!.uncaughtException(Thread.currentThread(), boom)
            assertEquals(listOf<Throwable>(boom), seen.toList())
            desktop.await("log") { it["kind"] == "crash" }
            CrashHandler.uninstall(core)
            assertSame(previous, Thread.getDefaultUncaughtExceptionHandler())
        } finally {
            Thread.setDefaultUncaughtExceptionHandler(original)
        }
    }

    @Test
    fun stopIsIdempotentAndSilencesTheCore() {
        val desktop = desktop()
        val core = core(desktop)
        waitUntil { core.isConnected }
        core.stop()
        core.stop()
        core.log(Level.INFO, "after", "stop", null, null)
        Thread.sleep(100)
        assertTrue(desktop.messages("log").none { it["tag"] == "after" })
        assertFalse(core.isConnected)
    }
}
