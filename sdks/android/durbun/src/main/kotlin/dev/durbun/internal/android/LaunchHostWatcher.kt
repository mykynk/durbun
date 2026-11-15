package dev.durbun.internal.android

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.os.Bundle
import dev.durbun.internal.DesktopAddress
import dev.durbun.internal.DurbunCore
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Takes the desktop address from the launch intent's `durbun.host` string extra, so it can be given without code
 * or a rebuild (`adb shell am start -n <app>/<activity> --es durbun.host 192.168.1.20`, an Android Studio run
 * configuration's launch flags, a test runner's launch arguments). It is kept for the next launches, like
 * `Durbun.setDesktopHost`. Links opened from a browser or another app's deep link are ignored.
 *
 * Only in debuggable builds: another app on the phone can start the launcher activity with extras, so other builds
 * take the address from `Durbun.setDesktopHost` or the `dev.durbun.host` manifest entry instead.
 */
internal class LaunchHostWatcher(
    private val core: DurbunCore,
    private val debuggable: Boolean,
) : Application.ActivityLifecycleCallbacks {
    private val ignoredNoted = AtomicBoolean(false)

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) {
        if (savedInstanceState != null) return // recreated: the extra was handled when it was new
        try {
            val intent = activity.intent ?: return
            if (intent.hasCategory(Intent.CATEGORY_BROWSABLE) || intent.data != null) return
            if (!intent.hasExtra(EXTRA)) return
            onLaunchExtra(intent.getStringExtra(EXTRA))
        } catch (t: Throwable) {
            core.logger.warn("Could not read the $EXTRA launch extra", t)
        }
    }

    /** A launch intent carried the extra (`value` may be empty: back to the build's address). */
    fun onLaunchExtra(value: String?) {
        if (!debuggable) {
            if (ignoredNoted.compareAndSet(false, true)) {
                core.logger.warn(
                    "Ignoring the $EXTRA launch extra: it works in debuggable builds only. In other builds, set the " +
                        "Mac's address with Durbun.setDesktopHost (for example from a debug menu) or the " +
                        "dev.durbun.host manifest entry.",
                )
            }
            return
        }
        if (value.isNullOrBlank()) {
            core.setDesktopHost(null)
            return
        }
        val address = DesktopAddress.parse(value)
        if (address == null) {
            core.logger.warn("Ignoring the $EXTRA launch extra \"$value\": use the Mac's IP address, e.g. 192.168.1.20")
            return
        }
        core.setDesktopHost(address)
    }

    override fun onActivityStarted(activity: Activity) = Unit

    override fun onActivityResumed(activity: Activity) = Unit

    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivityStopped(activity: Activity) = Unit

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) = Unit

    companion object {
        const val EXTRA = "durbun.host"
    }
}
