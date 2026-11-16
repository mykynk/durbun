package dev.durbun.internal.android

import android.annotation.TargetApi
import android.app.Activity
import android.app.Application
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.Process
import android.view.FrameMetrics
import android.view.Window
import dev.durbun.internal.FrameWindow

/**
 * Real frame durations on Android 7+ (`Window.addOnFrameMetricsAvailableListener`) for the app's visible activities:
 * frames actually drawn, janky frames, UI-thread and RenderThread time per frame. Listeners are added only while
 * sampling runs (foreground and connected) and are fed on Dürbün's own `durbun-frames` thread; window changes happen
 * on the main thread. Dialogs and popups have their own windows and are not measured.
 *
 * Activities started before Dürbün are unknown until the next activity starts; [hasWindows] tells the sampler to
 * use the frame-callback counter meanwhile.
 */
@TargetApi(Build.VERSION_CODES.N)
internal class FrameMetricsMonitor(private val app: Application) : Application.ActivityLifecycleCallbacks {
    private val main = Handler(Looper.getMainLooper())
    private val counts = FrameWindow()

    /** Main-thread state. */
    private val started = LinkedHashSet<Activity>()
    private val attached = HashSet<Window>()
    private var running = false
    private var thread: HandlerThread? = null
    private var frameHandler: Handler? = null

    @Volatile
    private var wanted = false

    @Volatile
    private var budgetNs = 1_000_000_000L / 60

    @Volatile
    private var refreshRate = 60.0

    /** Windows being measured right now (read on the metrics thread). */
    @Volatile
    var hasWindows = false
        private set

    private val listener = Window.OnFrameMetricsAvailableListener { _, metrics, dropped ->
        try {
            onFrame(metrics, dropped)
        } catch (_: Throwable) {
        }
    }

    init {
        app.registerActivityLifecycleCallbacks(this)
    }

    fun start(rate: Float) {
        refreshRate = rate.toDouble()
        budgetNs = (1_000_000_000.0 / rate).toLong()
        if (wanted) return
        wanted = true
        main.post {
            if (!wanted || running) return@post
            try {
                running = true
                val frames = HandlerThread("durbun-frames", Process.THREAD_PRIORITY_BACKGROUND).apply { start() }
                thread = frames
                frameHandler = Handler(frames.looper)
                counts.reset()
                started.toList().forEach(::attach)
            } catch (_: Throwable) {
            }
        }
    }

    fun stop() {
        if (!wanted) return
        wanted = false
        main.post {
            if (wanted || !running) return@post
            running = false
            detachAll()
            thread?.quitSafely()
            thread = null
            frameHandler = null
        }
    }

    /** Frames since the previous snapshot, or null while nothing is measured. */
    fun snapshot(): FrameWindow.Snapshot? = if (hasWindows) counts.snapshot(refreshRate) else null

    fun release() {
        stop()
        try {
            app.unregisterActivityLifecycleCallbacks(this)
        } catch (_: Throwable) {
        }
    }

    private fun onFrame(metrics: FrameMetrics, dropped: Int) {
        counts.dropped(dropped)
        val ui = metrics.getMetric(FrameMetrics.INPUT_HANDLING_DURATION) +
            metrics.getMetric(FrameMetrics.ANIMATION_DURATION) +
            metrics.getMetric(FrameMetrics.LAYOUT_MEASURE_DURATION) +
            metrics.getMetric(FrameMetrics.DRAW_DURATION)
        val render = metrics.getMetric(FrameMetrics.SYNC_DURATION) +
            metrics.getMetric(FrameMetrics.COMMAND_ISSUE_DURATION) +
            metrics.getMetric(FrameMetrics.SWAP_BUFFERS_DURATION)
        val deadline = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) metrics.getMetric(FrameMetrics.DEADLINE) else 0L
        counts.record(
            totalNs = metrics.getMetric(FrameMetrics.TOTAL_DURATION),
            uiNs = ui,
            renderNs = render,
            deadlineNs = deadline,
            budgetNs = budgetNs,
            firstFrame = metrics.getMetric(FrameMetrics.FIRST_DRAW_FRAME) == 1L,
        )
    }

    private fun attach(activity: Activity) {
        val handler = frameHandler ?: return
        try {
            val window = activity.window ?: return
            // Never create the decor here: an activity that has not set its content yet keeps its window features.
            if (window in attached || window.peekDecorView() == null) return
            window.addOnFrameMetricsAvailableListener(listener, handler)
            attached += window
            hasWindows = true
        } catch (_: Throwable) {
        }
    }

    private fun detach(activity: Activity) {
        try {
            val window = activity.window ?: return
            if (attached.remove(window)) window.removeOnFrameMetricsAvailableListener(listener)
        } catch (_: Throwable) {
        }
        hasWindows = attached.isNotEmpty()
    }

    private fun detachAll() {
        for (window in attached) {
            try {
                window.removeOnFrameMetricsAvailableListener(listener)
            } catch (_: Throwable) {
            }
        }
        attached.clear()
        hasWindows = false
    }

    override fun onActivityStarted(activity: Activity) {
        started += activity
        if (running) attach(activity)
    }

    override fun onActivityResumed(activity: Activity) {
        if (running) attach(activity) // its decor may not have existed when it started
    }

    override fun onActivityStopped(activity: Activity) {
        started -= activity
        detach(activity)
    }

    override fun onActivityDestroyed(activity: Activity) {
        started -= activity
        detach(activity)
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityPaused(activity: Activity) = Unit

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
}
