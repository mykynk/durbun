package dev.durbun

import dev.durbun.internal.LogcatEntry
import dev.durbun.internal.LogcatForwarder
import dev.durbun.internal.LogcatMerger
import dev.durbun.internal.LogcatParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.ZoneId
import java.time.ZonedDateTime
import java.util.TimeZone
import java.util.concurrent.CopyOnWriteArrayList

class LogcatTest {
    private val istanbul = TimeZone.getTimeZone("Europe/Istanbul")
    private val now = ZonedDateTime.of(2026, 11, 2, 12, 0, 0, 0, ZoneId.of("Europe/Istanbul")).toInstant().toEpochMilli()

    private fun millis(y: Int, mo: Int, d: Int, h: Int, mi: Int, s: Int, ms: Int) =
        ZonedDateTime.of(y, mo, d, h, mi, s, ms * 1_000_000, ZoneId.of("Europe/Istanbul")).toInstant().toEpochMilli()

    @Test
    fun parsesThreadtimeLines() {
        val e = LogcatParser.parse("11-02 11:43:12.345  4321  4377 D OkHttp  : --> GET https://api.example.com/users", now, istanbul)!!
        assertEquals(millis(2026, 11, 2, 11, 43, 12, 345), e.ts)
        assertEquals(4321, e.pid)
        assertEquals(4377, e.tid)
        assertEquals(Level.DEBUG, e.level)
        assertEquals("OkHttp", e.tag)
        assertEquals("--> GET https://api.example.com/users", e.message)

        val crash = LogcatParser.parse("11-02 11:43:12.346  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main", now, istanbul)!!
        assertEquals("AndroidRuntime", crash.tag)
        assertEquals("FATAL EXCEPTION: main", crash.message)
        assertEquals(Level.ERROR, crash.level)
    }

    @Test
    fun parsesEpochYearAndOddTags() {
        val epoch = LogcatParser.parse("  1793619792.345  4321  4377 W Ads Manager: Slow ad load (2300 ms)")!!
        assertEquals(1793619792345L, epoch.ts)
        assertEquals(Level.WARN, epoch.level)
        assertEquals("Ads Manager", epoch.tag)
        assertEquals("Slow ad load (2300 ms)", epoch.message)

        val usec = LogcatParser.parse("1793619792.345123  4321  4400 V chatty  : uid=10123(com.mykynk.pati) RenderThread identical 4 lines")!!
        assertEquals(1793619792345L, usec.ts)
        assertEquals("chatty", usec.tag)

        val year = LogcatParser.parse("2026-11-02 11:43:12.345  4321  4377 I flutter : Kullanıcı giriş yaptı", now, istanbul)!!
        assertEquals(millis(2026, 11, 2, 11, 43, 12, 345), year.ts)
        assertEquals("flutter", year.tag)
        assertEquals("Kullanıcı giriş yaptı", year.message)

        val empty = LogcatParser.parse("11-02 11:43:12.345  4321  4377 I MyTag   :", now, istanbul)!!
        assertEquals("MyTag", empty.tag)
        assertEquals("", empty.message)

        val fatal = LogcatParser.parse("11-02 11:43:12.345  4321  4377 F libc    : Fatal signal 11 (SIGSEGV), code 1", now, istanbul)!!
        assertEquals(Level.FATAL, fatal.level)
        assertEquals("Fatal signal 11 (SIGSEGV), code 1", fatal.message)
    }

    @Test
    fun ignoresNonLogLines() {
        assertNull(LogcatParser.parse("--------- beginning of main"))
        assertNull(LogcatParser.parse(""))
        assertNull(LogcatParser.parse("logcat: Unknown option '--pid=4321'"))
        assertNull(LogcatParser.parse("\tat com.mykynk.pati.MainActivity.onCreate(MainActivity.kt:42)"))
    }

    @Test
    fun decemberLinesReadInJanuaryBelongToLastYear() {
        val newYear = ZonedDateTime.of(2027, 1, 1, 0, 0, 10, 0, ZoneId.of("Europe/Istanbul")).toInstant().toEpochMilli()
        val e = LogcatParser.parse("12-31 23:59:59.999  1  2 I Tag: bye 2026", newYear, istanbul)!!
        assertEquals(millis(2026, 12, 31, 23, 59, 59, 999), e.ts)
    }

