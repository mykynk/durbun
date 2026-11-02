package dev.durbun.internal

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Default uncaught-exception handler that reports the crash (`kind: 'crash'`) and then ALWAYS hands the
 * exception to the handler that was installed before it (on Android: the one that shows the crash dialog
 * and kills the process, or Crashlytics & co.).
 */
internal class CrashHandler private constructor(
    private val previous: Thread.UncaughtExceptionHandler?,
) : Thread.UncaughtExceptionHandler {
    @Volatile
    private var core: DurbunCore? = null
    private val handling = AtomicBoolean(false)

    override fun uncaughtException(thread: Thread, error: Throwable) {
        val current = core
        if (current != null && handling.compareAndSet(false, true)) {
            try {
                current.reportCrash(thread, error)
            } catch (_: Throwable) {
                // never interfere with the app's own crash handling
            }
        }
        val next = previous
        if (next != null) {
            next.uncaughtException(thread, error)
        } else {
            // JVM default behaviour when no handler exists.
            System.err.print("Exception in thread \"${thread.name}\" ")
            error.printStackTrace()
        }
    }

    companion object {
        private var installed: CrashHandler? = null

        @Synchronized
        fun install(core: DurbunCore) {
            val existing = installed
            if (existing != null && Thread.getDefaultUncaughtExceptionHandler() === existing) {
                existing.core = core
                return
            }
            val handler = CrashHandler(Thread.getDefaultUncaughtExceptionHandler())
            handler.core = core
            Thread.setDefaultUncaughtExceptionHandler(handler)
            installed = handler
        }

        /** Stops reporting for [core]. Restores the previous handler when nobody wrapped ours meanwhile. */
        @Synchronized
        fun uninstall(core: DurbunCore) {
            val handler = installed ?: return
            if (handler.core === core) handler.core = null
            if (Thread.getDefaultUncaughtExceptionHandler() === handler) {
                Thread.setDefaultUncaughtExceptionHandler(handler.previous)
                installed = null
            }
        }
    }
}
