package dev.durbun.internal

/**
 * Frames drawn between two metric samples, from per-frame durations (Android's `FrameMetrics`). Plain JVM so the
 * arithmetic is unit-tested; the platform listener feeds it from its own thread.
 *
 * - `fps`: frames actually drawn per second (capped at the refresh rate). An app that draws nothing has no `fps`
 *   for that sample (idle), instead of the display's refresh rate.
 * - `jankyFrames`: frames that missed their deadline (Android 12+ reports it per frame) or, before that, took
 *   longer than two frame budgets (the threshold Jetpack's JankStats uses).
 * - `frameBuildMs`: average UI-thread time per frame (input, animation, measure/layout, draw).
 * - `frameRasterMs`: average RenderThread/GPU time per frame (sync, command issue, swap buffers).
 */
internal class FrameWindow(private val nanoTime: () -> Long = System::nanoTime) {
    class Snapshot(val fps: Double?, val jankyFrames: Int, val frameBuildMs: Double?, val frameRasterMs: Double?)

    private var frames = 0
    private var measured = 0
    private var janky = 0
    private var uiNs = 0L
    private var renderNs = 0L
    private var windowStartNs = nanoTime()

    @Synchronized
    fun reset() {
        frames = 0
        measured = 0
        janky = 0
        uiNs = 0L
        renderNs = 0L
        windowStartNs = nanoTime()
    }

    /**
     * One drawn frame. [deadlineNs] is 0 when the platform does not report it; [budgetNs] is one refresh interval.
     * The first frame of a window (its layout and first draw) is drawn but not judged.
     */
    @Synchronized
    fun record(totalNs: Long, uiNs: Long, renderNs: Long, deadlineNs: Long, budgetNs: Long, firstFrame: Boolean) {
        frames++
        if (totalNs <= 0) return
        measured++
        this.uiNs += uiNs.coerceAtLeast(0)
        this.renderNs += renderNs.coerceAtLeast(0)
        if (firstFrame) return
        val limit = if (deadlineNs > 0) deadlineNs else budgetNs * 2
        if (limit > 0 && totalNs > limit) janky++
    }

    /** Frames the platform drew but whose durations were dropped (the listener was busy). */
    @Synchronized
    fun dropped(count: Int) {
        if (count > 0) frames += count
    }

    /** Values since the previous snapshot (then starts a new window); null while the window is too short. */
    @Synchronized
    fun snapshot(refreshRate: Double): Snapshot? {
        val now = nanoTime()
        val elapsed = now - windowStartNs
        if (elapsed < MIN_WINDOW_NS) return null
        val fps = if (frames == 0) null else round1((frames * 1_000_000_000.0 / elapsed).coerceAtMost(refreshRate))
        val result = Snapshot(
            fps = fps,
            jankyFrames = janky,
            frameBuildMs = if (measured == 0) null else round2(uiNs / measured / 1_000_000.0),
            frameRasterMs = if (measured == 0) null else round2(renderNs / measured / 1_000_000.0),
        )
        frames = 0
        measured = 0
        janky = 0
        uiNs = 0L
        renderNs = 0L
        windowStartNs = now
        return result
    }

    private fun round1(value: Double) = Math.round(value * 10.0) / 10.0

    private fun round2(value: Double) = Math.round(value * 100.0) / 100.0

    companion object {
        const val MIN_WINDOW_NS = 250_000_000L
    }
}

/**
 * Cold-start time as Dürbün reports it (event `durbun.launch`): from the process start (or, on Android 13+, from
 * the moment the system was asked to start it) to the first drawn frame of the first screen. Null when the number
 * would not describe a launch: Dürbün started long after the process (it did not see the launch), or the first
 * frame came so late that the process was not started for that screen.
 */
internal object LaunchTiming {
    const val EVENT = "durbun.launch"

    /** Dürbün started later than this after the process: the launch was over before it looked. */
    const val MAX_START_AGE_MS = 10_000L

    /** A first frame later than this: the process was started for something else (a receiver, a job). */
    const val MAX_LAUNCH_MS = 30_000L

    fun coldStart(processStartMs: Long, sdkStartMs: Long, firstFrameMs: Long, screen: String?, from: String): Map<String, Any?>? {
        if (processStartMs <= 0 || sdkStartMs < processStartMs || firstFrameMs < sdkStartMs) return null
        if (sdkStartMs - processStartMs > MAX_START_AGE_MS) return null
        val ms = firstFrameMs - processStartMs
        if (ms > MAX_LAUNCH_MS) return null
        return linkedMapOf("kind" to "cold", "ms" to ms, "to" to "firstFrame", "from" to from, "screen" to screen)
    }
}
