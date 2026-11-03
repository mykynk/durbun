package dev.durbun.flutter

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import dev.durbun.Durbun
import dev.durbun.DurbunOptions
import dev.durbun.internal.DurbunCore
import dev.durbun.internal.HostLink
import dev.durbun.internal.Json
import dev.durbun.internal.StoreInstallGuard
import dev.durbun.internal.android.AndroidRuntime
import dev.durbun.internal.android.InstallSource
import dev.durbun.internal.bool
import dev.durbun.internal.list
import dev.durbun.internal.num
import dev.durbun.internal.obj
import dev.durbun.internal.str
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel

/**
 * Android side of `package:durbun`. Registering the plugin does nothing by itself: no thread, no hook, no
 * socket. The Dart SDK starts the native core over the method channel only when it runs (debug/profile, or a
 * release built with `--dart-define=DURBUN=true`). From then on:
 *
 *  - Kotlin `Durbun.log/event`, `DurbunInterceptor` (OkHttp) and uncaught Kotlin/Java exceptions are reported
 *    through the Dart side's single desktop connection (one app session);
 *  - the desktop state (config, mock rules) and native commands (`android.dumpThreads`, `android.gc`, the
 *    app's own `Durbun.addAction` tools) arrive from Dart.
 *
 * Never in store installs: a release build asks `guard` before Dart starts anything, and `start` refuses
 * when Google Play installed the app (any track), so Dart turns everything off.
 */
class DurbunFlutterPlugin : FlutterPlugin, MethodChannel.MethodCallHandler {
    private var channel: MethodChannel? = null
    private var context: Context? = null
    private val main = Handler(Looper.getMainLooper())

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        stopHosted()
        context = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
                "guard" -> result.success(guard())
                "start" -> result.success(start(call.arguments as? String))
                "state" -> {
                    ownCore()?.applyHostState(call.arguments as? String ?: "")
                    result.success(null)
                }
                "command" -> {
                    ownCore()?.handleHostCommand(call.arguments as? String ?: "")
                    result.success(null)
                }
                "stop" -> {
                    stopHosted()
                    result.success(null)
                }
                else -> result.notImplemented()
            }
        } catch (t: Throwable) {
            // Errors are data: never let the SDK break the app.
            Log.d(TAG, "Dürbün native call '${call.method}' failed", t)
            try {
                result.success(null)
            } catch (_: Throwable) {
            }
        }
    }

    private fun ownCore(): DurbunCore? = synchronized(lock) { if (owner === this) hosted else null }

    /**
     * Store-install guard, asked by a release build before Dart starts anything. Without `storeInstall` in
     * the reply (no engine) Dart stays off.
     */
    private fun guard(): String {
        val ctx = context ?: return Json.encode(linkedMapOf("platform" to "android"))
        val installer = InstallSource.installerOf(ctx)
        return Json.encode(
            linkedMapOf(
                "platform" to "android",
                "storeInstall" to StoreInstallGuard.isStoreInstaller(installer),
                "installer" to installer,
            ),
        )
    }

    /** Starts (or, after a hot restart, restarts) the hosted core. Returns the JSON reply for Dart. */
    private fun start(argsJson: String?): String {
        val ctx = context ?: return declined("the plugin is not attached to an engine")
        val installer = InstallSource.installerOf(ctx)
        if (StoreInstallGuard.isStoreInstaller(installer)) {
            // Nothing starts; Dart disposes everything it started and prints the one line.
            return Json.encode(
                linkedMapOf(
                    "attached" to false,
                    "platform" to "android",
                    "storeInstall" to true,
                    "reason" to "the app was installed from the store ($installer)",
                ),
            )
        }
        val args = argsJson?.let { Json.parseObject(it) } ?: emptyMap()
        val opts = args.obj("options") ?: emptyMap()
        synchronized(lock) {
            val current = owner
            if (current != null && current !== this && current.channel != null) {
                return declined("another Flutter engine in this process already runs Dürbün")
            }
        }
        // Hot restart (same engine, new Dart isolate) or a second start: begin a fresh native session.
        stopHosted()

        val redacted = opts.list("redactHeaders")?.mapNotNull { (it as? String)?.lowercase() }?.toSet() ?: emptySet()
        val options = DurbunOptions(
            enabled = true,
            // Dart already decided that Dürbün runs in this build (release only with DURBUN=true).
            forceInRelease = true,
            captureCrashes = opts.bool("captureErrors") ?: true,
            captureMetrics = false,
            captureLogcat = opts.str("capturePrint") != "never",
            maxBufferedMessages = opts.num("maxBufferedMessages")?.toInt() ?: DurbunOptions.DEFAULT_MAX_BUFFERED_MESSAGES,
            // Dart's captureNetwork: false also keeps OkHttp out (no capture, no mocks, not announced).
            captureNetwork = opts.bool("captureNetwork") ?: true,
        )
        val link = ChannelLink(this)
        val core = AndroidRuntime.startHosted(ctx, options, Durbun.pendingActions(), link, redacted)
        synchronized(lock) {
            owner = this
            hosted = core
        }
        Durbun.attachHosted(core)
        args.obj("state")?.let { core.applyHostState(Json.encode(it)) }

        val app = core.appInfo()
        return Json.encode(
            linkedMapOf(
                "attached" to true,
                "platform" to "android",
                "sdk" to linkedMapOf("name" to "durbun-android", "version" to Durbun.VERSION),
                "capabilities" to core.hostedCapabilities(),
                "actions" to Json.parse(core.describeActionsJson()),
                "commands" to core.hostedCommands(),
                "app" to linkedMapOf("name" to app["name"], "version" to app["version"], "build" to app["build"]),
                "urlSession" to false,
            ),
        )
    }

    private fun stopHosted() {
        val core = synchronized(lock) {
            if (owner !== this) return
            val c = hosted
            hosted = null
            owner = null
            c
        } ?: return
        try {
            Durbun.detachHosted(core)
        } catch (t: Throwable) {
            Log.d(TAG, "Dürbün native layer did not stop cleanly", t)
        }
    }

    /** Posts native messages to Dart on the main thread (method channels are main-thread only on Android). */
    private class ChannelLink(private val plugin: DurbunFlutterPlugin) : HostLink {
        override fun deliver(lines: List<String>) {
            plugin.main.post {
                try {
                    plugin.channel?.invokeMethod("events", lines)
                } catch (t: Throwable) {
                    Log.d(TAG, "Dürbün could not forward native messages", t)
                }
            }
        }

        override fun actionsChanged(descriptorsJson: String) {
            plugin.main.post {
                try {
                    plugin.channel?.invokeMethod("actions", descriptorsJson)
                } catch (t: Throwable) {
                    Log.d(TAG, "Dürbün could not forward native actions", t)
                }
            }
        }
    }

    private fun declined(reason: String): String =
        Json.encode(linkedMapOf("attached" to false, "platform" to "android", "reason" to reason))

    companion object {
        const val CHANNEL = "dev.durbun/native"
        private const val TAG = "Durbun"
        private val lock = Any()

        /** The plugin instance (engine) whose Dart side owns the hosted core. */
        private var owner: DurbunFlutterPlugin? = null
        private var hosted: DurbunCore? = null
    }
}
