package dev.durbun

import dev.durbun.internal.DurbunCore
import dev.durbun.internal.HostLink
import dev.durbun.internal.HostState
import dev.durbun.internal.Json
import dev.durbun.internal.LogcatController
import dev.durbun.internal.PendingCrashStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.util.Collections
import java.util.concurrent.CopyOnWriteArrayList

/**
 * Hosted mode (the core inside the Flutter plugin): no socket of its own, messages go to the host, desktop
 * state comes from the host, crashes go straight to the desktop with the host's hello (or to the next launch).
 */
class HostedModeTest {
    private val cores = ArrayList<DurbunCore>()
    private val desktops = ArrayList<FakeDesktop>()

    private class RecordingLink : HostLink {
        val lines: MutableList<String> = CopyOnWriteArrayList()
        val batches: MutableList<Int> = Collections.synchronizedList(ArrayList())
        val actions: MutableList<String> = CopyOnWriteArrayList()
        val deviceLogs: MutableList<String> = CopyOnWriteArrayList()

        override fun deliver(lines: List<String>) {
            batches += lines.size
            this.lines += lines
        }

        override fun deliverDeviceLogs(lines: List<String>) {
            deviceLogs += lines
        }

        fun deviceLogMessages(): List<String?> =
            deviceLogs.mapNotNull { Json.parseObject(it) }.map { it["message"] as String? }

        override fun actionsChanged(descriptorsJson: String) {
            actions += descriptorsJson
        }

        fun messages(type: String): List<Map<String, Any?>> =
            lines.mapNotNull { Json.parseObject(it) }.filter { it["type"] == type }
    }

    private fun hosted(
        link: HostLink,
        options: DurbunOptions = DurbunOptions(captureMetrics = false),
        env: FakeEnvironment = FakeEnvironment(),
        configure: (DurbunCore) -> Unit = {},
    ): DurbunCore {
        val core = DurbunCore(options, env, FAST_TIMING, host = link)
        configure(core)
        core.start()
        cores += core
        return core
    }

