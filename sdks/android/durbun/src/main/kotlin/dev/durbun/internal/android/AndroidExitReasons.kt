package dev.durbun.internal.android

import android.annotation.TargetApi
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Build
import android.os.Process
import dev.durbun.internal.ExitReasonSource
import dev.durbun.internal.ExitRecord
import dev.durbun.internal.ExitReports
import dev.durbun.internal.SettingsWriter
import java.io.File
import java.io.InputStream

/**
 * How earlier launches ended, from `ActivityManager.getHistoricalProcessExitReasons` (Android 11 / API 30+; older
 * systems keep no such record). Read once per launch on Dürbün's I/O thread; a small marker file remembers the
 * newest exit already handled so nothing is reported twice.
 */
internal class AndroidExitReasons(
    private val context: Context,
    private val dirProvider: () -> File?,
) : ExitReasonSource {
    private fun markerFile(): File? = dirProvider()?.let { File(it, MARKER_FILE) }

    override fun newRecords(): List<ExitRecord> {
        if (Build.VERSION.SDK_INT < 30) return emptyList()
        return read()
    }

    @TargetApi(30)
    private fun read(): List<ExitRecord> {
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return emptyList()
        val infos = am.getHistoricalProcessExitReasons(context.packageName, 0, MAX_RECORDS)
        if (infos.isEmpty()) return emptyList()
        val handled = readMarker()
        // First launch with Dürbün: only what happened recently, not the app's whole history.
        val floor = handled ?: (System.currentTimeMillis() - FIRST_RUN_WINDOW_MS)
        val myPid = Process.myPid()
        return infos
            .filter { it.timestamp > floor && it.pid != myPid }
            .sortedBy { it.timestamp }
            .map(::toRecord)
    }

    @TargetApi(30)
    private fun toRecord(info: ApplicationExitInfo): ExitRecord = ExitRecord(
        timestampMs = info.timestamp,
        reason = info.reason,
        description = info.description,
        status = info.status,
        importance = info.importance,
        pssKb = info.pss,
        rssKb = info.rss,
        pid = info.pid,
        processName = info.processName,
        traces = if (info.reason == ExitReports.ANR) readTraces(info) else null,
    )

    @TargetApi(30)
    private fun readTraces(info: ApplicationExitInfo): String? = try {
        info.traceInputStream?.use { readCapped(it, MAX_TRACE_BYTES) }
    } catch (_: Throwable) {
        null
    }

    private fun readCapped(input: InputStream, max: Int): String {
        val buffer = ByteArray(max)
        var total = 0
        while (total < max) {
            val n = input.read(buffer, total, max - total)
            if (n < 0) break
            total += n
        }
        return String(buffer, 0, total, Charsets.UTF_8)
    }

    private fun readMarker(): Long? = try {
        markerFile()?.takeIf { it.isFile }?.readText(Charsets.UTF_8)?.trim()?.toLongOrNull()
    } catch (_: Throwable) {
        null
    }

    override fun markHandled(timestampMs: Long) {
        SettingsWriter.execute {
            val file = markerFile() ?: return@execute
            val previous = readMarker()
            if (previous != null && previous >= timestampMs) return@execute
            file.parentFile?.mkdirs()
            file.writeText(timestampMs.toString(), Charsets.UTF_8)
        }
    }

    private companion object {
        const val MARKER_FILE = "exit-reasons-handled"
        const val MAX_RECORDS = 8
        const val FIRST_RUN_WINDOW_MS = 24L * 60 * 60 * 1000

        /** The main thread comes first in an ANR dump; the rest is cut. */
        const val MAX_TRACE_BYTES = 512 * 1024
    }
}
