package dev.durbun.internal.android

import android.annotation.TargetApi
import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.view.View
import android.view.ViewTreeObserver
import dev.durbun.internal.LaunchTiming

/**
 * Cold start, sent once as the `durbun.launch` event: from the process start (Android 13+: from the moment the
 * system was asked to start it) to the first frame drawn by the first activity that resumes (a splash or trampoline
 * activity that finishes without drawing does not count).
 *
 * The process counts as started for an activity only when an activity callback arrives before a message Dürbün
 * posts to the main thread at start-up: the system queues the activity launch together with the application
 * start, while a process started for a receiver, a service or a job runs that message first. Then nothing is
 * sent. Nothing is sent either when Dürbün started too late to see the launch (see [LaunchTiming]).
 */
@TargetApi(Build.VERSION_CODES.N)
internal class LaunchTimer(
    private val app: Application,
    private val report: (Map<String, Any?>) -> Unit,
) : Application.ActivityLifecycleCallbacks {
    private val main = Handler(Looper.getMainLooper())
    private val sdkStartMs = SystemClock.elapsedRealtime()
    private val fromRequest = Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
    private val processStartMs = if (fromRequest) Process.getStartRequestedElapsedRealtime() else Process.getStartElapsedRealtime()

    @Volatile
    private var markerRan = false

    /** Main-thread state, apart from [finished]. */
    private var decided = false
    private var coldForActivity = false
    private var waitingForDraw = false

    @Volatile
    private var finished = false

    init {
        main.post { markerRan = true }
        app.registerActivityLifecycleCallbacks(this)
    }

    fun release() = finish()

    private fun decide() {
        if (decided) return
        decided = true
        coldForActivity = !markerRan
        if (!coldForActivity) finish()
    }

    private fun watchFirstDraw(activity: Activity) {
        val decor = activity.window?.peekDecorView() ?: return
        waitingForDraw = true
        val screen = activity.javaClass.simpleName.ifEmpty { activity.javaClass.name }
        val observer = decor.viewTreeObserver
        val listener = object : ViewTreeObserver.OnDrawListener {
            private var seen = false

            override fun onDraw() {
                if (seen) return
                seen = true
                // The frame is handed to the RenderThread right after this traversal ends.
                main.postAtFrontOfQueue { onFirstFrame(screen) }
                main.post { removeFrom(decor, this) }
            }
        }
        observer.addOnDrawListener(listener)
    }

    private fun removeFrom(decor: View, listener: ViewTreeObserver.OnDrawListener) {
        try {
            val observer = decor.viewTreeObserver
            if (observer.isAlive) observer.removeOnDrawListener(listener)
        } catch (_: Throwable) {
        }
    }

    private fun onFirstFrame(screen: String) {
        if (finished) return
        val props = LaunchTiming.coldStart(
            processStartMs = processStartMs,
            sdkStartMs = sdkStartMs,
            firstFrameMs = SystemClock.elapsedRealtime(),
            screen = screen,
            from = if (fromRequest) "launchRequest" else "processStart",
        )
        finish()
        if (props != null) {
            try {
                report(props)
            } catch (_: Throwable) {
            }
        }
    }

    private fun finish() {
        if (finished) return
        finished = true
        try {
            app.unregisterActivityLifecycleCallbacks(this)
        } catch (_: Throwable) {
        }
    }

    private fun guarded(block: () -> Unit) {
        if (finished) return
        try {
            block()
        } catch (_: Throwable) {
            finish()
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = guarded { decide() }

    override fun onActivityStarted(activity: Activity) = guarded { decide() }

    override fun onActivityResumed(activity: Activity) = guarded {
        decide()
        if (coldForActivity && !waitingForDraw) watchFirstDraw(activity)
    }

    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivityStopped(activity: Activity) = Unit

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) = Unit
}
