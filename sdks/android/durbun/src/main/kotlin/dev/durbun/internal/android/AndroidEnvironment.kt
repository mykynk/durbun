package dev.durbun.internal.android

import android.app.Application
import android.content.Context
import android.content.pm.ApplicationInfo
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.provider.Settings
import android.util.Log
import dev.durbun.DurbunOptions
import dev.durbun.internal.Environment
import dev.durbun.internal.InternalLogger
import java.io.File

/**
 * [Environment] backed by the real Android APIs. Values are computed once, lazily, on Dürbün's own threads
 * (no disk or /proc access on the main thread, so StrictMode stays quiet).
 */
internal class AndroidEnvironment(
    private val context: Context,
    private val options: DurbunOptions,
) : Environment {
    override val appId: String = context.packageName
    val pid: Int = Process.myPid()
    override val isEmulator: Boolean by lazy { detectEmulator() }
    override val logger: InternalLogger = AndroidLogger
    override val storageDir: File? by lazy {
        try {
            File(context.cacheDir, "durbun")
        } catch (_: Throwable) {
            null
        }
    }

    private val mainHandler = Handler(Looper.getMainLooper())
    private val app: Map<String, Any?> by lazy { buildAppInfo() }
    private val device: Map<String, Any?> by lazy { buildDeviceHints() }

    override fun appInfo(): Map<String, Any?> = app

    override fun deviceHints(): Map<String, Any?> = device

    override fun currentTid(): Int = Process.myTid()

    override fun runOnMain(block: () -> Unit) {
        if (Looper.myLooper() === Looper.getMainLooper()) block() else mainHandler.post { block() }
    }

    private fun buildAppInfo(): Map<String, Any?> {
        val pm = context.packageManager
        val info: ApplicationInfo = context.applicationInfo
        var versionName: String? = null
        var versionCode: Long? = null
        try {
            val pkg = packageInfo(pm)
            versionName = pkg.versionName
            versionCode = if (Build.VERSION.SDK_INT >= 28) {
                pkg.longVersionCode
            } else {
                @Suppress("DEPRECATION")
                pkg.versionCode.toLong()
            }
        } catch (_: Throwable) {
        }
        val label = options.appName ?: try {
            info.loadLabel(pm).toString()
        } catch (_: Throwable) {
            null
        }
        return linkedMapOf(
            "name" to (label?.takeIf { it.isNotBlank() } ?: appId),
            "id" to appId,
            "version" to versionName,
            "build" to versionCode?.toString(),
            "pid" to pid,
            "processName" to processName(),
            "debug" to ((info.flags and ApplicationInfo.FLAG_DEBUGGABLE) != 0),
        )
    }

    private fun packageInfo(pm: PackageManager): PackageInfo =
        if (Build.VERSION.SDK_INT >= 33) {
            pm.getPackageInfo(appId, PackageManager.PackageInfoFlags.of(0))
        } else {
            @Suppress("DEPRECATION")
            pm.getPackageInfo(appId, 0)
        }

    private fun processName(): String? {
        if (Build.VERSION.SDK_INT >= 28) {
            try {
                return Application.getProcessName()
            } catch (_: Throwable) {
            }
        }
        return try {
            File("/proc/self/cmdline").readBytes().let { bytes ->
                val end = bytes.indexOf(0.toByte()).let { if (it < 0) bytes.size else it }
                String(bytes, 0, end, Charsets.UTF_8).trim().ifEmpty { null }
            }
        } catch (_: Throwable) {
            null
        }
    }

    private fun buildDeviceHints(): Map<String, Any?> = linkedMapOf(
        "platform" to "android",
        "model" to Build.MODEL,
        "manufacturer" to Build.MANUFACTURER?.replaceFirstChar { it.uppercaseChar() },
        "name" to deviceName(),
        "osVersion" to Build.VERSION.RELEASE,
        "apiLevel" to Build.VERSION.SDK_INT,
        "isPhysical" to !isEmulator,
    )

    /** The user-visible device name ("Yusuf's Pixel"), falling back to the model. */
    private fun deviceName(): String? {
        if (Build.VERSION.SDK_INT >= 25) {
            try {
                val name = Settings.Global.getString(context.contentResolver, Settings.Global.DEVICE_NAME)
                if (!name.isNullOrBlank()) return name
            } catch (_: Throwable) {
            }
        }
        return Build.MODEL
    }

    private fun detectEmulator(): Boolean {
        val fingerprint = Build.FINGERPRINT.orEmpty()
        val model = Build.MODEL.orEmpty()
        val product = Build.PRODUCT.orEmpty()
        val hardware = Build.HARDWARE.orEmpty()
        return fingerprint.startsWith("generic") ||
            fingerprint.startsWith("unknown") ||
            fingerprint.contains("emulator") ||
            fingerprint.contains("/sdk_gphone") ||
            model.contains("google_sdk") ||
            model.contains("Emulator") ||
            model.contains("Android SDK built for") ||
            Build.MANUFACTURER.orEmpty().contains("Genymotion") ||
            hardware.contains("goldfish") ||
            hardware.contains("ranchu") ||
            product.contains("sdk_gphone") ||
            product == "google_sdk" ||
            product.contains("emulator") ||
            product.contains("simulator") ||
            (Build.BRAND.orEmpty().startsWith("generic") && Build.DEVICE.orEmpty().startsWith("generic"))
    }
}

/** Dürbün's own diagnostics in logcat (tag `Durbun`). */
internal object AndroidLogger : InternalLogger {
    private const val TAG = "Durbun"

    override fun debug(message: String) {
        try {
            if (Log.isLoggable(TAG, Log.DEBUG)) Log.d(TAG, message)
        } catch (_: Throwable) {
        }
    }

    override fun info(message: String) {
        try {
            Log.i(TAG, message)
        } catch (_: Throwable) {
        }
    }

    override fun warn(message: String, error: Throwable?) {
        try {
            if (error != null) Log.w(TAG, message, error) else Log.w(TAG, message)
        } catch (_: Throwable) {
        }
    }
}
