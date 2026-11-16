package dev.durbun

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import dev.durbun.internal.DurbunCore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * The checks in [Durbun.start] before anything starts: Flutter apps leave the native layer to the plugin, and
 * release builds run only when forced.
 */
class StartGuardTest {
    private val starts = AtomicInteger()
    private var pluginPresent = false
    private val realPluginCheck = Durbun.flutterPluginPresent
    private val realStarter = Durbun.runtimeStarter
    private val realAutoStartEntry = Durbun.autoStartEntry
    private val realAutoStartRunner = Durbun.autoStartRunner

    /** The app's `dev.durbun.autoStart` manifest entry (null: none). */
    private var autoStartEntry: Boolean? = true

    /** A context with just what [Durbun.start] reads (the Android stubs return defaults otherwise). */
    private class FakeContext(private val debuggable: Boolean) : ContextWrapper(null) {
        override fun getApplicationContext(): Context = this

        override fun getApplicationInfo(): ApplicationInfo =
            ApplicationInfo().also { it.flags = if (debuggable) ApplicationInfo.FLAG_DEBUGGABLE else 0 }
    }

    @Before
    fun setUp() {
        Durbun.installForTesting(null)
        Durbun.flutterPluginPresent = { pluginPresent }
        Durbun.runtimeStarter = { _, options, _ ->
            starts.incrementAndGet()
            DurbunCore(options, FakeEnvironment()) // never started: no socket, no thread
        }
        Durbun.autoStartEntry = { autoStartEntry }
        Durbun.autoStartRunner = { it.run() }
    }

    @After
    fun tearDown() {
        Durbun.installForTesting(null)
        Durbun.flutterPluginPresent = realPluginCheck
        Durbun.runtimeStarter = realStarter
        Durbun.autoStartEntry = realAutoStartEntry
        Durbun.autoStartRunner = realAutoStartRunner
    }

    private fun start(debuggable: Boolean, forceInRelease: Boolean = false) =
        Durbun.start(FakeContext(debuggable), DurbunOptions(forceInRelease = forceInRelease, port = 1))

    @Test
    fun forcedReleaseBuildRuns() {
        start(debuggable = false, forceInRelease = true)
        assertTrue(Durbun.isStarted)
        assertEquals(1, starts.get())
    }

    @Test
    fun releaseBuildWithoutForceStaysOffAndDebugBuildsRun() {
        start(debuggable = false)
        assertFalse(Durbun.isStarted)
        start(debuggable = true)
        assertTrue(Durbun.isStarted)
        assertEquals(1, starts.get())
    }

    @Test
    fun withoutTheManifestEntryNothingStartsByItself() {
        autoStartEntry = null
        assertFalse("off by default, as before the entry existed", DurbunInitProvider.AUTO_START_DEFAULT)
        Durbun.startAutomatically(FakeContext(debuggable = true))
        assertFalse(Durbun.isStarted)
        assertEquals(0, starts.get())
    }

    @Test
    fun theManifestEntrySwitchesTheAutomaticStartBothWays() {
        autoStartEntry = false
        Durbun.startAutomatically(FakeContext(debuggable = true))
        assertFalse(Durbun.isStarted)

        autoStartEntry = true
        Durbun.startAutomatically(FakeContext(debuggable = true))
        assertTrue(Durbun.isStarted)
        assertEquals(1, starts.get())
    }

    @Test
    fun aManifestEntryThatCannotBeReadFallsBackToTheDefault() {
        Durbun.autoStartEntry = { throw SecurityException("no package manager") }
        Durbun.startAutomatically(FakeContext(debuggable = true))
        assertEquals(DurbunInitProvider.AUTO_START_DEFAULT, Durbun.isStarted)
    }

    @Test
    fun manifestValues() {
        assertEquals(true, DurbunInitProvider.parseAutoStart(true))
        assertEquals(false, DurbunInitProvider.parseAutoStart(false))
        assertEquals(true, DurbunInitProvider.parseAutoStart(" TRUE "))
        assertEquals(false, DurbunInitProvider.parseAutoStart("false"))
        assertEquals(null, DurbunInitProvider.parseAutoStart("yes please"))
        assertEquals(null, DurbunInitProvider.parseAutoStart(null))
        assertEquals(null, DurbunInitProvider.parseAutoStart(1))
    }

    @Test
    fun anAppStartInApplicationOnCreateWins() {
        autoStartEntry = true
        start(debuggable = true)
        Durbun.startAutomatically(FakeContext(debuggable = true))
        assertEquals("the automatic start sees the app's own and does nothing", 1, starts.get())
        assertEquals(1, Durbun.coreOrNull()?.options?.port)
    }

    @Test
    fun aStopOrDisabledStartKeepsTheAutomaticStartOff() {
        Durbun.stop()
        Durbun.startAutomatically(FakeContext(debuggable = true))
        assertFalse(Durbun.isStarted)
        Durbun.installForTesting(null)
        Durbun.start(FakeContext(debuggable = true), DurbunOptions(enabled = false))
        Durbun.startAutomatically(FakeContext(debuggable = true))
        assertFalse(Durbun.isStarted)
        assertEquals(0, starts.get())
    }

    @Test
    fun aLaterAppStartRestartsWithItsOptions() {
        Durbun.startAutomatically(FakeContext(debuggable = true))
        Durbun.start(FakeContext(debuggable = true))
        assertEquals("same (default) options: the session stays", 1, starts.get())

        Durbun.installForTesting(null)
        Durbun.startAutomatically(FakeContext(debuggable = true))
        Durbun.start(FakeContext(debuggable = true), DurbunOptions(host = "192.168.1.20"))
        assertEquals(3, starts.get())
        assertEquals("192.168.1.20", Durbun.coreOrNull()?.options?.host)
        Durbun.start(FakeContext(debuggable = true), DurbunOptions(host = "10.0.0.9"))
        assertEquals("a second app call is ignored as before", 3, starts.get())
    }

    @Test
    fun theAutomaticStartFollowsTheSameChecks() {
        Durbun.startAutomatically(FakeContext(debuggable = false))
        assertFalse(Durbun.isStarted)
        pluginPresent = true
        Durbun.startAutomatically(FakeContext(debuggable = true))
        assertFalse(Durbun.isStarted)
        assertEquals(0, starts.get())
    }

    @Test
    fun flutterAppsLeaveTheNativeLayerToThePlugin() {
        pluginPresent = true
        start(debuggable = true)
        start(debuggable = false, forceInRelease = true)
        assertFalse("a stray native call opens no second session", Durbun.isStarted)
        assertEquals(0, starts.get())
        assertFalse("native-only apps have no plugin class", realPluginCheck())
    }
}
