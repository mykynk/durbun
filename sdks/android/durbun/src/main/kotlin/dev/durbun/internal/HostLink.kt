package dev.durbun.internal

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Hosted mode: another SDK in the same process — the Flutter plugin (`package:durbun`) — owns the only
 * desktop connection. The core then opens no socket of its own: its encoded messages are handed to the host
 * (which sends them on its connection, in the same app session), and the desktop state (config, mock rules,
 * connection) comes from the host through [DurbunCore.applyHostState].
 */
internal interface HostLink {
    /** A batch of encoded messages (one JSON object each, no newline), called on the relay thread. */
    fun deliver(lines: List<String>)

    /**
     * A batch of this app's own logcat lines, encoded like [deliver]'s. The host shows them in its in-app panel
     * and sends them to the desktop only when the desktop cannot read the device's logs itself.
     */
    fun deliverDeviceLogs(lines: List<String>) = deliver(lines)

    /** The native action list changed (JSON array of `AppAction` descriptors); the host merges it with its own. */
    fun actionsChanged(descriptorsJson: String)
}

/** Desktop state as last reported by the host. */
internal class HostState(
    val connected: Boolean = false,
    /** Endpoint of the host's connection (`via: 'tcp host:port'`), used for crash reports. */
    val endpoint: Transport.Endpoint? = null,
    /** The host's `hello` (encoded), so a crash report can join the same app session. */
    val helloLine: String? = null,
) {
    companion object {
        /** `"tcp 127.0.0.1:9751"` → endpoint; null for anything else (e.g. `usbmux …`). */
        fun parseVia(via: String?): Transport.Endpoint? {
            val text = via?.trim() ?: return null
            if (!text.startsWith("tcp ")) return null
            val address = text.removePrefix("tcp ").trim()
            val colon = address.lastIndexOf(':')
            if (colon <= 0 || colon == address.length - 1) return null
            val host = address.substring(0, colon).removePrefix("[").removeSuffix("]")
            val port = address.substring(colon + 1).toIntOrNull() ?: return null
            if (host.isEmpty() || port !in 1..65535) return null
            return Transport.Endpoint(host, port, 1_000)
        }
    }
}

/**
 * Drains the core's [OutboundQueue] into the [HostLink] in small batches on one daemon thread. The queue keeps
 * its normal semantics (bounded, oldest dropped first), so a slow or busy host never grows memory.
 *
 * With a [handledBarrier] at most one batch is in flight: the barrier queues a marker behind the host's own work
 * for the batch (the Flutter plugin posts each batch to the main looper, so the barrier posts there too), and the
 * next batch waits until that marker ran. While the main thread is stalled, messages stay in the bounded queue
 * instead of piling up as main-looper messages.
 */
internal class HostRelay(
    private val queue: OutboundQueue,
    private val link: HostLink,
    private val logger: InternalLogger,
    private val onStart: () -> Unit,
    private val batchIntervalMs: Long = 40,
    private val threadName: String = "durbun-relay",
    private val deliver: (List<String>) -> Unit = link::deliver,
    /** Runs the given marker after the host handled the batch; returns false when it cannot (marker dropped). */
    private val handledBarrier: ((Runnable) -> Boolean)? = null,
) {
    @Volatile
    private var running = false
    private var thread: Thread? = null

    @Synchronized
    fun start() {
        if (running) return
        running = true
        thread = startDaemonThread(threadName, logger, this::loop)
    }

    @Synchronized
    fun stop() {
        running = false
        thread?.interrupt()
        thread = null
    }

    private fun loop() {
        try {
            onStart()
        } catch (t: Throwable) {
            logger.warn("Dürbün relay start-up work failed", t)
        }
        while (running) {
            val first = queue.poll(1_000) ?: continue
            queue.markWritten()
            val batch = ArrayList<String>(32)
            batch += first
            var chars = first.length.toLong()
            while (batch.size < MAX_BATCH_LINES && chars < MAX_BATCH_CHARS) {
                val next = queue.poll(0) ?: break
                queue.markWritten()
                batch += next
                chars += next.length
            }
            try {
                deliver(batch)
            } catch (t: Throwable) {
                logger.warn("Dürbün could not hand messages to the Flutter side", t)
            }
            if (!awaitHandled()) break
            if (!running) break
            try {
                Thread.sleep(batchIntervalMs)
            } catch (_: InterruptedException) {
                break
            }
        }
    }

    /** Waits until the host handled the last batch (no-op without a barrier). False when stopped meanwhile. */
    private fun awaitHandled(): Boolean {
        val barrier = handledBarrier ?: return true
        val handled = CountDownLatch(1)
        val queued = try {
            barrier(Runnable { handled.countDown() })
        } catch (t: Throwable) {
            logger.warn("Dürbün could not queue its relay marker", t)
            false
        }
        if (!queued) return true
        try {
            while (running && !handled.await(1, TimeUnit.SECONDS)) Unit
        } catch (_: InterruptedException) {
            return false
        }
        return running
    }

    private companion object {
        const val MAX_BATCH_LINES = 256
        const val MAX_BATCH_CHARS = 512L * 1024
    }
}

