package dev.durbun

/** Log severity, shown on the desktop as Verbose … Fatal. */
enum class Level(
    /** Name used on the wire (`verbose`, `debug`, `info`, `warn`, `error`, `fatal`). */
    val wireName: String,
) {
    VERBOSE("verbose"),
    DEBUG("debug"),
    INFO("info"),
    WARN("warn"),
    ERROR("error"),
    FATAL("fatal");

    companion object {
        /**
         * Maps an `android.util.Log` priority (VERBOSE = 2 … ASSERT = 7) to a [Level].
         * Handy in a Timber tree: `Durbun.log(Level.fromPriority(priority), tag, message, throwable = t)`.
         */
        @JvmStatic
        fun fromPriority(priority: Int): Level = when {
            priority <= 2 -> VERBOSE
            priority == 3 -> DEBUG
            priority == 4 -> INFO
            priority == 5 -> WARN
            priority == 6 -> ERROR
            else -> FATAL
        }
    }
}
