package dev.durbun.internal.android

import android.app.ActivityManager
import android.content.Context
import android.hardware.display.DisplayManager
import android.os.Debug
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.view.Choreographer
import android.view.Display
import dev.durbun.internal.MetricsSampler
import java.io.File

/**
 * Periodic performance sample (runs on Dürbün's metrics thread):
 * - `cpu`: process CPU time / wall time (percent of one core),
 * - `memoryMB`: PSS (`Debug.getPss`, sampled less often when it is slow on this device),
 * - `heapMB`: Java heap in use, `threads`: entries in /proc/self/task,
 * - `fps` / `jankyFrames`: from a Choreographer frame callback, only while the app is in the foreground.
 */
internal class AndroidMetricsSampler(context: Context) : MetricsSampler {
    private val displayManager = context.getSystemService(Context.DISPLAY_SERVICE) as? DisplayManager
    private val frames = FrameMonitor()

    private var lastCpuMs = -1L
    private var lastWallMs = 0L
    private var pssMB: Double? = null
    private var pssSampledAt = 0L
    private var pssEveryMs = 0L

    override fun sample(): Map<String, Any?> {
        val values = LinkedHashMap<String, Any?>()
        cpuPercent()?.let { values["cpu"] = it }
        memoryMB()?.let { values["memoryMB"] = it }
        val runtime = Runtime.getRuntime()
        values["heapMB"] = round1((runtime.totalMemory() - runtime.freeMemory()) / MB)
        threadCount()?.let { values["threads"] = it }
        if (isForeground()) {
            frames.start(refreshRate())
            frames.snapshot()?.let {
                values["fps"] = round1(it.fps)
                values["jankyFrames"] = it.jankyFrames
            }
        } else {
            frames.stop()
        }
        return values
    }

    override fun pause() = frames.stop()

    private fun cpuPercent(): Double? {
        val cpuMs = Process.getElapsedCpuTime()
        val wallMs = SystemClock.elapsedRealtime()
        val result = if (lastCpuMs >= 0 && wallMs > lastWallMs) {
            (cpuMs - lastCpuMs) * 100.0 / (wallMs - lastWallMs)
        } else {
            null
        }
        lastCpuMs = cpuMs
        lastWallMs = wallMs
        return result?.let { round1(it.coerceAtLeast(0.0)) }
    }

    private fun memoryMB(): Double? {
        val now = SystemClock.elapsedRealtime()
        if (pssMB == null || now - pssSampledAt >= pssEveryMs) {
            val started = System.nanoTime()
            val pssKb = Debug.getPss()
            val tookMs = (System.nanoTime() - started) / 1_000_000L
            // Reading smaps can be slow on older kernels; then sample PSS every 5 s instead of every tick.
            pssEveryMs = if (tookMs > SLOW_PSS_MS) 5_000L else 0L
            pssSampledAt = now
            if (pssKb > 0) pssMB = round1(pssKb / 1024.0)
        }
        return pssMB
    }

    private fun threadCount(): Int? = try {
        File("/proc/self/task").list()?.size
    } catch (_: Throwable) {
        null
    }

    private fun isForeground(): Boolean = try {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    } catch (_: Throwable) {
        true
    }

    private fun refreshRate(): Float = try {
        val rate = displayManager?.getDisplay(Display.DEFAULT_DISPLAY)?.refreshRate ?: 60f
        if (rate in 10f..500f) rate else 60f
    } catch (_: Throwable) {
        60f
    }

    private fun round1(value: Double): Double = Math.round(value * 10.0) / 10.0

    private companion object {
        const val MB = 1024.0 * 1024.0
        const val SLOW_PSS_MS = 20L
    }
}

/**
 * Counts frames with a self-reposting `Choreographer.FrameCallback` on the main thread. A frame is janky when
 * the gap since the previous frame exceeds 1.5× the display's frame budget (at least one vsync missed).
 * All Choreographer calls happen on the main thread; counters are shared with the metrics thread.
 */
internal class FrameMonitor : Choreographer.FrameCallback {
    class Snapshot(val fps: Double, val jankyFrames: Int)

    private val main = Handler(Looper.getMainLooper())
    private val lock = Any()

    /** Main-thread state. */
    private var running = false

    /** Requested state (any thread) to avoid posting when nothing changes. */
    @Volatile
    private var wanted = false

    @Volatile
    private var refreshRate = 60f

    private var frames = 0
    private var janky = 0
    private var lastFrameNs = 0L
    private var windowStartNs = 0L
    private var counting = false

    fun start(rate: Float) {
        refreshRate = rate
        if (wanted) return
        wanted = true
        main.post {
            if (!running && wanted) {
                running = true
                synchronized(lock) {
                    frames = 0
                    janky = 0
                    lastFrameNs = 0L
                    windowStartNs = System.nanoTime()
                    counting = true
                }
                val choreographer = Choreographer.getInstance()
                choreographer.removeFrameCallback(this)
                choreographer.postFrameCallback(this)
            }
        }
    }

    fun stop() {
        if (!wanted) return
        wanted = false
        main.post {
            if (running && !wanted) {
                running = false
                Choreographer.getInstance().removeFrameCallback(this)
                synchronized(lock) { counting = false }
            }
        }
    }

    override fun doFrame(frameTimeNanos: Long) {
        if (!running) return
        synchronized(lock) {
            if (lastFrameNs != 0L) {
                val budgetNs = 1_000_000_000.0 / refreshRate
                if (frameTimeNanos - lastFrameNs > budgetNs * 1.5) janky++
            }
            frames++
            lastFrameNs = frameTimeNanos
        }
        Choreographer.getInstance().postFrameCallback(this)
    }

    /** FPS and janky frames since the previous snapshot; `null` until a meaningful window was observed. */
    fun snapshot(): Snapshot? {
        synchronized(lock) {
            if (!counting) return null
            val now = System.nanoTime()
            val elapsed = now - windowStartNs
            if (elapsed < MIN_WINDOW_NS) return null
            val fps = (frames * 1_000_000_000.0 / elapsed).coerceAtMost(refreshRate.toDouble())
            val result = Snapshot(fps, janky)
            frames = 0
            janky = 0
            windowStartNs = now
            return result
        }
    }

    private companion object {
        const val MIN_WINDOW_NS = 250_000_000L
    }
}
