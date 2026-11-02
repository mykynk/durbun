package dev.durbun.internal

import dev.durbun.Durbun
import dev.durbun.DurbunAction
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
 */
internal class DurbunCore(
    val options: DurbunOptions,
    private val env: Environment,
    timing: Transport.Timing = Transport.Timing(),
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

    private val metricsLock = Any()
    private var metricsExecutor: ScheduledExecutorService? = null
    private var metricsTask: ScheduledFuture<*>? = null
    private var metricsIntervalMs = 0L

    val isConnected: Boolean get() = transport.isConnected

    /** Effective body capture switch (app override wins over the desktop setting). */
    val captureBodies: Boolean get() = options.captureBodies ?: config.captureBodies

    /** Effective per-body capture limit in bytes. */
    val maxBodyBytes: Int get() = (options.maxBodyBytes ?: config.maxBodyBytes).coerceIn(0, MAX_BODY_BYTES)

    fun start() {
        transport.start()
    }

    fun stop() {
        if (!stopped.compareAndSet(false, true)) return
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
    }

    /** Encoded message → outgoing queue (dropped when stopped). */
    fun send(line: String) {
        if (!stopped.get()) queue.offer(line)
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

    /** A line from this app's own logcat (only while the desktop has no device logs). */
    fun forwardLogcat(ts: Long, level: Level, tag: String, message: String, tid: Int?) {
        if (stopped.get()) return
        if (recentLogs.isDuplicate(level.wireName, message, ts)) return
        send(Wire.log(ts = ts, level = level.wireName, tag = tag, message = message, kind = "text", tid = tid))
    }

    fun addAction(action: DurbunAction) {
        actions.add(action)
        if (isConnected) sendActions()
    }

    fun removeAction(id: String) {
        if (actions.remove(id) && isConnected) sendActions()
    }

    /* ───────────── network capture support ───────────── */

    fun nextRequestId(): String = "okhttp-" + requestSeq.incrementAndGet()

    fun findMock(method: String, url: String): MockRule? = MockMatcher.find(mockRules, method, url, env.appId)

    /* ───────────── crashes ───────────── */

    /**
     * Sends a crash report and gives it a moment to reach the desktop (the process dies right after).
     * Stored on disk when it cannot be delivered, and sent on the next launch.
     */
    fun reportCrash(thread: Thread, error: Throwable) {
        val line = Wire.log(
            ts = env.nowMs(),
            level = Level.FATAL.wireName,
            tag = CRASH_TAG,
            message = "FATAL EXCEPTION in thread \"${thread.name}\": $error",
            data = linkedMapOf("thread" to thread.name, "threadId" to threadIdOf(thread)),
            error = Wire.errorInfo(error),
            kind = "crash",
            tid = env.currentTid(),
        )
        send(line)
        val delivered = try {
            val connected = transport.isConnected || transport.awaitConnected(CRASH_CONNECT_WAIT_MS)
            connected && transport.awaitDrained(CRASH_FLUSH_WAIT_MS)
        } catch (_: InterruptedException) {
            false
        }
        if (!delivered) crashStore?.save(line)
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
        crashStore?.drain()?.forEach(this::sendPreviousCrash)
    }

    override fun onConnected(endpoint: Transport.Endpoint, welcome: Map<String, Any?>) {
        welcome.obj("config")?.let { config = SdkConfig.from(it, config) }
        mockRules = MockRule.listFromJson(welcome.list("mocks"))
        serverAppId = welcome.str("appId")
        logger.info("Connected to the Dürbün desktop via $endpoint (${welcome.str("server") ?: "unknown server"})")
        applyRuntimeConfig()
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
        logger.info("Disconnected from the Dürbün desktop ($reason); reconnecting…")
        stopMetrics()
    }

    override fun onConnectFailed(attempt: Int) {
        if (attempt == 1) {
            logger.info("Waiting for the Dürbün desktop on ${endpoints().joinToString()} …")
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

    private inline fun reply(id: String, block: () -> Any?) {
        try {
            send(Wire.commandResult(id, ok = true, data = block(), error = null))
        } catch (t: Throwable) {
            send(Wire.commandResult(id, ok = false, data = null, error = describe(t)))
        }
    }

    private fun describe(t: Throwable): String = t.message?.takeIf { it.isNotBlank() } ?: t.javaClass.simpleName

    private fun sendActions() = send(Wire.actions(actions.descriptors()))

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
        val controller = logcat ?: return
        val forward = options.captureLogcat && !config.deviceLogsAvailable
        if (forward && logcatAnnounced.compareAndSet(false, true)) {
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
            controller.setEnabled(forward)
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
            val executor = metricsExecutor ?: Executors.newSingleThreadScheduledExecutor { runnable ->
                Thread(runnable, "durbun-metrics").apply {
                    isDaemon = true
                    priority = Thread.NORM_PRIORITY - 1
                }
            }.also { metricsExecutor = it }
            metricsIntervalMs = interval
            metricsTask = executor.scheduleWithFixedDelay(
                { sampleMetrics(sampler) },
                interval,
                interval,
                TimeUnit.MILLISECONDS,
            )
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
        val port = if (options.port in 1..65535) options.port else DurbunOptions.DEFAULT_PORT
        val list = ArrayList<Transport.Endpoint>(3)
        list += Transport.Endpoint(LOOPBACK, port, 1_000)
        if (env.isEmulator) list += Transport.Endpoint(EMULATOR_HOST, port, 1_500)
        val host = options.host?.trim()
        if (!host.isNullOrEmpty() && list.none { it.host == host } && host != "localhost") {
            list += Transport.Endpoint(host, port, 2_500)
        }
        return list
    }

    private fun capabilities(): List<String> {
        val caps = mutableListOf("logs", "network", "mocks", "events", "commands")
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
        actions = actions.descriptors(),
        ts = env.nowMs(),
    )

    companion object {
        const val SDK_TAG = "durbun"
        const val CRASH_TAG = "crash"
        const val LOOPBACK = "127.0.0.1"
        const val EMULATOR_HOST = "10.0.2.2"

        private const val MIN_BUFFERED = 100
        private const val MAX_BUFFERED = 100_000

        /** Character budget of the offline buffer (≈8–16 MB of memory at worst). */
        private const val MAX_BUFFER_CHARS = 8L * 1024 * 1024

        /** Bodies above this are always truncated, whatever the desktop asks (keeps frames < 16 MiB). */
        const val MAX_BODY_BYTES = 8 * 1024 * 1024

        private const val MIN_METRICS_INTERVAL_MS = 250L
        private const val MAX_METRICS_INTERVAL_MS = 60_000L
        private const val CRASH_CONNECT_WAIT_MS = 1_000L
        private const val CRASH_FLUSH_WAIT_MS = 2_000L
    }
}
