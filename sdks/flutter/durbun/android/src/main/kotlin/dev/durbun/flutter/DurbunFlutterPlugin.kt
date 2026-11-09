package dev.durbun.flutter

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import dev.durbun.Durbun
import dev.durbun.DurbunOptions
import dev.durbun.internal.DurbunCore
import dev.durbun.internal.HostLink
import dev.durbun.internal.Json
import dev.durbun.internal.android.AndroidRuntime
import dev.durbun.internal.bool
import dev.durbun.internal.list
import dev.durbun.internal.num
import dev.durbun.internal.obj
import dev.durbun.internal.str
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.MethodCall
import io.flutter.plugin.common.MethodChannel
import java.io.File

/**
 * Android side of `package:durbun`. Registering the plugin does nothing by itself: no thread, no hook, no
 * socket. The Dart SDK starts the native core over the method channel only when it runs (debug/profile, or a
 * release built with `--dart-define=DURBUN=true`). From then on:
 *
 *  - Kotlin `Durbun.log/event`, `DurbunInterceptor` (OkHttp) and uncaught Kotlin/Java exceptions are reported
 *    through the Dart side's single desktop connection (one app session);
 *  - this app's own logcat (`Log.*`, third-party SDKs) goes to Dart as `deviceLogs` while Dart asks for it: the
 *    in-app panel shows it, and Dart sends it on only when the desktop cannot read the device's logs;
 *  - the desktop state (config, mock rules) and native commands (`android.dumpThreads`, `android.gc`, the
 *    app's own `Durbun.addAction` tools) arrive from Dart.
 */
