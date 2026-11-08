package dev.durbun.internal

import java.io.BufferedOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import java.net.SocketTimeoutException

/**
 * NDJSON-over-TCP client for the Dürbün desktop.
 *
 * - One I/O thread connects (endpoints in order: adb-reverse loopback, emulator host alias, Wi-Fi host),
 *   sends `hello`, waits for `welcome`, then reads server messages until the connection drops.
 * - One writer thread drains the [OutboundQueue] into the active socket (flushes when the queue empties).
 * - Reconnects forever with backoff (0.5 s → 3 s) while started. Nothing here ever throws to the app.
 */
internal class Transport(
    private val endpoints: () -> List<Endpoint>,
    private val hello: () -> String,
    private val listener: Listener,
    private val queue: OutboundQueue,
    private val logger: InternalLogger,
    private val timing: Timing = Timing(),
) {
    class Endpoint(val host: String, val port: Int, val connectTimeoutMs: Int) {
        override fun toString(): String = "$host:$port"
    }

    class Timing(
        val handshakeTimeoutMs: Int = 5_000,
        /** The desktop pings every 15 s; this much silence means the link is dead. */
        val idleTimeoutMs: Int = 60_000,
        val backoffStartMs: Long = 500,
        val backoffMaxMs: Long = 3_000,
    )

    interface Listener {
        /** First thing the I/O thread does (one-off background work such as reading files). */
        fun onIoThreadStarted() = Unit

        /** `welcome` arrived (I/O thread). Runs before queued messages are flushed to the new connection. */
        fun onConnected(endpoint: Endpoint, welcome: Map<String, Any?>)

        /** Any other server message (I/O thread). */
        fun onMessage(message: Map<String, Any?>)

        fun onDisconnected(endpoint: Endpoint, reason: String)

        /** A full connect cycle failed; [attempt] counts consecutive failures. */
        fun onConnectFailed(attempt: Int) = Unit

        /** Encoded warning about [count] dropped messages, sent once the queue has drained. */
        fun droppedWarning(count: Long): String?

        /** Encoded `pong` for a `ping`. */
        fun pong(ping: Map<String, Any?>): String
    }

    private class Connection(val socket: Socket, val endpoint: Endpoint) {
        val reader = LineReader(socket.getInputStream())
        private val out = BufferedOutputStream(socket.getOutputStream(), 32 * 1024)

        @Volatile
        var closed = false
            private set

        fun write(line: String) {
            out.write(line.toByteArray(Charsets.UTF_8))
            out.write(NEWLINE)
        }

        fun flush() = out.flush()

        fun close() {
            closed = true
            try {
                socket.close()
            } catch (_: IOException) {
            }
        }
    }

    @Suppress("PLATFORM_CLASS_MAPPED_TO_KOTLIN")
    private val stateLock = java.lang.Object()

    @Volatile
    private var running = false

    @Volatile
    private var active: Connection? = null

    @Volatile
    private var attemptSocket: Socket? = null
    private var ioThread: Thread? = null
    private var writerThread: Thread? = null

    val isConnected: Boolean
        get() = active?.closed == false

    /** Endpoint of the live connection, if any. */
    val connectedEndpoint: Endpoint?
        get() = active?.takeIf { !it.closed }?.endpoint

    fun start() {
        synchronized(stateLock) {
            if (running) return
            running = true
            ioThread = startDaemonThread("durbun-io", logger, this::ioLoop)
            writerThread = startDaemonThread("durbun-writer", logger, this::writerLoop)
        }
    }

    fun stop() {
        val threads: List<Thread?>
        synchronized(stateLock) {
            if (!running) return
            running = false
            active?.close()
            active = null
            closeQuietly(attemptSocket)
            stateLock.notifyAll()
            threads = listOf(ioThread, writerThread)
            ioThread = null
            writerThread = null
        }
        threads.forEach { it?.interrupt() }
    }

    /** Blocks until a connection is active or [timeoutMs] passes (crash path). */
    fun awaitConnected(timeoutMs: Long): Boolean {
        val deadline = System.nanoTime() + timeoutMs * NANOS_PER_MS
        synchronized(stateLock) {
            while (running && !isConnected) {
                val remainingMs = (deadline - System.nanoTime()) / NANOS_PER_MS
                if (remainingMs <= 0) return false
                stateLock.wait(remainingMs)
            }
        }
        return isConnected
    }

    /** Blocks until everything queued so far reached the socket, or [timeoutMs] passes (crash path). */
    fun awaitDrained(timeoutMs: Long): Boolean {
        val deadline = System.nanoTime() + timeoutMs * NANOS_PER_MS
        while (System.nanoTime() < deadline) {
            if (!isConnected) return false
            if (queue.isDrained()) return true
            Thread.sleep(5)
        }
        return false
    }

    /* ───────────── I/O thread ───────────── */

    private fun ioLoop() {
        safely { listener.onIoThreadStarted() }
        var backoff = timing.backoffStartMs
        var failures = 0
        while (running) {
            val conn = connectAny()
            if (conn == null) {
                if (!running) break
                failures++
                safely { listener.onConnectFailed(failures) }
                pause(backoff)
                backoff = minOf(backoff * 2, timing.backoffMaxMs)
                continue
            }
            failures = 0
            backoff = timing.backoffStartMs
            val reason = try {
                readLoop(conn)
            } catch (t: Throwable) {
                t.toString()
            }
            synchronized(stateLock) {
                if (active === conn) active = null
                stateLock.notifyAll()
            }
            conn.close()
            safely { listener.onDisconnected(conn.endpoint, reason) }
            if (running) pause(timing.backoffStartMs)
        }
    }

    private fun connectAny(): Connection? {
        val candidates = try {
            endpoints()
        } catch (t: Throwable) {
            logger.warn("Could not compute Dürbün endpoints", t)
            emptyList()
        }
        for (endpoint in candidates) {
            if (!running) return null
            handshake(endpoint)?.let { return it }
        }
        return null
    }

    /** connect → hello → wait for welcome. Returns the activated connection, or null (socket closed). */
    private fun handshake(endpoint: Endpoint): Connection? {
        val socket = Socket()
        attemptSocket = socket
        var connection: Connection? = null
        try {
            if (!running) return null
            socket.tcpNoDelay = true
            socket.keepAlive = true
            socket.connect(InetSocketAddress(endpoint.host, endpoint.port), endpoint.connectTimeoutMs)
            socket.soTimeout = timing.handshakeTimeoutMs
            val conn = Connection(socket, endpoint)
            conn.write(hello())
            conn.flush()
            val deadline = System.nanoTime() + timing.handshakeTimeoutMs * NANOS_PER_MS
            while (running && System.nanoTime() < deadline) {
                val line = conn.reader.readLine() ?: break
                val message = Json.parseObject(line) ?: continue
                when (message.str("type")) {
                    "welcome" -> {
                        socket.soTimeout = timing.idleTimeoutMs
                        safely { listener.onConnected(endpoint, message) }
                        synchronized(stateLock) {
                            if (!running) return null
                            active = conn
                            stateLock.notifyAll()
                        }
                        connection = conn
                        return conn
                    }
                    "ping" -> {
                        conn.write(listener.pong(message))
                        conn.flush()
                    }
                }
            }
        } catch (_: IOException) {
            // refused / unreachable / timed out / reset: try the next endpoint
        } catch (e: SecurityException) {
            logger.warn("Cannot open a socket (is the INTERNET permission missing?)", e)
        } catch (e: RuntimeException) {
            logger.debug("Handshake with $endpoint failed: $e")
        } finally {
            attemptSocket = null
            if (connection == null) closeQuietly(socket)
        }
        return null
    }

    /** Reads server messages until the connection ends; returns a short human-readable reason. */
    private fun readLoop(conn: Connection): String {
        while (running && !conn.closed) {
            val line = try {
                conn.reader.readLine()
            } catch (_: SocketTimeoutException) {
                return "no data from the desktop for ${timing.idleTimeoutMs / 1000} s"
            } catch (e: IOException) {
                return if (conn.closed) "connection closed" else (e.message ?: e.javaClass.simpleName)
            } ?: return "closed by the desktop"
            if (line.isBlank()) continue
            val message = Json.parseObject(line) ?: continue
            if (message.str("type") == "ping") {
                queue.offerFirst(listener.pong(message))
            } else {
                safely { listener.onMessage(message) }
            }
        }
        return if (running) "connection closed" else "stopped"
    }

    /* ───────────── writer thread ───────────── */

    private fun writerLoop() {
        while (running) {
            val conn = awaitActive(1_000) ?: continue
            val line = queue.poll(1_000) ?: continue
            try {
                conn.write(line)
                if (queue.isEmpty()) {
                    conn.flush()
                    val dropped = queue.takeDropped()
                    if (dropped > 0) {
                        listener.droppedWarning(dropped)?.let {
                            conn.write(it)
                            conn.flush()
                        }
                    }
                }
                queue.markWritten()
            } catch (_: IOException) {
                queue.requeue(line) // retried first on the next connection
                conn.close() // the I/O thread notices and reconnects
            } catch (t: RuntimeException) {
                queue.markWritten()
                logger.warn("Dropped an unsendable message", t)
            }
        }
    }

    private fun awaitActive(timeoutMs: Long): Connection? {
        synchronized(stateLock) {
            val current = active
            if (current != null && !current.closed) return current
            if (running) stateLock.wait(timeoutMs)
            val next = active
            return if (next != null && !next.closed) next else null
        }
    }

    private fun pause(ms: Long) {
        synchronized(stateLock) {
            if (running) stateLock.wait(ms)
        }
    }

    private inline fun safely(block: () -> Unit) {
        try {
            block()
        } catch (t: Throwable) {
            if (t is InterruptedException) throw t
            logger.warn("Dürbün listener failed", t)
        }
    }

    private fun closeQuietly(socket: Socket?) {
        try {
            socket?.close()
        } catch (_: IOException) {
        }
    }

    private companion object {
        const val NEWLINE = 10
        const val NANOS_PER_MS = 1_000_000L
    }
}
