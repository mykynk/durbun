package dev.durbun.internal

import java.io.File
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The desktop address given at run time (`Durbun.setDesktopHost`, the `durbun.host` launch extra), kept for the
 * next launches in one small file. Reads happen on Dürbün's I/O thread; writes on a background thread, never on
 * the caller's.
 */
internal class DesktopHostStore(private val dirProvider: () -> File?) {
    private fun file(): File? = dirProvider()?.let { File(it, FILE_NAME) }

    /** The saved address, or null. Does disk I/O: call it off the main thread. */
    fun load(): String? = try {
        file()?.takeIf { it.isFile }?.readText(Charsets.UTF_8)?.trim()?.ifEmpty { null }
    } catch (_: Throwable) {
        null
    }

    /** Saves [value] (null deletes it) on a background thread. */
    fun save(value: String?) {
        try {
            SettingsWriter.execute {
                try {
                    val f = file() ?: return@execute
                    if (value == null) {
                        f.delete()
                    } else {
                        f.parentFile?.mkdirs()
                        val tmp = File(f.parentFile, "$FILE_NAME.tmp")
                        tmp.writeText(value, Charsets.UTF_8)
                        if (!tmp.renameTo(f)) {
                            f.writeText(value, Charsets.UTF_8)
                            tmp.delete()
                        }
                    }
                } catch (_: Throwable) {
                }
            }
        } catch (_: Throwable) {
        }
    }

    companion object {
        const val FILE_NAME = "desktop-host"
    }
}

/** One low-priority background thread for Dürbün's small settings files (never the caller's thread). */
internal object SettingsWriter {
    private val executor: ExecutorService by lazy {
        Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "durbun-settings").apply {
                isDaemon = true
                priority = Thread.NORM_PRIORITY - 1
            }
        }
    }

    fun execute(task: () -> Unit) {
        try {
            executor.execute {
                try {
                    task()
                } catch (_: Throwable) {
                }
            }
        } catch (_: Throwable) {
        }
    }

    /** Tests: waits until earlier writes are done. */
    fun awaitIdle(timeoutMs: Long = 2_000) {
        try {
            executor.submit {}.get(timeoutMs, TimeUnit.MILLISECONDS)
        } catch (_: Throwable) {
        }
    }
}
