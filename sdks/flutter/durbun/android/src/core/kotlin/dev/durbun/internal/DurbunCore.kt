package dev.durbun.internal

import dev.durbun.Durbun
import dev.durbun.DurbunAction
import dev.durbun.DurbunConnectionStatus
import dev.durbun.DurbunOptions
import dev.durbun.Level
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * One SDK session (one app process launch): builds protocol messages, owns the transport, applies the
 * desktop's config / mock rules / commands, and drives optional platform plug-ins (metrics, logcat).
 * Plain JVM code — Android specifics come in through [Environment], [MetricsSampler] and [LogcatController].
 *
 * With a [host] (hosted mode, used by the Flutter plugin) the core opens no socket: messages go to the host,
 * which sends them on its own connection, and the desktop state arrives through [applyHostState].
 */
internal class DurbunCore(
    val options: DurbunOptions,
    private val env: Environment,
    timing: Transport.Timing = Transport.Timing(),
    private val host: HostLink? = null,
    /** Hosted mode: queues a marker behind the host's work for a batch (see [HostRelay]); null = no wait. */
    hostBarrier: ((Runnable) -> Boolean)? = null,
) : Transport.Listener {
    val logger: InternalLogger get() = env.logger
    val appId: String get() = env.appId

    /** `hello.session`: random per launch. */
    val sessionId: String = UUID.randomUUID().toString()

    private val queue = OutboundQueue(
        maxMessages = options.maxBufferedMessages.coerceIn(MIN_BUFFERED, MAX_BUFFERED),
        maxChars = MAX_BUFFER_CHARS,
    )
    private val transport = Transport(this::endpoints, this::helloLine, this, queue, env.logger, timing)
    private val relay: HostRelay? = host?.let {
        HostRelay(queue, it, env.logger, onStart = ::drainPendingCrashes, handledBarrier = hostBarrier)
    }

    /** Hosted mode: this app's logcat lines travel apart from other messages, so the host can route them. */
    private val deviceLogQueue: OutboundQueue? = host?.let {
        OutboundQueue(maxMessages = DEVICE_LOG_BUFFER, maxChars = DEVICE_LOG_BUFFER_CHARS)
    }
    private val deviceLogRelay: HostRelay? = host?.let { link ->
        deviceLogQueue?.let { queue ->
            HostRelay(
                queue,
                link,
                env.logger,
                onStart = {},
                threadName = "durbun-relay-logs",
                deliver = link::deliverDeviceLogs,
                handledBarrier = hostBarrier,
            )
        }
    }

    @Volatile
    private var hostState = HostState()

    /** Hosted mode: whether the host wants this app's logcat (`deviceLogs.read`) and sends it on to the desktop. */
    @Volatile
    private var hostDeviceLogs = HostDeviceLogs()

    /** True when another SDK (the Flutter plugin) owns the desktop connection. */
    val isHosted: Boolean get() = host != null

    /**
     * Header names (lower case) redacted in every captured request, on top of the interceptor's own:
     * [DurbunOptions.redactHeaders], plus Flutter's `redactHeaders` in hosted mode.
     */
    @Volatile
    var redactedHeaders: Set<String> = options.redactHeaders.mapTo(HashSet()) { it.lowercase() }

    /** [DurbunOptions.ignoredHosts], lower case, without a leading dot. */
    private val ignoredHosts: List<String> =
        options.ignoredHosts.map { it.trim().trimStart('.').lowercase() }.filter { it.isNotEmpty() }

    /** True for hosts the app asked never to capture ([DurbunOptions.ignoredHosts]; subdomains included). */
    fun ignoresHost(host: String): Boolean {
        if (ignoredHosts.isEmpty()) return false
        val lower = host.lowercase()
        return ignoredHosts.any { lower == it || lower.endsWith(".$it") }
    }
    private val actions = ActionRegistry()
    private val requestSeq = AtomicLong()
    private val recentLogs = RecentLogs()
    private val stopped = AtomicBoolean(false)
    private val logcatAnnounced = AtomicBoolean(false)
    private val metricsWarned = AtomicBoolean(false)

    @Volatile
    var config: SdkConfig = SdkConfig()
        private set

    @Volatile
    var mockRules: List<MockRule> = emptyList()
        private set

    /** App id the desktop assigned (`welcome.appId`), for diagnostics. */
    @Volatile
    var serverAppId: String? = null
        private set

    /** Optional plug-ins, set by the Android glue before [start]. */
    @Volatile
    var metricsSampler: MetricsSampler? = null

    @Volatile
    var logcat: LogcatController? = null

    @Volatile
    var crashStore: PendingCrashStore? = null

    /** Platform tools listed after Dürbün's built-ins (standalone Android: preferences, views, appearance). */
    @Volatile
    var appTools: AppTools? = null

    /** Earlier launches that ended without the app noticing (ANR, native crash, killed by the system). */
    @Volatile
    var exitReasons: ExitReasonSource? = null

    /** Keeps the desktop address given at run time for the next launches (standalone only). */
    @Volatile
    var hostStore: DesktopHostStore? = null

    /** The address built into the app outside the code (Android: `dev.durbun.host` meta-data); I/O thread. */
    @Volatile
    var configuredHost: (() -> String?)? = null

    /** Called when [connectionStatus] changes (any thread). */
    @Volatile
    var onStatusChanged: (() -> Unit)? = null

    /** Platform clean-up run once by [stop] (Android: the launch-extra watcher). */
    @Volatile
    var onStopped: (() -> Unit)? = null

    /* connection diagnostics */
    @Volatile
    private var runtimeHost: DesktopAddress.Parsed? = null

    /** [runtimeHost] was set (or cleared) in this process: the saved value no longer applies. */
    @Volatile
    private var runtimeHostSet = false

    @Volatile
    private var manifestHost: DesktopAddress.Parsed? = null

    @Volatile
    private var attempts: List<ConnectAttempt> = emptyList()

    @Volatile
    private var failedRounds = 0

    @Volatile
    private var everConnected = false

    @Volatile
    private var startedAtNanos = System.nanoTime()
    private val consoleHinted = AtomicBoolean(false)

    /** Tests shorten it. */
    internal var consoleHintAfterMs = CONSOLE_HINT_AFTER_MS

    /** How long after start a missing [dev.durbun.DurbunInterceptor] is mentioned on the desktop. Tests shorten it. */
    internal var networkHintAfterMs = NETWORK_HINT_AFTER_MS
    private val networkHintScheduled = AtomicBoolean(false)

    /** Whether OkHttp is part of the app. Tests replace it. */
    internal var okHttpPresent: () -> Boolean = {
        try {
            Class.forName("okhttp3.OkHttpClient", false, DurbunCore::class.java.classLoader)
            true
        } catch (_: Throwable) {
            false
        }
    }

    private val exitLock = Any()
    private var pendingExits: PendingExits? = null

    private class PendingExits(val reports: List<ExitReports.Report>, val newestMs: Long)

    private val metricsLock = Any()
    private var metricsExecutor: ScheduledExecutorService? = null
    private var metricsTask: ScheduledFuture<*>? = null
    private var metricsIntervalMs = 0L

    val isConnected: Boolean get() = if (host != null) hostState.connected else transport.isConnected

    /** Effective body capture switch (app override wins over the desktop setting). */
    val captureBodies: Boolean get() = options.captureBodies ?: config.captureBodies

    /** Effective per-body capture limit in bytes. */
    val maxBodyBytes: Int get() = (options.maxBodyBytes ?: config.maxBodyBytes).coerceIn(0, MAX_BODY_BYTES)

    /**
     * Send WebSocket messages and SSE events: only while the latest config says `captureStreams: true` (a desktop
     * that leaves the field out cannot take them) and network capture is on. Read per message, so a `config` that
     * changes it applies to the next message.
     */
    val captureStreams: Boolean get() = options.captureNetwork && config.captureStreams && !stopped.get()

    /**
     * Payload cap of one stream message in bytes; 0 = sizes only. The desktop's value, unless the app overrides
     * body capture ([DurbunOptions.captureBodies], [DurbunOptions.maxBodyBytes]) the way it does for HTTP bodies.
     */
    val maxStreamMessageBytes: Int
        get() {
            val forced = options.captureBodies
            if (forced == false) return 0
            val config = config
            val cap = if (forced == true && !config.captureBodies && config.maxStreamMessageBytes == 0) {
                DEFAULT_STREAM_MESSAGE_BYTES // the desktop sent 0 only because its body capture is off
            } else {
                config.maxStreamMessageBytes
            }
            return minOf(cap, maxBodyBytes, MAX_STREAM_MESSAGE_BYTES).coerceAtLeast(0)
        }

    /**
     * True for the desktop's own endpoints: anything on its SDK port, and a WebSocket handshake ([webSocket]) to
     * its `/sdk` or `/ui` socket on a desktop address. Dürbün never reports its own traffic, even when an app, a
     * JavaScript SDK in the same process or a test reaches the desktop through OkHttp. A plain HTTP request to
     * such a path is the app's own (a local development server) and is reported as usual.
     */
    fun isDesktopEndpoint(host: String, port: Int, path: String, webSocket: Boolean = true): Boolean {
        val ownPath = webSocket && (path == "/sdk" || path == "/ui")
        val lan = lanEndpoint()
        if (!ownPath && port != basePort() && port != lan?.port) return false
        val lower = host.lowercase().removePrefix("[").removeSuffix("]")
        if (lower == "localhost" || lower == LOOPBACK || lower == "::1" || lower == EMULATOR_HOST) return true
        if (lan?.host?.lowercase() == lower) return true
        return hostState.endpoint?.host?.lowercase() == lower
    }

    private val untaggedWebSocket = AtomicBoolean(false)
    private val webSocketHinted = AtomicBoolean(false)

    /**
     * [dev.durbun.DurbunInterceptor] saw a WebSocket handshake that did not come through
     * [dev.durbun.DurbunWebSocketFactory]: its messages cannot be seen. Said once, while the desktop wants them.
     */
    fun noteUntaggedWebSocket() {
        untaggedWebSocket.set(true)
        webSocketHintIfNeeded()
    }

    private fun webSocketHintIfNeeded() {
        try {
            if (!untaggedWebSocket.get() || !captureStreams || !webSocketHinted.compareAndSet(false, true)) return
            val message = "This app opened a WebSocket with OkHttpClient.newWebSocket, so Dürbün shows its handshake " +
                "but not its messages. Open it with DurbunWebSocketFactory(client).newWebSocket(request, listener) " +
                "(or pass DurbunWebSocketFactory(client) where a library asks for a WebSocket.Factory)."
            logger.info(message)
            send(
                Wire.log(
                    ts = env.nowMs(),
                    level = Level.INFO.wireName,
                    tag = SDK_TAG,
                    message = message,
                    // Stable for the desktop, which can word the line in the viewer's language.
                    data = linkedMapOf("reason" to "noWebSocketFactory"),
                    kind = "text",
                ),
            )
        } catch (t: Throwable) {
            logger.warn("Could not report the WebSocket setup", t)
        }
    }

    fun start() {
        startedAtNanos = System.nanoTime()
        if (relay != null) {
            relay.start()
            deviceLogRelay?.start()
        } else {
            transport.start()
        }
    }

    fun stop() {
        if (!stopped.compareAndSet(false, true)) return
        try {
            onStopped?.invoke()
        } catch (t: Throwable) {
            logger.warn("Could not clean up", t)
        }
        onStatusChanged = null
        relay?.stop()
        deviceLogRelay?.stop()
        transport.stop()
        stopMetrics()
        synchronized(metricsLock) {
            metricsExecutor?.shutdownNow()
            metricsExecutor = null
        }
        try {
            logcat?.stop()
        } catch (t: Throwable) {
            logger.warn("Could not stop logcat forwarding", t)
        }
        try {
            appTools?.stop()
        } catch (t: Throwable) {
            logger.warn("Could not stop the app tools", t)
        }
    }

    /** Encoded message → outgoing queue (dropped when stopped). */
    fun send(line: String) {
        if (!stopped.get()) queue.offer(line)
    }

    /** A `net.ws` / `net.sse` message: the queue drops these first when it is full. */
    fun sendStream(line: String) {
        if (!stopped.get()) queue.offer(line, stream = true)
    }

    /* ───────────── public API backends ───────────── */

    fun log(level: Level, tag: String?, message: String, data: Any?, throwable: Throwable?) {
        if (stopped.get()) return
        try {
            var error = throwable
            var payload = data
            if (error == null && payload is Throwable) { // Durbun.e("tag", "msg", e) puts the throwable in `data`
                error = payload
                payload = null
            }
            val ts = env.nowMs()
            var text = message
            var errorInfo: Map<String, Any?>? = null
            if (error != null) {
                val stack = Wire.fullStackTrace(error)
                text = Wire.withoutAppendedStack(message, error, stack)
                errorInfo = Wire.errorInfo(error, stack)
            }
            if (logcat != null) recentLogs.remember(level.wireName, message, ts)
            send(
                Wire.log(
                    ts = ts,
                    level = level.wireName,
                    tag = tag,
                    message = text,
                    data = payload,
                    error = errorInfo,
                    kind = "text",
                    tid = env.currentTid(),
                ),
            )
        } catch (t: Throwable) {
            logger.warn("Could not record a log line", t)
        }
    }

    fun event(name: String, props: Map<String, Any?>?) {
        if (stopped.get()) return
        try {
            send(Wire.event(env.nowMs(), name, props))
        } catch (t: Throwable) {
            logger.warn("Could not record event '$name'", t)
        }
    }

    /**
     * A line from this app's own logcat: standalone, only while the desktop has no device logs; hosted, whenever
     * the host asked for them (it decides what reaches the desktop).
     */
    fun forwardLogcat(ts: Long, level: Level, tag: String, message: String, tid: Int?) {
        if (stopped.get()) return
        // Hosted by Flutter: Dart's own print capture already sends the `flutter` lines.
        if (host != null && tag == FLUTTER_TAG) return
        if (recentLogs.isDuplicate(level.wireName, message, ts)) return
        val line = Wire.log(ts = ts, level = level.wireName, tag = tag, message = message, kind = "text", tid = tid)
        val hostedQueue = deviceLogQueue
        if (hostedQueue != null) {
            hostedQueue.offer(line)
        } else {
            send(line)
        }
    }

    fun addAction(action: DurbunAction) {
        actions.add(action)
        if (host != null || isConnected) sendActions()
    }

    fun removeAction(id: String) {
        if (actions.remove(id) && (host != null || isConnected)) sendActions()
    }

    /* ───────────── hosted mode (Flutter plugin) ───────────── */

    /**
     * Desktop state from the host: `{connected, via, appId, config, mocks, hello, deviceLogs}` (JSON). Unknown or
     * missing fields keep their previous value, except the mock rules: they hold only while the host is connected.
     * `deviceLogs: {read, desktop}` says whether the host wants this app's logcat (its in-app panel, or a desktop
     * that cannot read device logs) — it applies whether or not a desktop is connected.
     */
    fun applyHostState(stateJson: String) {
        if (host == null || stopped.get()) return
        try {
            val state = Json.parseObject(stateJson) ?: return
            state.obj("config")?.let { config = SdkConfig.from(it, config) }
            state.str("appId")?.let { serverAppId = it }
            state.obj("deviceLogs")?.let { hostDeviceLogs = HostDeviceLogs.from(it, hostDeviceLogs) }
            val previous = hostState
            val connected = state.bool("connected") ?: previous.connected
            // The desktop is not authenticated yet (any local peer can answer the hello), so rules pushed by a
            // peer that went away must not keep rewriting the app's responses.
            mockRules = if (connected) {
                state.list("mocks")?.let { MockRule.listFromJson(it) } ?: mockRules
            } else {
                emptyList()
            }
            hostState = HostState(
                connected = connected,
                endpoint = if (state.containsKey("via")) HostState.parseVia(state.str("via")) else previous.endpoint,
                helloLine = state.obj("hello")?.let { Json.encode(it) } ?: previous.helloLine,
            )
            if (connected) {
                applyRuntimeConfig()
                sendExitReports()
            } else {
                if (previous.connected) stopMetrics()
                applyLogcat()
            }
            if (connected != previous.connected) notifyStatus()
        } catch (t: Throwable) {
            logger.warn("Could not apply the desktop state from Flutter", t)
        }
    }

    /** A desktop `command` the host forwarded (JSON); the result goes back as `command.result`. */
    fun handleHostCommand(commandJson: String) {
        if (stopped.get()) return
        val message = Json.parseObject(commandJson) ?: return
        handleCommand(message)
    }

    /** Native action descriptors (JSON array) — what the host merges into its own `hello.actions`. */
    fun describeActionsJson(): String = Json.encode(actionDescriptors())

    /** `hello.app` as this platform reports it. */
    fun appInfo(): Map<String, Any?> = env.appInfo()

    /** Capabilities the native side adds to the host's session. */
    fun hostedCapabilities(): List<String> = capabilities()

    /** Command names besides the action ids that this core answers. */
    fun hostedCommands(): List<String> = listOf(ActionRegistry.DUMP_THREADS, ActionRegistry.GC)

    private fun drainPendingCrashes() {
        crashStore?.drain()?.forEach(this::sendPreviousCrash)
        collectExitReports()
    }

    /* ───────────── earlier launches that ended silently ───────────── */

    /** Reads how earlier launches ended (I/O thread); they are sent once a desktop is connected. */
    private fun collectExitReports() {
        val source = exitReasons ?: return
        val records = try {
            source.newRecords()
        } catch (t: Throwable) {
            logger.warn("Could not read how earlier launches ended", t)
            return
        }
        if (records.isEmpty()) return
        val reports = records.mapNotNull { record ->
            try {
                ExitReports.report(record)
            } catch (t: Throwable) {
                logger.warn("Could not describe an earlier exit", t)
                null
            }
        }
        synchronized(exitLock) { pendingExits = PendingExits(reports, records.maxOf { it.timestampMs }) }
        if (isConnected) sendExitReports()
    }

    /**
     * Sends the exit reports once per launch, when a desktop is connected. ANRs and native crashes are left out when
     * the desktop reads the device's own records (adb): it shows them already. Not connected in this launch: the
     * next launch tries again.
     */
    private fun sendExitReports() {
        val pending = synchronized(exitLock) {
            val p = pendingExits ?: return
            pendingExits = null
            p
        }
        val desktopReads = config.deviceLogsAvailable
        for (report in pending.reports) {
            if (report.desktopReadsIt && desktopReads) continue
            send(report.line)
        }
        try {
            exitReasons?.markHandled(pending.newestMs)
        } catch (_: Throwable) {
        }
    }

    /* ───────────── connection status + desktop address ───────────── */

    /** The Wi-Fi address in use and where it comes from, best first: run time, options, manifest. */
    private fun lanAddress(): Pair<DesktopAddress.Parsed, String>? {
        runtimeHost?.let { return it to "runtime" }
        val fromOptions = options.host?.trim()
        if (!fromOptions.isNullOrEmpty()) {
            return (DesktopAddress.parse(fromOptions) ?: DesktopAddress.Parsed(fromOptions, null)) to "options"
        }
        manifestHost?.let { return it to "manifest" }
        return null
    }

    private fun basePort(): Int = if (options.port in 1..65535) options.port else DurbunOptions.DEFAULT_PORT

    private fun lanEndpoint(): Transport.Endpoint? {
        val address = lanAddress()?.first ?: return null
        val host = address.host
        val port = address.port ?: basePort()
        // This device's own loopback on the SDK port is tried anyway (adb reverse).
        if ((host == "localhost" || host == LOOPBACK) && port == basePort()) return null
        return Transport.Endpoint(host, port, 2_500)
    }

    /**
     * Uses [address] as the Wi-Fi address (null: back to the one built into the app) and tries it at once. A
     * connection through the old Wi-Fi address is closed; a USB connection stays. Kept for the next launches.
     */
    fun setDesktopHost(address: DesktopAddress.Parsed?) {
        if (host != null || stopped.get()) return
        val before = lanEndpoint()?.toString()
        runtimeHost = address
        runtimeHostSet = true
        hostStore?.save(address?.toString())
        val after = lanEndpoint()?.toString()
        if (before == after) return
        logger.info(
            if (address == null) {
                "Dürbün desktop address cleared" + (after?.let { "; using $it from the build" } ?: "")
            } else {
                "Dürbün desktop address set to $after"
            },
        )
        attempts = emptyList()
        failedRounds = 0
        transport.reconnectNow { endpoint -> endpoint.toString() == before }
        notifyStatus()
    }

    /** I/O thread, before the first round: the saved and the manifest addresses. */
    private fun loadHosts() {
        if (host != null) return
        try {
            configuredHost?.invoke()?.let { manifestHost = DesktopAddress.parse(it) }
        } catch (t: Throwable) {
            logger.warn("Could not read the dev.durbun.host meta-data", t)
        }
        val saved = hostStore?.load() ?: return
        if (!runtimeHostSet) DesktopAddress.parse(saved)?.let { runtimeHost = it }
    }

    fun connectionStatus(): DurbunConnectionStatus {
        if (host != null) {
            val state = hostState
            return DurbunConnectionStatus(
                isConnected = state.connected,
                via = state.endpoint?.toString(),
                desktopHost = null,
                desktopHostSource = null,
                issue = null,
                hint = if (state.connected) null else HOSTED_HINT,
                failedAttempts = 0,
            )
        }
        val connected = transport.isConnected
        val lan = lanAddress()
        val lanEndpoint = lanEndpoint()?.toString()
        val current = attempts
        val issue = if (connected || current.isEmpty()) null else diagnose(current, lanEndpoint)
        return DurbunConnectionStatus(
            isConnected = connected,
            via = if (connected) transport.connectedEndpoint?.toString() else null,
            desktopHost = lanEndpoint,
            desktopHostSource = lanEndpoint?.let { lan?.second },
            issue = issue?.name,
            hint = issue?.let { ConnectionDiagnosis.nextStep(it, basePort(), lanEndpoint) },
            failedAttempts = if (connected) 0 else failedRounds,
        )
    }

    private fun diagnose(attempts: List<ConnectAttempt>, lanEndpoint: String?): ConnectIssue =
        ConnectionDiagnosis.diagnose(attempts, "android", isPhysical = !env.isEmulator, lanEndpoint = lanEndpoint)

    private fun notifyStatus() {
        try {
            onStatusChanged?.invoke()
        } catch (t: Throwable) {
            logger.warn("A connection listener failed", t)
        }
    }

    /* ───────────── network capture support ───────────── */

    fun nextRequestId(): String = "okhttp-" + requestSeq.incrementAndGet()

    fun findMock(method: String, url: String): MockRule? =
        if (options.captureNetwork) MockMatcher.find(mockRules, method, url, env.appId) else null

    /* ───────────── crashes ───────────── */

    /**
     * Sends a crash report and gives it a moment to reach the desktop (the process dies right after).
     * Stored on disk when it cannot be delivered, and sent on the next launch.
     */
    fun reportCrash(thread: Thread, error: Throwable) {
        val line = crashLine(thread, error)
        if (host != null) {
            reportCrashHosted(line)
            return
        }
        send(line)
        val delivered = try {
            val connected = transport.isConnected || transport.awaitConnected(CRASH_CONNECT_WAIT_MS)
            connected && transport.awaitDrained(CRASH_FLUSH_WAIT_MS)
        } catch (_: InterruptedException) {
            false
        }
        if (!delivered) crashStore?.save(line)
    }

    /**
     * Hosted mode: the host (Dart) may never run again — a crash on the main thread blocks it — so the report
     * goes directly to the desktop on a short-lived connection with the host's own hello (same app session).
     * When that fails it is stored and sent on the next launch ("Previous launch crashed — …").
     */
    private fun reportCrashHosted(line: String) {
        val state = hostState
        val endpoint = state.endpoint
        val hello = state.helloLine
        val delivered = if (state.connected && endpoint != null && hello != null) {
            try {
                EmergencyDelivery.deliverOffThread(endpoint, hello, line)
            } catch (_: Throwable) {
                false
            }
        } else {
            false
        }
        if (!delivered) crashStore?.save(line)
    }

    private fun crashLine(thread: Thread, error: Throwable): String {
        return Wire.log(
            ts = env.nowMs(),
            level = Level.FATAL.wireName,
            tag = CRASH_TAG,
            message = "FATAL EXCEPTION in thread \"${thread.name}\": $error",
            data = linkedMapOf("thread" to thread.name, "threadId" to threadIdOf(thread)),
            error = Wire.errorInfo(error),
            kind = "crash",
            tid = env.currentTid(),
        )
    }

    private fun sendPreviousCrash(line: String) {
        val msg = Json.parseObject(line) ?: return
        val original = msg.str("message") ?: "Crash"
        val data = LinkedHashMap<String, Any?>()
        msg.obj("data")?.let { data.putAll(it) }
        data["previousLaunch"] = true
        data["crashedAt"] = msg["ts"]
        @Suppress("UNCHECKED_CAST")
        send(
            Wire.log(
                ts = (msg.num("ts") ?: env.nowMs()),
                level = Level.FATAL.wireName,
                tag = CRASH_TAG,
                message = "Previous launch crashed — $original",
                data = data,
                error = msg["error"] as? Map<String, Any?>,
                kind = "crash",
                tid = msg.num("tid")?.toInt(),
            ),
        )
    }

    @Suppress("DEPRECATION")
    private fun threadIdOf(thread: Thread): Long = thread.id

    /* ───────────── Transport.Listener ───────────── */

    override fun onIoThreadStarted() {
        loadHosts()
        drainPendingCrashes()
    }

    override fun onConnected(endpoint: Transport.Endpoint, welcome: Map<String, Any?>) {
        welcome.obj("config")?.let { config = SdkConfig.from(it, config) }
        mockRules = MockRule.listFromJson(welcome.list("mocks"))
        serverAppId = welcome.str("appId")
        logger.info("Connected to the Dürbün desktop via $endpoint (${welcome.str("server") ?: "unknown server"})")
        applyRuntimeConfig()
        attempts = emptyList()
        failedRounds = 0
        everConnected = true
        sendExitReports()
        scheduleNetworkHint()
        notifyStatus()
    }

    override fun onMessage(message: Map<String, Any?>) {
        when (message.str("type")) {
            "mocks" -> mockRules = MockRule.listFromJson(message.list("rules"))
            "config" -> message.obj("config")?.let {
                config = SdkConfig.from(it, config)
                applyRuntimeConfig()
            }
            "command" -> handleCommand(message)
            "welcome" -> {
                message.obj("config")?.let { config = SdkConfig.from(it, config) }
                message.list("mocks")?.let { mockRules = MockRule.listFromJson(it) }
                applyRuntimeConfig()
            }
            else -> logger.debug("Ignoring desktop message '${message.str("type")}'")
        }
    }

    override fun onDisconnected(endpoint: Transport.Endpoint, reason: String) {
        // Mock rules hold only while the peer that pushed them is connected (it is not authenticated yet).
        // The desktop sends them again in its next welcome.
        mockRules = emptyList()
        logger.info("Disconnected from the Dürbün desktop ($reason); reconnecting…")
        stopMetrics()
        notifyStatus()
    }

    override fun onConnectFailed(attempt: Int, attempts: List<ConnectAttempt>) {
        val endpoints = endpoints().map { it.toString() }
        if (attempt == 1) {
            logger.info("Waiting for the Dürbün desktop on ${endpoints.joinToString()} …")
        }
        // A round that started before the address changed says nothing about the new one.
        if (attempts.isEmpty() || attempts.any { it.endpoint !in endpoints }) return
        this.attempts = attempts
        failedRounds++
        notifyStatus()
        val waitedMs = (System.nanoTime() - startedAtNanos) / 1_000_000
        if (!everConnected && waitedMs >= consoleHintAfterMs && consoleHinted.compareAndSet(false, true)) {
            val lan = lanEndpoint()?.toString()
            logger.warn(ConnectionDiagnosis.consoleHint(diagnose(attempts, lan), attempts, basePort(), lan))
        }
    }

    override fun droppedWarning(count: Long): String = Wire.log(
        ts = env.nowMs(),
        level = Level.WARN.wireName,
        tag = SDK_TAG,
        message = "Dürbün dropped $count older messages while the desktop was unreachable or slow " +
            "(buffer: ${options.maxBufferedMessages} messages).",
        data = linkedMapOf("dropped" to count),
        kind = "text",
    )

    override fun pong(ping: Map<String, Any?>): String = Wire.pong(env.nowMs())

    /* ───────────── commands ───────────── */

    private fun handleCommand(message: Map<String, Any?>) {
        val id = message.str("id") ?: return
        val name = message.str("name") ?: ""
        val params = message.obj("params") ?: emptyMap()
        when (name) {
            ActionRegistry.DUMP_THREADS -> reply(id) { dumpThreads() }
            ActionRegistry.GC -> reply(id) { runGc() }
            else -> {
                if (runAppTool(id, name, params)) return
                val action = actions.get(name)
                if (action == null) {
                    send(Wire.commandResult(id, ok = false, data = null, error = "Unknown command: $name"))
                    return
                }
                env.runOnMain {
                    try {
                        val data = action.invoke(params)
                        send(Wire.commandResult(id, ok = true, data = data, error = null))
                        if (action.kind != DurbunAction.Kind.BUTTON) sendActions()
                    } catch (t: Throwable) {
                        send(Wire.commandResult(id, ok = false, data = null, error = describe(t)))
                    }
                }
            }
        }
    }

    private fun runAppTool(id: String, name: String, params: Map<String, Any?>): Boolean {
        val tools = appTools ?: return false
        val replied = AtomicBoolean(false)
        return try {
            tools.run(name, params) { data, error, changed ->
                if (replied.compareAndSet(false, true)) {
                    send(Wire.commandResult(id, ok = error == null, data = if (error == null) data else null, error = error))
                    if (changed) sendActions()
                }
            }
        } catch (t: Throwable) {
            if (replied.compareAndSet(false, true)) {
                send(Wire.commandResult(id, ok = false, data = null, error = describe(t)))
            }
            true
        }
    }

    private inline fun reply(id: String, block: () -> Any?) {
        try {
            send(Wire.commandResult(id, ok = true, data = block(), error = null))
        } catch (t: Throwable) {
            send(Wire.commandResult(id, ok = false, data = null, error = describe(t)))
        }
    }

    private fun describe(t: Throwable): String = t.message?.takeIf { it.isNotBlank() } ?: t.javaClass.simpleName

    private fun actionDescriptors(): List<Map<String, Any?>> {
        val extra = try {
            appTools?.descriptors().orEmpty()
        } catch (t: Throwable) {
            logger.warn("Could not list the app tools", t)
            emptyList()
        }
        return actions.descriptors(extra)
    }

    private fun sendActions() {
        val link = host
        if (link != null) {
            // The host owns hello.actions: it merges ours with its own and publishes the full list.
            try {
                link.actionsChanged(describeActionsJson())
            } catch (t: Throwable) {
                logger.warn("Could not hand the action list to Flutter", t)
            }
        } else {
            send(Wire.actions(actionDescriptors()))
        }
    }

    private fun dumpThreads(): Map<String, Any?> {
        val traces = Thread.getAllStackTraces()
        val sorted = traces.entries.sortedWith(compareBy({ it.key.name != "main" }, { it.key.name }))
        val text = StringBuilder()
        for ((thread, frames) in sorted) {
            text.append('"').append(thread.name).append("\" · ").append(thread.state)
            if (thread.isDaemon) text.append(" · daemon")
            text.append(" · priority ").append(thread.priority).append('\n')
            for (frame in frames) text.append("\tat ").append(frame).append('\n')
            text.append('\n')
        }
        log(Level.INFO, SDK_TAG, "Thread dump · ${traces.size} threads\n" + text.toString().trimEnd(), null, null)
        return linkedMapOf("threads" to traces.size)
    }

    private fun runGc(): Map<String, Any?> {
        val runtime = Runtime.getRuntime()
        val before = runtime.totalMemory() - runtime.freeMemory()
        runtime.gc()
        runtime.gc()
        val after = runtime.totalMemory() - runtime.freeMemory()
        val result = linkedMapOf<String, Any?>("beforeMB" to toMb(before), "afterMB" to toMb(after))
        log(Level.INFO, SDK_TAG, "Garbage collection: Java heap ${toMb(before)} MB → ${toMb(after)} MB", result, null)
        return result
    }

    private fun toMb(bytes: Long): Double = Math.round(bytes / 1024.0 / 1024.0 * 10.0) / 10.0

    /* ───────────── runtime config: metrics + logcat ───────────── */

    private fun applyRuntimeConfig() {
        if (stopped.get()) return
        if (options.captureMetrics) startMetrics(config.metricsIntervalMs)
        applyLogcat()
        webSocketHintIfNeeded()
    }

    /**
     * Standalone: reads this app's logcat while the desktop cannot read device logs. Hosted: reads it while the
     * host wants it (its in-app panel shows these lines with or without a desktop).
     */
    private fun applyLogcat() {
        if (stopped.get()) return
        val controller = logcat ?: return
        val hosted = hostDeviceLogs
        val read = options.captureLogcat && if (host != null) hosted.read else !config.deviceLogsAvailable
        val toDesktop = read && (host == null || hosted.desktop)
        if (toDesktop && logcatAnnounced.compareAndSet(false, true)) {
            send(
                Wire.log(
                    ts = env.nowMs(),
                    level = Level.INFO.wireName,
                    tag = SDK_TAG,
                    message = "The desktop cannot read this device's logs (no adb), so Dürbün forwards this app's " +
                        "own logcat over the SDK connection.",
                    kind = "text",
                ),
            )
        }
        try {
            controller.setEnabled(read)
        } catch (t: Throwable) {
            logger.warn("Could not switch logcat forwarding", t)
        }
    }

    private fun startMetrics(requestedIntervalMs: Long) {
        val sampler = metricsSampler ?: return
        val interval = requestedIntervalMs.coerceIn(MIN_METRICS_INTERVAL_MS, MAX_METRICS_INTERVAL_MS)
        synchronized(metricsLock) {
            if (stopped.get()) return
            if (metricsTask != null && metricsIntervalMs == interval) return
            metricsTask?.cancel(false)
            val executor = schedulerLocked()
            metricsIntervalMs = interval
            metricsTask = executor.scheduleWithFixedDelay(
                { sampleMetrics(sampler) },
                interval,
                interval,
                TimeUnit.MILLISECONDS,
            )
        }
    }

    /** Dürbün's one low-priority timer thread (metrics, delayed notes); created on first use. Under [metricsLock]. */
    private fun schedulerLocked(): ScheduledExecutorService =
        metricsExecutor ?: Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "durbun-metrics").apply {
                isDaemon = true
                priority = Thread.NORM_PRIORITY - 1
            }
        }.also { metricsExecutor = it }

    /**
     * Some time after start, when OkHttp is in the app but no client got [dev.durbun.DurbunInterceptor], one line
     * on the desktop says why the network list stays empty (standalone only: Flutter apps report through Dart).
     */
    private fun scheduleNetworkHint() {
        if (host != null || !options.captureNetwork || networkHintScheduled.getAndSet(true)) return
        val elapsedMs = (System.nanoTime() - startedAtNanos) / 1_000_000
        val delayMs = (networkHintAfterMs - elapsedMs).coerceAtLeast(0L)
        try {
            synchronized(metricsLock) {
                if (stopped.get()) return
                schedulerLocked().schedule({ networkHintIfNeeded() }, delayMs, TimeUnit.MILLISECONDS)
            }
        } catch (t: Throwable) {
            logger.warn("Could not schedule the network note", t)
        }
    }

    private fun networkHintIfNeeded() {
        try {
            if (stopped.get() || InterceptorUse.created || !okHttpPresent()) return
            val message = "No OkHttp client in this app has DurbunInterceptor yet, so its HTTP calls do not show up in " +
                "Dürbün. Add .addInterceptor(DurbunInterceptor()) to every OkHttpClient.Builder, including the ones " +
                "Retrofit, Coil, Glide or Ktor use. HttpURLConnection, Cronet and WebView traffic is not captured."
            logger.info(message)
            send(
                Wire.log(
                    ts = env.nowMs(),
                    level = Level.INFO.wireName,
                    tag = SDK_TAG,
                    message = message,
                    // Stable for the desktop, which can word the line in the viewer's language.
                    data = linkedMapOf("reason" to "noInterceptor", "afterMs" to networkHintAfterMs),
                    kind = "text",
                ),
            )
        } catch (t: Throwable) {
            logger.warn("Could not check the network capture", t)
        }
    }

    private fun stopMetrics() {
        synchronized(metricsLock) {
            metricsTask?.cancel(false)
            metricsTask = null
            metricsIntervalMs = 0L
        }
        try {
            metricsSampler?.pause()
        } catch (t: Throwable) {
            logger.warn("Could not pause metrics", t)
        }
    }

    private fun sampleMetrics(sampler: MetricsSampler) {
        try {
            if (!transport.isConnected) return
            val values = sampler.sample()
            if (values.isNotEmpty()) send(Wire.metric(env.nowMs(), values))
        } catch (t: Throwable) {
            if (metricsWarned.compareAndSet(false, true)) logger.warn("Metrics sampling failed", t)
        }
    }

    /* ───────────── hello / endpoints ───────────── */

    private fun endpoints(): List<Transport.Endpoint> {
        val port = basePort()
        val list = ArrayList<Transport.Endpoint>(3)
        list += Transport.Endpoint(LOOPBACK, port, 1_000)
        if (env.isEmulator) list += Transport.Endpoint(EMULATOR_HOST, port, 1_500)
        val lan = lanEndpoint()
        if (lan != null && list.none { it.host == lan.host && it.port == lan.port }) list += lan
        return list
    }

    private fun capabilities(): List<String> {
        val caps = mutableListOf("logs")
        // `streams`: it can send net.ws / net.sse; it still does only while config.captureStreams is true.
        if (options.captureNetwork) caps += listOf("network", "mocks", "streams")
        caps += listOf("events", "commands")
        if (options.captureCrashes) caps += "crash"
        if (options.captureMetrics && metricsSampler != null) caps += "metrics"
        return caps
    }

    private fun helloLine(): String = Wire.hello(
        sdkVersion = Durbun.VERSION,
        app = env.appInfo(),
        device = env.deviceHints(),
        session = sessionId,
        capabilities = capabilities(),
        actions = actionDescriptors(),
        ts = env.nowMs(),
    )

    companion object {
        const val SDK_TAG = "durbun"
        const val CRASH_TAG = "crash"
        const val FLUTTER_TAG = "flutter"
        const val LOOPBACK = "127.0.0.1"
        const val EMULATOR_HOST = "10.0.2.2"

        private const val MIN_BUFFERED = 100
        private const val MAX_BUFFERED = 100_000

        /** Character budget of the offline buffer (≈8–16 MB of memory at worst). */
        private const val MAX_BUFFER_CHARS = 8L * 1024 * 1024

        /** Bodies above this are always truncated, whatever the desktop asks (keeps frames < 16 MiB). */
        const val MAX_BODY_BYTES = 8 * 1024 * 1024

        /** Stream payloads are capped here whatever the desktop asks (a chatty socket must stay cheap). */
        const val MAX_STREAM_MESSAGE_BYTES = 1024 * 1024

        /** The desktop's own cap (min(maxBodyBytes, 64 KiB)), used when the app forces body capture on. */
        const val DEFAULT_STREAM_MESSAGE_BYTES = 64 * 1024

        private const val MIN_METRICS_INTERVAL_MS = 250L
        private const val MAX_METRICS_INTERVAL_MS = 60_000L
        private const val CRASH_CONNECT_WAIT_MS = 1_000L

        /** After this long without a first connection, logcat gets one line saying why and what to do. */
        const val CONSOLE_HINT_AFTER_MS = 10_000L

        /** Clients are usually built by the first screen; later than this, a missing interceptor is likely. */
        const val NETWORK_HINT_AFTER_MS = 30_000L

        private const val HOSTED_HINT =
            "The Flutter SDK owns the connection: its in-app panel explains it under Tools → Mac connection."
        private const val CRASH_FLUSH_WAIT_MS = 2_000L

        /** Hosted logcat lines waiting for the host (a burst at start-up replays the whole logcat buffer). */
        private const val DEVICE_LOG_BUFFER = 5_000
        private const val DEVICE_LOG_BUFFER_CHARS = 2L * 1024 * 1024
    }
}

/** Hosted mode: what the host wants of this app's logcat (`state.deviceLogs`). */
internal class HostDeviceLogs(
    /** Read it: the in-app panel shows it, or the desktop gets it. */
    val read: Boolean = false,
    /** The host sends these lines on to the desktop (it cannot read the device's logs itself). */
    val desktop: Boolean = false,
) {
    companion object {
        fun from(map: Map<String, Any?>, previous: HostDeviceLogs): HostDeviceLogs = HostDeviceLogs(
            read = map.bool("read") ?: previous.read,
            desktop = map.bool("desktop") ?: previous.desktop,
        )
    }
}
