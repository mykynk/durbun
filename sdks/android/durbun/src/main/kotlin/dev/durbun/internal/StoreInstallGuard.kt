package dev.durbun.internal

/**
 * Dürbün never runs in store builds. A release build made with Dürbün switched on (Flutter
 * `--dart-define=DURBUN=true`, Android `forceInRelease`) can still reach the store by mistake, so the SDK
 * looks at who installed the app and turns itself off for store installs.
 */
internal object StoreInstallGuard {
    /** Google Play, on every track (internal testing included). */
    const val GOOGLE_PLAY = "com.android.vending"

    private val STORE_INSTALLERS = setOf(GOOGLE_PLAY)

    const val MESSAGE_TR = "Dürbün kendini kapattı: uygulama mağazadan kurulmuş (Dürbün mağaza sürümlerinde çalışmaz)."
    const val MESSAGE_EN =
        "Dürbün turned itself off: this app was installed from the store (Dürbün never runs in store builds)."

    /** True when [installer] (the package that installed the app; null for adb or when unknown) is a store. */
    fun isStoreInstaller(installer: String?): Boolean = installer != null && installer in STORE_INSTALLERS

    /** The one line Dürbün logs when it turns itself off: Turkish on Turkish devices, English otherwise. */
    fun message(language: String?): String = if (language.equals("tr", ignoreCase = true)) MESSAGE_TR else MESSAGE_EN
}
