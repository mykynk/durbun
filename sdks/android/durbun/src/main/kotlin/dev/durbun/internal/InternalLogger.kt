package dev.durbun.internal

/** Dürbün's own diagnostics (logcat tag `Durbun` on Android). Never throws. */
internal interface InternalLogger {
    fun debug(message: String)

    fun info(message: String)

    fun warn(message: String, error: Throwable? = null)
}

internal object SilentLogger : InternalLogger {
    override fun debug(message: String) = Unit

    override fun info(message: String) = Unit

    override fun warn(message: String, error: Throwable?) = Unit
}

/** Starts a low-priority daemon thread that never lets an exception escape to the app's crash handler. */
internal fun startDaemonThread(name: String, logger: InternalLogger, body: () -> Unit): Thread {
    val thread = Thread({
        try {
            body()
        } catch (_: InterruptedException) {
            // stopping
        } catch (t: Throwable) {
            logger.warn("Internal thread '$name' stopped unexpectedly", t)
        }
    }, name)
    thread.isDaemon = true
    // Maps to a background nice value on Android (≈ THREAD_PRIORITY_BACKGROUND).
    thread.priority = Thread.NORM_PRIORITY - 1
    thread.start()
    return thread
}
