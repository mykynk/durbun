package dev.durbun

import dev.durbun.internal.AnrTraces
import dev.durbun.internal.AttemptKind
import dev.durbun.internal.ConnectAttempt
import dev.durbun.internal.ConnectIssue
import dev.durbun.internal.ConnectionDiagnosis
import dev.durbun.internal.DesktopAddress
import dev.durbun.internal.DesktopHostStore
import dev.durbun.internal.DurbunCore
import dev.durbun.internal.ExitReasonSource
import dev.durbun.internal.ExitRecord
import dev.durbun.internal.ExitReports
import dev.durbun.internal.Json
import dev.durbun.internal.SettingsWriter
import dev.durbun.internal.android.LaunchHostWatcher
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.ServerSocket
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.nio.file.Files

/** Connection diagnosis (same table as the other SDKs), the run-time desktop address, and earlier-exit reports. */
class ConnectionReportTest {
    private val desktops = ArrayList<FakeDesktop>()
    private val cores = ArrayList<DurbunCore>()

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

    private fun diagnose(attempts: List<ConnectAttempt>, platform: String = "android", physical: Boolean = true, lan: String? = null) =
        ConnectionDiagnosis.diagnose(attempts, platform, physical, lan)

    /** A local port with nothing listening on it. */
    private fun deadPort(): Int = ServerSocket(0).use { it.localPort }

    @Test
    fun classifySortsSocketErrors() {
        assertEquals(AttemptKind.REFUSED, AttemptKind.classify(ConnectException("failed to connect to /127.0.0.1 (port 9751) after 1000ms: isConnected failed: ECONNREFUSED (Connection refused)")))
        assertEquals(AttemptKind.TIMEOUT, AttemptKind.classify(SocketTimeoutException("failed to connect to /192.168.1.20 (port 9751) after 2500ms")))
        assertEquals(AttemptKind.UNREACHABLE, AttemptKind.classify(NoRouteToHostException("Host unreachable")))
        assertEquals(AttemptKind.UNREACHABLE, AttemptKind.classify(ConnectException("failed to connect: connect failed: ENETUNREACH (Network is unreachable)")))
        assertEquals(AttemptKind.DENIED, AttemptKind.classify(SocketException("socket failed: EACCES (Permission denied)")))
        assertEquals(AttemptKind.DENIED, AttemptKind.classify(SocketException("connect failed: EPERM (Operation not permitted)")))
        assertEquals(AttemptKind.LOOKUP, AttemptKind.classify(UnknownHostException("Unable to resolve host \"my-mac\"")))
        assertEquals(AttemptKind.ERROR, AttemptKind.classify(IllegalStateException("odd")))
    }

    @Test
    fun diagnosisMatchesTheOtherSdks() {
        val loop = { kind: String -> ConnectAttempt("127.0.0.1:9751", kind) }
        assertEquals(ConnectIssue.usbNotSetUp, diagnose(listOf(loop("refused"))))
        assertEquals(ConnectIssue.usbDesktopClosed, diagnose(listOf(loop("closed"))))
        assertEquals(ConnectIssue.iosUsbWaiting, diagnose(listOf(loop("refused")), platform = "ios"))
        assertEquals(ConnectIssue.desktopNotRunning, diagnose(listOf(loop("refused")), platform = "ios", physical = false))
        assertEquals(ConnectIssue.desktopNotRunning, diagnose(listOf(loop("refused")), platform = "other"))
        assertEquals(ConnectIssue.notDurbun, diagnose(listOf(loop("no-welcome")), platform = "other"))
        assertEquals(ConnectIssue.usbDesktopClosed, diagnose(listOf(loop("closed")), physical = false))
        val lan = "192.168.1.20:9751"
        val withLan = { kind: String -> listOf(loop("refused"), ConnectAttempt(lan, kind)) }
        assertEquals(ConnectIssue.lanRefused, diagnose(withLan("refused"), lan = lan))
        assertEquals(ConnectIssue.lanTimeout, diagnose(withLan("timeout"), lan = lan))
        assertEquals(ConnectIssue.lanUnreachable, diagnose(withLan("unreachable"), lan = lan))
        assertEquals(ConnectIssue.lanBadAddress, diagnose(withLan("lookup"), lan = lan))
        assertEquals(ConnectIssue.notDurbun, diagnose(withLan("no-welcome"), lan = lan))
        assertEquals(ConnectIssue.other, diagnose(withLan("error"), lan = lan))
        assertEquals(ConnectIssue.permissionDenied, diagnose(listOf(loop("denied"))))
    }

