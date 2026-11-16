package dev.durbun

import dev.durbun.internal.FrameWindow
import dev.durbun.internal.LaunchTiming
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class FrameTimingTest {
    private var now = 0L
    private val budget = 16_666_667L // 60 Hz

    private fun window() = FrameWindow { now }

    @Test
    fun countsFramesDrawnAndAveragesThreadTimes() {
        val w = window()
        repeat(30) { w.record(totalNs = 10_000_000, uiNs = 4_000_000, renderNs = 2_000_000, deadlineNs = 0, budgetNs = budget, firstFrame = false) }
        now = 1_000_000_000L
        val s = w.snapshot(60.0)!!
        assertEquals(30.0, s.fps!!, 0.0)
        assertEquals(0, s.jankyFrames)
        assertEquals(4.0, s.frameBuildMs!!, 0.0)
        assertEquals(2.0, s.frameRasterMs!!, 0.0)
    }

    @Test
    fun nothingDrawnMeansNoFpsInsteadOfTheRefreshRate() {
        val w = window()
        now = 1_000_000_000L
        val s = w.snapshot(120.0)!!
        assertNull(s.fps)
        assertNull(s.frameBuildMs)
        assertEquals(0, s.jankyFrames)
    }

    @Test
    fun jankUsesTheDeadlineWhenReportedElseTwoBudgets() {
        val w = window()
        // Android 12+: the frame's own deadline.
        w.record(totalNs = 20_000_000, uiNs = 0, renderNs = 0, deadlineNs = 16_000_000, budgetNs = budget, firstFrame = false)
        w.record(totalNs = 15_000_000, uiNs = 0, renderNs = 0, deadlineNs = 16_000_000, budgetNs = budget, firstFrame = false)
        // Older: more than two frame budgets.
        w.record(totalNs = 30_000_000, uiNs = 0, renderNs = 0, deadlineNs = 0, budgetNs = budget, firstFrame = false)
        w.record(totalNs = 40_000_000, uiNs = 0, renderNs = 0, deadlineNs = 0, budgetNs = budget, firstFrame = false)
        // A window's first frame (inflation, first layout) is never judged.
        w.record(totalNs = 500_000_000, uiNs = 0, renderNs = 0, deadlineNs = 0, budgetNs = budget, firstFrame = true)
        now = 1_000_000_000L
        assertEquals(2, w.snapshot(60.0)!!.jankyFrames)
    }

    @Test
    fun droppedReportsStillCountAsDrawnFramesAndFpsIsCapped() {
        val w = window()
        w.record(totalNs = 5_000_000, uiNs = 1_000_000, renderNs = 1_000_000, deadlineNs = 0, budgetNs = budget, firstFrame = false)
        w.dropped(200)
        now = 1_000_000_000L
        val s = w.snapshot(60.0)!!
        assertEquals(60.0, s.fps!!, 0.0)
        assertEquals(1.0, s.frameBuildMs!!, 0.0) // averages only over frames with durations
    }

    @Test
    fun shortWindowsWaitAndEachSnapshotStartsANewWindow() {
        val w = window()
        w.record(totalNs = 5_000_000, uiNs = 0, renderNs = 0, deadlineNs = 0, budgetNs = budget, firstFrame = false)
        now = 100_000_000L
        assertNull(w.snapshot(60.0))
        now = 500_000_000L
        assertNotNull(w.snapshot(60.0)!!.fps)
        now = 1_000_000_000L
        assertNull(w.snapshot(60.0)!!.fps)
    }

    @Test
    fun coldStartFromProcessStartToFirstFrame() {
        val props = LaunchTiming.coldStart(processStartMs = 10_000, sdkStartMs = 10_150, firstFrameMs = 10_820, screen = "MainActivity", from = "launchRequest")!!
        assertEquals("cold", props["kind"])
        assertEquals(820L, props["ms"])
        assertEquals("firstFrame", props["to"])
        assertEquals("launchRequest", props["from"])
        assertEquals("MainActivity", props["screen"])
    }

    @Test
    fun noLaunchTimeWhenItWouldNotDescribeALaunch() {
        // Dürbün started long after the process: it did not see the launch.
        assertNull(LaunchTiming.coldStart(10_000, 10_000 + LaunchTiming.MAX_START_AGE_MS + 1, 25_000, "A", "processStart"))
        // The first screen came much later: the process was started for something else.
        assertNull(LaunchTiming.coldStart(10_000, 10_100, 10_000 + LaunchTiming.MAX_LAUNCH_MS + 1, "A", "processStart"))
        // Clocks that do not line up.
        assertNull(LaunchTiming.coldStart(0, 100, 200, "A", "processStart"))
        assertNull(LaunchTiming.coldStart(10_000, 9_000, 11_000, "A", "processStart"))
        assertNull(LaunchTiming.coldStart(10_000, 10_100, 10_050, "A", "processStart"))
    }
}