    @Test
    fun mergesMultiLineMessagesWithTheSameHeader() {
        val out = ArrayList<LogcatEntry>()
        val merger = LogcatMerger { out += it }
        val lines = listOf(
            "11-02 11:43:12.346  4321  4321 E AndroidRuntime: FATAL EXCEPTION: main",
            "11-02 11:43:12.346  4321  4321 E AndroidRuntime: Process: com.mykynk.pati, PID: 4321",
            "11-02 11:43:12.346  4321  4321 E AndroidRuntime: java.lang.IllegalStateException: Ödeme sağlayıcısı hazır değil",
            "11-02 11:43:12.346  4321  4321 E AndroidRuntime: \tat com.mykynk.pati.Pay.start(Pay.kt:12)",
            "11-02 11:43:12.350  4321  4377 I OkHttp  : <-- 200 OK (123ms)",
        )
        for (line in lines) merger.add(LogcatParser.parse(line, now, istanbul)!!)
        assertEquals(1, out.size)
        assertEquals(
            "FATAL EXCEPTION: main\nProcess: com.mykynk.pati, PID: 4321\n" +
                "java.lang.IllegalStateException: Ödeme sağlayıcısı hazır değil\n\tat com.mykynk.pati.Pay.start(Pay.kt:12)",
            out[0].message,
        )
        assertTrue(merger.hasPending())
        merger.flush()
        assertEquals(2, out.size)
        assertEquals("<-- 200 OK (123ms)", out[1].message)
    }

    @Test
    fun forwarderStreamsOwnPidAndSkipsReplayedLinesAfterRestart() {
        val sh = File("/bin/sh")
        if (!sh.canExecute()) return // not on a POSIX host
        val script = File.createTempFile("fake-logcat", ".txt").apply {
            deleteOnExit()
            writeText(
                listOf(
                    "--------- beginning of main",
                    "  1793619792.100  4321  4377 I MainActivity: onCreate",
                    "  1793619792.200  9999  9999 I OtherApp: not ours",
                    "  1793619792.300  4321  4321 E AndroidRuntime: java.lang.RuntimeException: boom",
                    "  1793619792.300  4321  4321 E AndroidRuntime: \tat com.mykynk.pati.Main.run(Main.kt:7)",
                    "  1793619792.400  4321  4380 W OkHttp  : slow call",
                ).joinToString("\n", postfix = "\n"),
            )
        }
        val received = CopyOnWriteArrayList<LogcatEntry>()
        val forwarder = LogcatForwarder(
            pid = 4321,
            modernLogcat = true,
            logger = RecordingLogger(),
            command = { listOf("/bin/sh", "-c", "cat '${script.absolutePath}'") },
        ) { received += it }
        forwarder.setEnabled(true)
        try {
            val deadline = System.currentTimeMillis() + 5_000
            while (received.size < 3 && System.currentTimeMillis() < deadline) Thread.sleep(20)
            assertEquals(listOf("MainActivity", "AndroidRuntime", "OkHttp"), received.map { it.tag })
            assertEquals("java.lang.RuntimeException: boom\n\tat com.mykynk.pati.Main.run(Main.kt:7)", received[1].message)
            // The fake logcat exits; the forwarder restarts it after ~1 s and must not repeat old lines.
            Thread.sleep(1_600)
            assertEquals(3, received.size)
        } finally {
            forwarder.setEnabled(false)
        }
    }

    @Test
    fun defaultCommandUsesPidFilterOnModernDevices() {
        assertEquals(listOf("logcat", "-v", "threadtime", "-v", "epoch", "--pid=4321"), LogcatForwarder.defaultCommand(true, 4321))
        assertEquals(listOf("logcat", "-v", "threadtime"), LogcatForwarder.defaultCommand(false, 4321))
        assertNotNull(LogcatParser.levelOf('A'))
    }
}