class DurbunFlutterPlugin : FlutterPlugin, ActivityAware, MethodChannel.MethodCallHandler {
    private var channel: MethodChannel? = null
    /** The share sheet opens in the app's own task when an activity is attached. */
    private var activity: Activity? = null
    private var shakeChannel: MethodChannel? = null
    private var shake: ShakeDetector? = null
    private var context: Context? = null
    private val main = Handler(Looper.getMainLooper())

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        context = binding.applicationContext
        channel = MethodChannel(binding.binaryMessenger, CHANNEL).also { it.setMethodCallHandler(this) }
        // Shake to open the in-app inspector: Dart turns the accelerometer on and off ("listen").
        shakeChannel = MethodChannel(binding.binaryMessenger, SHAKE_CHANNEL).also { ch ->
            ch.setMethodCallHandler { call, result ->
                try {
                    if (call.method != "listen") return@setMethodCallHandler result.notImplemented()
                    val ctx = context
                    if (call.arguments == true && ctx != null) {
                        val detector = shake ?: ShakeDetector(ctx) {
                            main.post {
                                try {
                                    shakeChannel?.invokeMethod("shake", null)
                                } catch (_: Throwable) {
                                }
                            }
                        }.also { shake = it }
                        result.success(detector.start())
                    } else {
                        shake?.stop()
                        result.success(false)
                    }
                } catch (t: Throwable) {
                    Log.d(TAG, "Dürbün shake detection failed", t)
                    result.success(false)
                }
            }
        }
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        channel?.setMethodCallHandler(null)
        channel = null
        shake?.stop()
        shake = null
        shakeChannel?.setMethodCallHandler(null)
        shakeChannel = null
        stopHosted()
        context = null
    }

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivityForConfigChanges() {
        activity = null
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) {
        activity = binding.activity
    }

    override fun onDetachedFromActivity() {
        activity = null
    }

    override fun onMethodCall(call: MethodCall, result: MethodChannel.Result) {
        try {
            when (call.method) {
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
                // The in-app panel's "Share…": the system share sheet with the report text.
                "share" -> result.success(share(call.argument<String>("text"), call.argument<String>("subject")))
                // The panel's session export: the share sheet with a file from cacheDir/durbun-export.
                "shareFile" ->
                    result.success(
                        shareFile(
                            call.argument<String>("path"),
                            call.argument<String>("mime"),
                            call.argument<String>("subject"),
                        ),
                    )
                // Where the panel writes exports (and its previous-run log).
                "cacheDir" -> result.success(context?.cacheDir?.absolutePath)
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

    /** Opens the system share sheet; false when there is no context to open it from. */
    private fun share(text: String?, subject: String?): Boolean {
        if (text.isNullOrEmpty()) return false
        val send = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_TEXT, text)
            if (!subject.isNullOrEmpty()) putExtra(Intent.EXTRA_SUBJECT, subject)
        }
        return openChooser(send)
    }

    /**
     * Opens the system share sheet with an export file through [DurbunExportProvider]; false when [path] is not
     * a file in `cacheDir/durbun-export` (the provider serves nothing else) or there is nowhere to open it.
     */
    private fun shareFile(path: String?, mime: String?, subject: String?): Boolean {
        val ctx = context ?: return false
        if (path.isNullOrEmpty()) return false
        val requested = File(path).canonicalFile
        val file = DurbunExportProvider.exportFile(ctx, requested.name) ?: return false
        if (file != requested) return false
        val uri = DurbunExportProvider.uriFor(ctx, file)
        val send = Intent(Intent.ACTION_SEND).apply {
            type = if (mime.isNullOrEmpty()) DurbunExportProvider.mimeOf(file.name) else mime
            putExtra(Intent.EXTRA_STREAM, uri)
            if (!subject.isNullOrEmpty()) putExtra(Intent.EXTRA_SUBJECT, subject)
            // The chooser carries the grant and the clip (its preview) over to the app picked.
            clipData = ClipData.newRawUri(file.name, uri)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
        }
        return openChooser(send)
    }

    private fun openChooser(send: Intent): Boolean {
        val chooser = Intent.createChooser(send, null)
        val host = activity
        if (host != null) {
            host.startActivity(chooser)
        } else {
            val ctx = context ?: return false
            ctx.startActivity(chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        return true
    }

    private fun ownCore(): DurbunCore? = synchronized(lock) { if (owner === this) hosted else null }

    /** Starts (or, after a hot restart, restarts) the hosted core. Returns the JSON reply for Dart. */
    private fun start(argsJson: String?): String {
        val ctx = context ?: return declined("the plugin is not attached to an engine")
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
        // Dart's session id tags every batch: one sent before a hot restart and delivered to the new isolate
        // is ignored there.
        val link = ChannelLink(this, args.str("session") ?: "")
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
                // This app's own logcat, read while Dart asks for it (`state.deviceLogs.read`).
                "deviceLogs" to if (options.captureLogcat) "logcat" else null,
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

    /**
     * Posts native messages to Dart on the main thread (method channels are main-thread only on Android), each
     * batch tagged with Dart's session id. Once Dart answers "not implemented" (no handler: the isolate was hot
     * restarted, or Dart stopped), the link stops sending until Dart starts a new session, so nothing piles up
     * in the engine's channel buffer.
     */
    private class ChannelLink(private val plugin: DurbunFlutterPlugin, private val session: String) : HostLink {
        /** Main thread only. */
        private var stale = false

        private val reply = object : MethodChannel.Result {
            override fun success(result: Any?) {}

            override fun error(errorCode: String, errorMessage: String?, errorDetails: Any?) {}

            override fun notImplemented() {
                stale = true
            }
        }

        private fun send(method: String, key: String, payload: Any, what: String) {
            plugin.main.post {
                if (stale) return@post
                try {
                    plugin.channel?.invokeMethod(method, mapOf("session" to session, key to payload), reply)
                } catch (t: Throwable) {
                    Log.d(TAG, "Dürbün could not forward $what", t)
                }
            }
        }

        override fun deliver(lines: List<String>) = send("events", "lines", lines, "native messages")

        override fun deliverDeviceLogs(lines: List<String>) = send("deviceLogs", "lines", lines, "logcat lines")

        override fun actionsChanged(descriptorsJson: String) =
            send("actions", "actions", descriptorsJson, "native actions")
    }

    private fun declined(reason: String): String =
        Json.encode(linkedMapOf("attached" to false, "platform" to "android", "reason" to reason))

    companion object {
        const val CHANNEL = "dev.durbun/native"
        const val SHAKE_CHANNEL = "dev.durbun/shake"
        private const val TAG = "Durbun"
        private val lock = Any()

        /** The plugin instance (engine) whose Dart side owns the hosted core. */
        private var owner: DurbunFlutterPlugin? = null
        private var hosted: DurbunCore? = null
    }
}
