package dev.durbun.internal

import java.io.File

/**
 * Everything the SDK core needs from the host platform. Android provides it in `AndroidEnvironment`;
 * unit tests provide a plain JVM fake, so the core never touches `android.*` directly.
 */
internal interface Environment {
    /** Package name (`hello.app.id`, also used to scope mock rules). */
    val appId: String

    /** `hello.app` (name, id, version, build, pid, processName, debug). */
    fun appInfo(): Map<String, Any?>

    /** `hello.device` hints (platform, model, manufacturer, name, osVersion, apiLevel, isPhysical). */
    fun deviceHints(): Map<String, Any?>

    /** Running on an emulator (adds the 10.0.2.2 host alias as an endpoint). */
    val isEmulator: Boolean

    /** Kernel thread id of the calling thread (matches logcat's TID column), when known. */
    fun currentTid(): Int?

    /** Runs [block] on the app's main thread (immediately when already on it). */
    fun runOnMain(block: () -> Unit)

    val logger: InternalLogger

    /** Directory for the pending-crash file; `null` disables crash persistence. */
    val storageDir: File?

    fun nowMs(): Long = System.currentTimeMillis()
}

/** Desktop-provided capture settings (`SdkConfig` in the protocol). */
internal data class SdkConfig(
    val captureBodies: Boolean = true,
    val maxBodyBytes: Int = 1_048_576,
    val metricsIntervalMs: Long = 1_000,
    val deviceLogsAvailable: Boolean = false,
) {
    companion object {
        /** Merges a `config` object over [previous] (unknown / missing fields keep their old value). */
        fun from(map: Map<String, Any?>, previous: SdkConfig): SdkConfig = SdkConfig(
            captureBodies = map.bool("captureBodies") ?: previous.captureBodies,
            maxBodyBytes = map.num("maxBodyBytes")?.toLong()?.coerceIn(0L, Int.MAX_VALUE.toLong())?.toInt()
                ?: previous.maxBodyBytes,
            metricsIntervalMs = map.num("metricsIntervalMs")?.toLong() ?: previous.metricsIntervalMs,
            deviceLogsAvailable = map.bool("deviceLogsAvailable") ?: previous.deviceLogsAvailable,
        )
    }
}

/** Source of periodic performance samples (Android: memory, CPU, threads, FPS / janky frames). */
internal interface MetricsSampler {
    /** One sample: any of cpu, memoryMB, heapMB, fps, jankyFrames, frameBuildMs, frameRasterMs, threads. */
    fun sample(): Map<String, Any?>

    /** Sampling is paused (disconnected): release per-frame hooks. */
    fun pause()
}

/** Forwards the app's own logcat when the desktop has no device logs. */
internal interface LogcatController {
    fun setEnabled(enabled: Boolean)

    fun stop()
}