    @Test
    fun consoleHintNamesTheNextStepAndWhatWasTried() {
        val attempts = listOf(ConnectAttempt("127.0.0.1:9751", "refused"), ConnectAttempt("192.168.1.20:9751", "refused"))
        val text = ConnectionDiagnosis.consoleHint(ConnectIssue.lanRefused, attempts, 9751, "192.168.1.20:9751")
        assertTrue(text.startsWith("Dürbün: not connected"))
        assertTrue(text.contains("Allow local network"))
        assertTrue(text.contains("192.168.1.20:9751 refused"))
        assertTrue(ConnectionDiagnosis.nextStep(ConnectIssue.usbNotSetUp, 9751, null).contains("Durbun.setDesktopHost"))
        for (issue in ConnectIssue.values()) assertTrue(ConnectionDiagnosis.nextStep(issue, 9751, "x:1").isNotEmpty())
    }

    @Test
    fun desktopAddressTakesWhatAPersonTypes() {
        val ok = { input: String -> DesktopAddress.parse(input)?.toString() }
        assertEquals("192.168.1.20", ok("192.168.1.20"))
        assertEquals("192.168.1.20:9751", ok("  192.168.1.20:9751 "))
        assertEquals("192.168.1.20:9751", ok("http://192.168.1.20:9751/"))
        assertEquals("my-mac.local", ok("my-mac.local"))
        assertEquals("[fe80::1]:9751", ok("[fe80::1]:9751"))
        assertEquals("fe80::1", ok("[fe80::1]"))
        assertEquals("fe80::1", ok("fe80::1"))
        for (bad in listOf("", "   ", "192.168.1", "192.168.1.300", "1.2.3.99999999999", "my mac", "mac/path", "-mac",
            "192.168.1.20:0", "192.168.1.20:70000", "192.168.1.20:abc", "192.168.1.20:")) {
            assertNull(bad, DesktopAddress.parse(bad))
        }
    }

    @Test
    fun statusExplainsAFailedRoundAndLogcatGetsOneHint() {
        val env = FakeEnvironment()
        val core = DurbunCore(DurbunOptions(port = deadPort()), env, FAST_TIMING).also { cores += it }
        core.consoleHintAfterMs = 0
        core.start()
        waitUntil { core.connectionStatus().issue != null }
        val status = core.connectionStatus()
        assertFalse(status.isConnected)
        assertEquals("usbNotSetUp", status.issue)
        assertTrue(status.hint!!.contains("adb reverse"))
        assertTrue(status.failedAttempts >= 1)
        waitUntil { core.connectionStatus().failedAttempts >= 3 }
        val logger = env.logger as RecordingLogger
        val hints = logger.lines.filter { it.contains("not connected to the desktop") }
        assertEquals("one console hint per launch", 1, hints.size)
        assertTrue(hints[0].contains("refused"))
    }