/**
 * Last-resort delivery of a crash report in hosted mode: the process is about to die and the host (Dart) may
 * not get to run again — a crash on the main thread blocks it — so the report goes straight to the desktop on
 * a short-lived connection that presents the host's own `hello` (same `session`, so the desktop files it under
 * the same app session). Returns true once the line was written after a `welcome`.
 */
internal object EmergencyDelivery {
    /**
     * [deliver] on a short-lived thread of its own, waited for at most [waitMs]: the crashing thread may be the
     * main thread, where Android forbids network I/O (NetworkOnMainThreadException).
     */
    fun deliverOffThread(
        endpoint: Transport.Endpoint,
        helloLine: String,
        line: String,
        waitMs: Long = 3_500,
        connectTimeoutMs: Int = 1_000,
        handshakeTimeoutMs: Int = 1_500,
    ): Boolean {
        val delivered = AtomicBoolean(false)
        val worker = Thread({
            try {
                delivered.set(deliver(endpoint, helloLine, line, connectTimeoutMs, handshakeTimeoutMs))
            } catch (_: Throwable) {
            }
        }, "durbun-crash-report")
        worker.isDaemon = true
        return try {
            worker.start()
            worker.join(waitMs)
            delivered.get()
        } catch (_: InterruptedException) {
            Thread.currentThread().interrupt()
            delivered.get()
        } catch (_: Throwable) {
            false
        }
    }

    fun deliver(
        endpoint: Transport.Endpoint,
        helloLine: String,
        line: String,
        connectTimeoutMs: Int = 1_000,
        handshakeTimeoutMs: Int = 1_500,
    ): Boolean {
        val socket = Socket()
        try {
            socket.tcpNoDelay = true
            socket.connect(InetSocketAddress(endpoint.host, endpoint.port), connectTimeoutMs)
            socket.soTimeout = handshakeTimeoutMs
            val out = socket.getOutputStream()
            out.write((helloLine + "\n").toByteArray(Charsets.UTF_8))
            out.flush()
            val reader = LineReader(socket.getInputStream())
            val deadline = System.nanoTime() + handshakeTimeoutMs * 1_000_000L
            var welcomed = false
            while (!welcomed && System.nanoTime() < deadline) {
                val text = reader.readLine() ?: return false
                if (Json.parseObject(text)?.str("type") == "welcome") welcomed = true
            }
            if (!welcomed) return false
            out.write((line + "\n").toByteArray(Charsets.UTF_8))
            out.flush()
            // Half-close and read until the desktop closes (or briefly), so closing cannot reset the connection
            // before the desktop has read the report.
            try {
                socket.shutdownOutput()
                socket.soTimeout = 300
                while (reader.readLine() != null) Unit
            } catch (_: IOException) {
            }
            return true
        } catch (_: IOException) {
            return false
        } catch (_: RuntimeException) {
            return false
        } finally {
            try {
                socket.close()
            } catch (_: IOException) {
            }
        }
    }
}
