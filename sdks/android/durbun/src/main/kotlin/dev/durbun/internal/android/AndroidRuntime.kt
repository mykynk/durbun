package dev.durbun.internal.android

import android.content.Context
import android.os.Build
import android.os.Handler
import android.os.Looper
import dev.durbun.DurbunAction
import dev.durbun.DurbunOptions
import dev.durbun.internal.CrashHandler
import dev.durbun.internal.DurbunCore
import dev.durbun.internal.HostLink
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

    /**
     * Hosted mode (Flutter plugin): no socket, no metrics sampler (Flutter sends its own frame metrics);
     * crash handler, logcat forwarding (Wi-Fi only) and the OkHttp interceptor work as usual.
     */
    fun startHosted(
        context: Context,
        options: DurbunOptions,
        actions: Collection<DurbunAction>,
        link: HostLink,
        redactedHeaders: Set<String>,
    ): DurbunCore {
        val hostedOptions = options.copy(captureMetrics = false)
        val env = AndroidEnvironment(context, hostedOptions)
        // The Flutter plugin posts each batch to the main looper; a marker posted right after it runs once the
        // batch was handed to Dart, so the relay keeps at most one batch queued on a stalled main thread.
        val main = Handler(Looper.getMainLooper())
        val core = DurbunCore(hostedOptions, env, host = link, hostBarrier = { marker -> main.post(marker) })
        core.redactedHeaders = redactedHeaders
        core.crashStore = PendingCrashStore { env.storageDir }
        actions.forEach(core::addAction)
        if (hostedOptions.captureLogcat) {
            core.logcat = LogcatForwarder(
                pid = env.pid,
                modernLogcat = Build.VERSION.SDK_INT >= 24,
                logger = env.logger,
            ) { entry -> core.forwardLogcat(entry.ts, entry.level, entry.tag, entry.message, entry.tid) }
        }
        if (hostedOptions.captureCrashes) CrashHandler.install(core)
        core.start()
        env.logger.info(
            "Dürbün ${dev.durbun.Durbun.VERSION} native layer started for ${env.appId} (pid ${env.pid}); " +
                "it reports through the Flutter SDK's connection.",
        )
        return core
    }

    /** `hello.app` as the Android side knows it (label, versionName, versionCode). */
    fun appInfo(core: DurbunCore): Map<String, Any?> = core.appInfo()

    fun stop(core: DurbunCore) {
        CrashHandler.uninstall(core)
        core.stop()
    }
}