    @Test
    fun aRunTimeAddressConnectsAtOnceAndIsKeptForTheNextLaunch() {
        val desktop = FakeDesktop().also { desktops += it }
        val dir = Files.createTempDirectory("durbun-host").toFile()
        val env = FakeEnvironment(storageDir = dir)
        val options = DurbunOptions(port = deadPort())
        val core = DurbunCore(options, env, FAST_TIMING).also { cores += it }
        core.hostStore = DesktopHostStore { env.settingsDir }
        val changes = java.util.concurrent.atomic.AtomicInteger()
        core.onStatusChanged = { changes.incrementAndGet() }
        core.start()
        waitUntil { core.connectionStatus().failedAttempts >= 1 }

        core.setDesktopHost(DesktopAddress.parse("127.0.0.1:${desktop.port}"))
        waitUntil { core.isConnected }
        val status = core.connectionStatus()
        assertEquals("127.0.0.1:${desktop.port}", status.via)
        assertEquals("127.0.0.1:${desktop.port}", status.desktopHost)
        assertEquals("runtime", status.desktopHostSource)
        assertNull(status.issue)
        assertTrue(changes.get() >= 2)
        SettingsWriter.awaitIdle()
        assertEquals("127.0.0.1:${desktop.port}", File(dir, DesktopHostStore.FILE_NAME).readText())
        core.stop()

        // Next launch: the saved address wins over the build's.
        val next = DurbunCore(options.copy(host = "10.9.9.9"), env, FAST_TIMING).also { cores += it }
        next.hostStore = DesktopHostStore { env.settingsDir }
        next.start()
        waitUntil { next.isConnected }
        assertEquals("runtime", next.connectionStatus().desktopHostSource)

        // Clearing goes back to the build's address and closes the Wi-Fi link.
        next.setDesktopHost(null)
        waitUntil { !next.isConnected }
        assertEquals("options", next.connectionStatus().desktopHostSource)
        assertEquals("10.9.9.9:${options.port}", next.connectionStatus().desktopHost)
        SettingsWriter.awaitIdle()
        assertFalse(File(dir, DesktopHostStore.FILE_NAME).exists())
    }

    @Test
    fun manifestAddressIsUsedWhenNothingElseIsSet() {
        val desktop = FakeDesktop().also { desktops += it }
        val core = DurbunCore(DurbunOptions(port = deadPort()), FakeEnvironment(), FAST_TIMING).also { cores += it }
        core.configuredHost = { "127.0.0.1:${desktop.port}" }
        core.start()
        waitUntil { core.isConnected }
        assertEquals("manifest", core.connectionStatus().desktopHostSource)
    }

    private val anrDump = """
        ----- pid 4321 at 2026-11-15 10:00:00.000 -----
        Cmd line: com.mykynk.pati

        "main" prio=5 tid=1 Blocked
          | group="main" sCount=1 ucsCount=0 flags=1 obj=0x72d8 self=0xb400
          at com.mykynk.pati.Cache.read(Cache.kt:42)
          - waiting to lock <0x0a1b2c3d> (a java.lang.Object) held by thread 23
          at com.mykynk.pati.MainActivity.onCreate(MainActivity.kt:17)

        "Signal Catcher" prio=10 tid=2 Runnable
          at nothing.Here(Unknown Source)

        "pool-1-thread-1" prio=5 tid=23 Sleeping
          at java.lang.Thread.sleep(Native method)
          - locked <0x0a1b2c3d> (a java.lang.Object)
          at com.mykynk.pati.Cache.refresh(Cache.kt:88)
    """.trimIndent()

    private fun record(reason: Int, ts: Long = 1_700_000_000_000, importance: Int = 400, traces: String? = null, status: Int = 0) =
        ExitRecord(ts, reason, description = "user request after error", status = status, importance = importance,
            pssKb = 204_800, rssKb = 307_200, pid = 4000, processName = "com.mykynk.pati", traces = traces)

    @Test
    fun exitReportsDescribeWhatTheAppCannotSeeAndSkipTheRest() {
        val anr = Json.parseObject(ExitReports.report(record(ExitReports.ANR, traces = anrDump))!!.line)!!
        assertEquals("crash", anr["kind"])
        assertEquals("fatal", anr["level"])
        assertTrue((anr["message"] as String).contains("App Not Responding"))
        val stack = anr.objAt("error")["stack"] as String
        assertTrue(stack.startsWith("\"main\""))
        assertTrue("the lock holder follows", stack.contains("Cache.refresh"))
        assertFalse(stack.contains("Signal Catcher"))
        assertEquals("anr", anr.objAt("data")["exitReason"])
        assertTrue(ExitReports.report(record(ExitReports.ANR))!!.desktopReadsIt)

        val lowMemory = Json.parseObject(ExitReports.report(record(ExitReports.LOW_MEMORY))!!.line)!!
        assertEquals("info", lowMemory["level"])
        assertEquals("text", lowMemory["kind"])
        assertTrue((lowMemory["message"] as String).contains("in the background"))
        assertEquals(200L, lowMemory.objAt("data")["pssMB"])
        assertEquals("warn", Json.parseObject(ExitReports.report(record(ExitReports.LOW_MEMORY, importance = 100))!!.line)!!["level"])

        val native = Json.parseObject(ExitReports.report(record(ExitReports.CRASH_NATIVE, status = 11))!!.line)!!
        assertTrue((native["message"] as String).contains("SIGSEGV"))

        for (ignored in listOf(ExitReports.EXIT_SELF, ExitReports.CRASH, 10, 11, 16, 13)) {
            assertNull(ExitReports.report(record(ignored)))
        }
        assertNull(AnrTraces.mainThreadAndBlockers("no threads here"))
    }

