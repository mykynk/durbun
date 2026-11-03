package dev.durbun

import android.content.Context
import android.content.ContextWrapper
import android.content.pm.ApplicationInfo
import dev.durbun.internal.DurbunCore
import dev.durbun.internal.StoreInstallGuard
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.atomic.AtomicInteger

/**
 * The checks in [Durbun.start] before anything starts: Flutter apps leave the native layer to the plugin, and
 * release builds never run in store installs, even when forced.
 */
class StartGuardTest {
    private val starts = AtomicInteger()
    private var installer: String? = null
    private var pluginPresent = false
    private val realInstallerLookup = Durbun.installerLookup
    private val realPluginCheck = Durbun.flutterPluginPresent
    private val realStarter = Durbun.runtimeStarter

    /** A context with just what [Durbun.start] reads (the Android stubs return defaults otherwise). */
    private class FakeContext(private val debuggable: Boolean) : ContextWrapper(null) {
        override fun getApplicationContext(): Context = this

        override fun getApplicationInfo(): ApplicationInfo =
            ApplicationInfo().also { it.flags = if (debuggable) ApplicationInfo.FLAG_DEBUGGABLE else 0 }

        override fun getPackageName(): String = "com.mykynk.pati"
    }

    @Before
    fun setUp() {
        Durbun.installForTesting(null)
        Durbun.installerLookup = { installer }
        Durbun.flutterPluginPresent = { pluginPresent }
        Durbun.runtimeStarter = { _, options, _ ->
            starts.incrementAndGet()
            DurbunCore(options, FakeEnvironment()) // never started: no socket, no thread
        }
    }

    @After
    fun tearDown() {
        Durbun.installForTesting(null)
        Durbun.installerLookup = realInstallerLookup
        Durbun.flutterPluginPresent = realPluginCheck
        Durbun.runtimeStarter = realStarter
    }

    private fun start(debuggable: Boolean, forceInRelease: Boolean = false) =
        Durbun.start(FakeContext(debuggable), DurbunOptions(forceInRelease = forceInRelease, port = 1))

    @Test
    fun forcedReleaseBuildInstalledFromGooglePlayStaysOff() {
        installer = StoreInstallGuard.GOOGLE_PLAY
        start(debuggable = false, forceInRelease = true)
        assertFalse(Durbun.isStarted)
        assertEquals("nothing was started", 0, starts.get())
    }

    @Test
    fun forcedReleaseBuildFromFirebaseOrAdbRuns() {
        for (source in listOf("dev.firebase.appdistribution", "com.google.android.packageinstaller", null)) {
            Durbun.installForTesting(null)
            installer = source
            start(debuggable = false, forceInRelease = true)
            assertTrue("installer $source", Durbun.isStarted)
        }
        assertEquals(3, starts.get())
    }

    @Test
    fun releaseBuildWithoutForceStaysOffAndDebugBuildsRun() {
        start(debuggable = false)
        assertFalse(Durbun.isStarted)
        // Debuggable builds never come from a store; the guard looks at release builds only.
        installer = StoreInstallGuard.GOOGLE_PLAY
        start(debuggable = true)
        assertTrue(Durbun.isStarted)
        assertEquals(1, starts.get())
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

    @Test
    fun guardDecisionAndItsOneLine() {
        assertTrue(StoreInstallGuard.isStoreInstaller("com.android.vending"))
        assertFalse(StoreInstallGuard.isStoreInstaller(null))
        assertFalse(StoreInstallGuard.isStoreInstaller("dev.firebase.appdistribution"))
        assertFalse(StoreInstallGuard.isStoreInstaller("com.android.shell"))
        assertEquals(
            "Dürbün kendini kapattı: uygulama mağazadan kurulmuş (Dürbün mağaza sürümlerinde çalışmaz).",
            StoreInstallGuard.message("tr"),
        )
        assertEquals(
            "Dürbün turned itself off: this app was installed from the store (Dürbün never runs in store builds).",
            StoreInstallGuard.message("en"),
        )
        assertEquals(StoreInstallGuard.MESSAGE_EN, StoreInstallGuard.message(null))
    }
}
