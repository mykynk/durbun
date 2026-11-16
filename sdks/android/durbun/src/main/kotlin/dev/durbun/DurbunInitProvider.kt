package dev.durbun

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Starts Dürbün without a line of code: adding the `durbun` dependency is the whole setup. The artifact's manifest
 * declares this provider, so it is part of the builds that carry the real SDK (never of `durbun-noop` builds).
 *
 * Android creates providers before `Application.onCreate`; this one only posts [Durbun.startAutomatically] to the
 * main thread, which runs after `Application.onCreate` has returned and reads the app's manifest on a Dürbün thread.
 * Without an entry, Dürbün starts by itself in debuggable builds ([AUTO_START_DEFAULT]) and stays off in the others.
 * One entry inside `<application>` decides instead, both ways:
 *
 * ```xml
 * <!-- never start by itself (the app may still call Durbun.start) -->
 * <meta-data android:name="dev.durbun.autoStart" android:value="false" />
 * ```
 *
 * `true` starts it by itself as well; a build that is not debuggable still needs [DurbunOptions.forceInRelease]
 * (which only `Durbun.start` can pass), as before. An app that calls [Durbun.start] (with its own options) or
 * [Durbun.stop] in `Application.onCreate` keeps full control: the automatic start then does nothing. One that calls
 * [Durbun.start] with options later gets a restart with them (same default options: the session stays, never a
 * second one). Flutter apps never start this way: `package:durbun` starts the native layer from Dart.
 */
internal class DurbunInitProvider : ContentProvider() {
    override fun onCreate(): Boolean {
        try {
            val context = context?.applicationContext ?: context ?: return false
            Handler(Looper.getMainLooper()).post {
                try {
                    Durbun.startAutomatically(context)
                } catch (t: Throwable) {
                    Log.w("Durbun", "Dürbün could not start automatically; the app continues without it.", t)
                }
            }
        } catch (t: Throwable) {
            Log.w("Durbun", "Dürbün could not schedule its automatic start.", t)
        }
        return true
    }

    internal companion object {
        /** `<meta-data>` name inside `<application>`: `true` starts Dürbün without code, `false` never does. */
        const val AUTO_START_META_DATA = "dev.durbun.autoStart"

        /**
         * Without the entry: start by itself, in debuggable builds only (a build that is not debuggable stays off
         * silently). Until 0.2 the default was off.
         */
        const val AUTO_START_DEFAULT = true

        /** The entry's value: a boolean resource or literal, or the text `true` / `false`; null otherwise. */
        fun parseAutoStart(value: Any?): Boolean? = when (value) {
            is Boolean -> value
            is String -> when (value.trim().lowercase()) {
                "true" -> true
                "false" -> false
                else -> null
            }
            else -> null
        }
    }

    override fun query(
        uri: Uri,
        projection: Array<out String>?,
        selection: String?,
        selectionArgs: Array<out String>?,
        sortOrder: String?,
    ): Cursor? = null

    override fun getType(uri: Uri): String? = null

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null

    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = 0

    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = 0
}