    @Test
    fun exitReportsGoOutOnceConnectedAndLeaveDesktopReadRecordsOut() {
        val desktop = FakeDesktop().also { desktops += it } // deviceLogsAvailable = true: the desktop reads ANRs via adb
        var handled: Long? = null
        val source = object : ExitReasonSource {
            override fun newRecords() = listOf(record(ExitReports.ANR, ts = 1_000, traces = anrDump), record(ExitReports.LOW_MEMORY, ts = 2_000))
            override fun markHandled(timestampMs: Long) {
                handled = timestampMs
            }
        }
        val core = startCore(desktop) { it.exitReasons = source }.also { cores += it }
        val line = desktop.await("log") { it["tag"] == ExitReports.EXIT_TAG }
        assertEquals(2_000L, line["ts"])
        waitUntil { handled == 2_000L }
        Thread.sleep(100)
        assertTrue("the ANR is left to the desktop", desktop.messages("log").none { it["tag"] == DurbunCore.CRASH_TAG })
        assertNotNull(core)
    }

    @Test
    fun overWifiTheAnrIsSentToo() {
        val desktop = FakeDesktop(config = mapOf("deviceLogsAvailable" to false)).also { desktops += it }
        val source = object : ExitReasonSource {
            override fun newRecords() = listOf(record(ExitReports.ANR, ts = 1_000, traces = anrDump))
            override fun markHandled(timestampMs: Long) = Unit
        }
        startCore(desktop) { it.exitReasons = source }.also { cores += it }
        val anr = desktop.await("log") { it["tag"] == DurbunCore.CRASH_TAG }
        assertTrue((anr["message"] as String).startsWith("Previous launch ended: App Not Responding"))
    }

    private fun launchCore(dir: File, logger: RecordingLogger = RecordingLogger()): DurbunCore {
        val env = FakeEnvironment(storageDir = dir, logger = logger)
        return DurbunCore(DurbunOptions(port = deadPort()), env, FAST_TIMING).also {
            it.hostStore = DesktopHostStore { env.settingsDir }
            cores += it
        }
    }

    @Test
    fun launchExtraIsTakenAndKeptInDebuggableBuilds() {
        val dir = Files.createTempDirectory("durbun-extra").toFile()
        val core = launchCore(dir)
        LaunchHostWatcher(core, debuggable = true).onLaunchExtra("192.168.1.20:9800")
        assertEquals("runtime", core.connectionStatus().desktopHostSource)
        assertEquals("192.168.1.20:9800", core.connectionStatus().desktopHost)
        SettingsWriter.awaitIdle()
        assertEquals("192.168.1.20:9800", File(dir, DesktopHostStore.FILE_NAME).readText())
    }

    @Test
    fun launchExtraIsIgnoredInOtherBuildsAndLeavesTheStoredAddressAlone() {
        val dir = Files.createTempDirectory("durbun-extra").toFile()
        val stored = File(dir, DesktopHostStore.FILE_NAME)
        stored.writeText("10.0.0.5")
        val logger = RecordingLogger()
        val core = launchCore(dir, logger)
        val watcher = LaunchHostWatcher(core, debuggable = false)
        watcher.onLaunchExtra("203.0.113.9")
        watcher.onLaunchExtra("")
        watcher.onLaunchExtra(null)
        SettingsWriter.awaitIdle()
        assertEquals("nothing persisted, nothing cleared", "10.0.0.5", stored.readText())
        assertNull(core.connectionStatus().desktopHostSource)
        val notes = logger.lines.filter { it.contains("debuggable builds only") }
        assertEquals("one line explains it", 1, notes.size)
        assertTrue(notes[0].contains("Durbun.setDesktopHost"))
    }
}