    private fun waitUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (!condition()) {
            if (System.currentTimeMillis() > deadline) throw AssertionError("condition not met in $timeoutMs ms")
            Thread.sleep(10)
        }
    }

    @After
    fun tearDown() {
        cores.forEach { it.stop() }
        desktops.forEach { it.close() }
    }

    @Test
    fun logsAndEventsGoToTheHostInBatches() {
        val link = RecordingLink()
        val core = hosted(link)
        assertTrue(core.isHosted)
        repeat(300) { core.log(Level.INFO, "auth", "line $it", null, null) }
        core.event("purchase", mapOf("amount" to 49.9))
        waitUntil { link.lines.size == 301 }
        val logs = link.messages("log")
        assertEquals("line 0", logs.first()["message"])
        assertEquals("auth", logs.first()["tag"])
        assertEquals("purchase", link.messages("event").single()["name"])
        // 301 lines in a few batches (≤ 256 lines each), never one call per line.
        assertTrue("batches: ${link.batches}", link.batches.size in 2..60)
        assertTrue(link.batches.all { it <= 256 })
    }

    @Test
    fun hostStateDrivesConnectionConfigAndMocks() {
        val link = RecordingLink()
        val core = hosted(link)
        assertFalse(core.isConnected)
        core.applyHostState(
            Json.encode(
                linkedMapOf(
                    "connected" to true,
                    "via" to "tcp 127.0.0.1:9751",
                    "appId" to "app:7",
                    "config" to linkedMapOf("captureBodies" to false, "maxBodyBytes" to 2048),
                    "mocks" to listOf(
                        linkedMapOf(
                            "id" to "m1",
                            "enabled" to true,
                            "method" to "GET",
                            "url" to "/todos/",
                            "match" to "contains",
                            "action" to linkedMapOf("type" to "respond", "status" to 418, "delayMs" to 0),
                        ),
                    ),
                    "hello" to linkedMapOf("type" to "hello", "session" to "abc"),
                ),
            ),
        )
        assertTrue(core.isConnected)
        assertFalse(core.captureBodies)
        assertEquals(2048, core.maxBodyBytes)
        assertEquals("app:7", core.serverAppId)
        assertNotNull(core.findMock("GET", "https://example.com/todos/1"))
        assertNull(core.findMock("POST", "https://example.com/todos/1"))

        // Partial update: only `connected` changes. The config is kept; the mock rules end with the connection.
        core.applyHostState("""{"connected":false}""")
        assertFalse(core.isConnected)
        assertFalse(core.captureBodies)
        assertEquals(2048, core.maxBodyBytes)
        assertNull(core.findMock("GET", "https://example.com/todos/1"))
        assertTrue(core.mockRules.isEmpty())

        // Rules never apply while the host is disconnected, and come back with the next connection.
        val rules = """[{"id":"m2","enabled":true,"method":"GET","url":"/todos/","match":"contains",""" +
            """"action":{"type":"respond","status":418,"delayMs":0}}]"""
        core.applyHostState("""{"mocks":$rules}""")
        assertNull(core.findMock("GET", "https://example.com/todos/1"))
        core.applyHostState("""{"connected":true,"mocks":$rules}""")
        assertEquals("m2", core.findMock("GET", "https://example.com/todos/1")?.id)
    }

    @Test
    fun captureNetworkOffLeavesNetworkAndMocksOut() {
        val core = hosted(RecordingLink(), DurbunOptions(captureMetrics = false, captureNetwork = false))
        assertEquals(listOf("logs", "events", "commands", "crash"), core.hostedCapabilities())
        core.applyHostState(
            """{"connected":true,"mocks":[{"id":"m1","enabled":true,"method":"*","url":"/","match":"contains",""" +
                """"action":{"type":"respond","status":418,"delayMs":0}}]}""",
        )
        assertNull(core.findMock("GET", "https://example.com/todos/1"))
    }

    @Test
    fun actionsAreHandedToTheHostAndCommandsAnswerThroughIt() {
        val link = RecordingLink()
        val core = hosted(link)
        val clicks = java.util.concurrent.atomic.AtomicInteger()
        core.addAction(DurbunAction.button(id = "app.clear", label = "Clear cache") { clicks.incrementAndGet() })
        waitUntil { link.actions.isNotEmpty() }
        val descriptors = Json.parse(link.actions.last()) as List<*>
        val ids = descriptors.map { (it as Map<*, *>)["id"] }
        assertEquals(listOf("android.dumpThreads", "android.gc", "app.clear"), ids)
        assertEquals(listOf("android.dumpThreads", "android.gc"), core.hostedCommands())
        assertTrue("crash" in core.hostedCapabilities())
        assertFalse("metrics" in core.hostedCapabilities())

        core.handleHostCommand("""{"type":"command","id":"c1","name":"app.clear","params":{}}""")
        core.handleHostCommand("""{"type":"command","id":"c2","name":"nope","params":{}}""")
        waitUntil { link.messages("command.result").size == 2 }
        val results = link.messages("command.result").associateBy { it["id"] }
        assertEquals(true, results["c1"]?.get("ok"))
        assertEquals(1, clicks.get())
        assertEquals(false, results["c2"]?.get("ok"))
        // No `actions` message of its own: the host publishes the merged list.
        assertTrue(link.messages("actions").isEmpty())
    }

    @Test
    fun flutterTaggedLogcatLinesAreLeftToDart() {
        val link = RecordingLink()
        val core = hosted(link)
        core.forwardLogcat(1_000L, Level.INFO, "flutter", "print from Dart", 1)
        core.forwardLogcat(1_001L, Level.WARN, "OkHttp", "native line", 2)
        waitUntil { link.deviceLogs.isNotEmpty() }
        Thread.sleep(100)
        assertEquals(listOf("native line"), link.deviceLogMessages())
    }

    @Test
    fun logcatLinesTravelApartFromOtherMessages() {
        val link = RecordingLink()
        val core = hosted(link)
        core.log(Level.INFO, "auth", "from Durbun.log", null, null)
        core.forwardLogcat(System.currentTimeMillis(), Level.WARN, "NETMERA", "push token refreshed", 7)
        waitUntil { link.deviceLogs.isNotEmpty() && link.lines.isNotEmpty() }
        Thread.sleep(100)
        // Dart routes `deviceLogs` itself (panel always, desktop only without device logs).
        assertEquals(listOf("push token refreshed"), link.deviceLogMessages())
        assertEquals(listOf("from Durbun.log"), link.messages("log").map { it["message"] })
        val line = Json.parseObject(link.deviceLogs.single())!!
        assertEquals("NETMERA", line["tag"])
        assertEquals("warn", line["level"])
        assertEquals(7L, line["tid"])
    }

    @Test
    fun hostDecidesWhenLogcatIsReadWithOrWithoutADesktop() {
        val link = RecordingLink()
        val switches = Collections.synchronizedList(ArrayList<Boolean>())
        val core = hosted(link) {
            it.logcat = object : LogcatController {
                override fun setEnabled(enabled: Boolean) {
                    switches += enabled
                }

                override fun stop() = Unit
            }
        }
        // No desktop at all: the in-app panel still wants the app's logcat.
        core.applyHostState("""{"connected":false,"deviceLogs":{"read":true,"desktop":false}}""")
        assertEquals(listOf(true), switches)
        // A desktop over USB reads logcat itself: the panel keeps reading, nothing is announced.
        core.applyHostState("""{"connected":true,"config":{"deviceLogsAvailable":true},"deviceLogs":{"read":true,"desktop":false}}""")
        assertEquals(true, switches.last())
        Thread.sleep(100)
        assertTrue(link.messages("log").none { (it["message"] as String).startsWith("The desktop cannot read") })
        // Wi-Fi without adb: Dart sends the lines on, and the desktop is told why it gets them.
        core.applyHostState("""{"connected":true,"config":{"deviceLogsAvailable":false},"deviceLogs":{"desktop":true}}""")
        waitUntil { link.messages("log").any { (it["message"] as String).startsWith("The desktop cannot read") } }
        // Panel off and no desktop need: stop reading.
        core.applyHostState("""{"connected":false,"deviceLogs":{"read":false,"desktop":false}}""")
        assertEquals(false, switches.last())
    }

    @Test
    fun captureLogcatOffNeverReads() {
        val switches = Collections.synchronizedList(ArrayList<Boolean>())
        val core = hosted(RecordingLink(), DurbunOptions(captureMetrics = false, captureLogcat = false)) {
            it.logcat = object : LogcatController {
                override fun setEnabled(enabled: Boolean) {
                    switches += enabled
                }

                override fun stop() = Unit
            }
        }
        core.applyHostState("""{"connected":true,"deviceLogs":{"read":true,"desktop":true}}""")
        assertTrue(switches.none { it })
    }

    @Test
    fun parsesTheHostsVia() {
        val endpoint = HostState.parseVia("tcp 127.0.0.1:9751")
        assertEquals("127.0.0.1", endpoint?.host)
        assertEquals(9751, endpoint?.port)
        assertEquals("192.168.1.20", HostState.parseVia("tcp 192.168.1.20:9760")?.host)
        assertEquals("::1", HostState.parseVia("tcp [::1]:9751")?.host)
        assertNull(HostState.parseVia("usbmux 127.0.0.1:9752"))
        assertNull(HostState.parseVia("tcp nonsense"))
        assertNull(HostState.parseVia(null))
    }

    @Test
    fun crashGoesStraightToTheDesktopWithTheHostsHello() {
        val desktop = FakeDesktop().also { desktops += it }
        val dir = Files.createTempDirectory("durbun-hosted").toFile()
        val store = PendingCrashStore(dir)
        val link = RecordingLink()
        val core = hosted(link) { it.crashStore = store }
        val hello = linkedMapOf(
            "type" to "hello",
            "protocol" to 1,
            "sdk" to linkedMapOf("name" to "durbun-flutter", "version" to "0.1.0", "platform" to "flutter"),
            "app" to linkedMapOf("name" to "Pati", "id" to "com.mykynk.pati", "pid" to 4321),
            "device" to linkedMapOf("platform" to "android"),
            "session" to "dart-session-1",
            "capabilities" to listOf("logs", "crash"),
            "actions" to emptyList<Any?>(),
        )
        core.applyHostState(
            Json.encode(linkedMapOf("connected" to true, "via" to "tcp 127.0.0.1:${desktop.port}", "hello" to hello)),
        )
        core.reportCrash(Thread.currentThread(), IllegalStateException("boom"))

        val received = desktop.await("hello")
        assertEquals("dart-session-1", received["session"])
        assertEquals("durbun-flutter", received.objAt("sdk")["name"])
        val crash = desktop.await("log") { it["kind"] == "crash" }
        assertTrue((crash["message"] as String).contains("java.lang.IllegalStateException: boom"))
        assertTrue(store.drain().isEmpty())
        dir.deleteRecursively()
    }

    @Test
    fun undeliverableCrashIsSentOnTheNextLaunch() {
        val dir = Files.createTempDirectory("durbun-hosted").toFile()
        val first = hosted(RecordingLink()) { it.crashStore = PendingCrashStore(dir) }
        // Connected, but the desktop is gone (nothing listens on port 1).
        first.applyHostState("""{"connected":true,"via":"tcp 127.0.0.1:1","hello":{"type":"hello"}}""")
        first.reportCrash(Thread.currentThread(), RuntimeException("lost"))
        first.stop()

        val link = RecordingLink()
        hosted(link) { it.crashStore = PendingCrashStore(dir) }
        waitUntil { link.messages("log").isNotEmpty() }
        val previous = link.messages("log").single()
        assertTrue((previous["message"] as String).startsWith("Previous launch crashed — "))
        assertEquals(true, previous.objAt("data")["previousLaunch"])
        dir.deleteRecursively()
    }

    @Test
    fun durbunFacadeReportsThroughTheHostedCore() {
        val link = RecordingLink()
        val core = hosted(link)
        Durbun.attachHosted(core)
        try {
            assertTrue(Durbun.isStarted)
            Durbun.i("native", "from Kotlin", data = mapOf("k" to 1))
            waitUntil { link.messages("log").isNotEmpty() }
            assertEquals("from Kotlin", link.messages("log").single()["message"])
        } finally {
            Durbun.installForTesting(null)
        }
        assertFalse(Durbun.isStarted)
    }
}
