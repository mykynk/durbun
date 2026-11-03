package dev.durbun.internal.android

import android.content.Context
import android.os.Build

/** Who installed this app, as the package manager reports it (used by the store-install guard). */
internal object InstallSource {
    /**
     * Package name of the installer (`com.android.vending` for Google Play); null for adb, Android Studio or
     * when the package manager does not say. Never throws.
     */
    fun installerOf(context: Context): String? = try {
        val pm = context.packageManager
        if (Build.VERSION.SDK_INT >= 30) {
            pm.getInstallSourceInfo(context.packageName).installingPackageName
        } else {
            @Suppress("DEPRECATION")
            pm.getInstallerPackageName(context.packageName)
        }
    } catch (_: Throwable) {
        null
    }
}
