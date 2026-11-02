package dev.durbun.internal.android

import android.content.Context
import android.os.Build
import dev.durbun.DurbunAction
import dev.durbun.DurbunOptions
import dev.durbun.internal.CrashHandler
import dev.durbun.internal.DurbunCore
import dev.durbun.internal.LogcatForwarder
import dev.durbun.internal.PendingCrashStore

/** Wires a [DurbunCore] to Android: environment, metrics, logcat forwarding, crash handler. */
internal object AndroidRuntime {
    fun start(context: Context, options: DurbunOptions, actions: Collection<DurbunAction>): DurbunCore {
        val env = AndroidEnvironment(context, options)
        val core = DurbunCore(options, env)
        core.crashStore = PendingCrashStore { env.storageDir }
        actions.forEach(core::addAction)
        if (options.captureMetrics) {
            core.metricsSampler = try {
                AndroidMetricsSampler(context)
            } catch (t: Throwable) {
                env.logger.warn("Metrics are unavailable on this device", t)
                null
            }
        }
        if (options.captureLogcat) {
            core.logcat = LogcatForwarder(
                pid = env.pid,
                modernLogcat = Build.VERSION.SDK_INT >= 24,
                logger = env.logger,
            ) { entry -> core.forwardLogcat(entry.ts, entry.level, entry.tag, entry.message, entry.tid) }
        }
        if (options.captureCrashes) CrashHandler.install(core)
        core.start()
        env.logger.info(
            "Dürbün ${dev.durbun.Durbun.VERSION} started for ${env.appId} (pid ${env.pid}); " +
                "connecting to the desktop on port ${options.port}" +
                (options.host?.let { " (Wi-Fi host $it)" } ?: ""),
        )
        return core
    }

    fun stop(core: DurbunCore) {
        CrashHandler.uninstall(core)
        core.stop()
    }
}
