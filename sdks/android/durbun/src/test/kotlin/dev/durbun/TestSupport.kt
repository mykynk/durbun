package dev.durbun

import dev.durbun.internal.DurbunCore
import dev.durbun.internal.Environment
import dev.durbun.internal.InternalLogger
import dev.durbun.internal.Json
import dev.durbun.internal.LineReader
import dev.durbun.internal.Transport
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread

/** Fast timings so reconnect tests finish quickly. */
internal val FAST_TIMING = Transport.Timing(handshakeTimeoutMs = 2_000, idleTimeoutMs = 15_000, backoffStartMs = 50, backoffMaxMs = 200)

internal class RecordingLogger : InternalLogger {
    val lines: MutableList<String> = Collections.synchronizedList(ArrayList())

    override fun debug(message: String) {
        lines += "D $message"
    }

    override fun info(message: String) {
        lines += "I $message"
    }

    override fun warn(message: String, error: Throwable?) {
        lines += "W $message ${error ?: ""}"
    }
}

internal class FakeEnvironment(
    override val appId: String = "com.mykynk.pati",
    override val storageDir: File? = null,
    override val logger: InternalLogger = RecordingLogger(),
) : Environment {
    val mainThreadTasks = AtomicInteger()

    override fun appInfo(): Map<String, Any?> = linkedMapOf(
        "name" to "Pati",
        "id" to appId,
        "version" to "1.4.0",
        "build" to "140",
        "pid" to 4321,
        "processName" to appId,
        "debug" to true,
    )

    override fun deviceHints(): Map<String, Any?> = linkedMapOf(
        "platform" to "android",
        "model" to "Pixel 8",
        "manufacturer" to "Google",
        "name" to "Yusuf's Pixel",
        "osVersion" to "15",
        "apiLevel" to 35,
        "isPhysical" to true,
    )

    override val isEmulator: Boolean = false

    override fun currentTid(): Int = 4377

    override fun runOnMain(block: () -> Unit) {
        mainThreadTasks.incrementAndGet()
        block()
    }
}

/**
 * Minimal Dürbün desktop: accepts SDK connections, answers `hello` with `welcome` and records every
 * message it receives.
 */
internal class FakeDesktop(
    @Volatile var config: Map<String, Any?> = linkedMapOf(
        "captureBodies" to true,
        "maxBodyBytes" to 1_048_576,
        "metricsIntervalMs" to 1_000,
        "deviceLogsAvailable" to true,
    ),
    @Volatile var mocks: List<Map<String, Any?>> = emptyList(),
) : Closeable {
    private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    val port: Int get() = server.localPort

    private val received = CopyOnWriteArrayList<Map<String, Any?>>()
    val connections = AtomicInteger()

    /** When false, connections are closed right after `hello` (no welcome). */
    @Volatile
    var acceptHandshakes = true

    private val lock = Any()
    private var client: Socket? = null
    private var out: OutputStream? = null

    init {
        thread(isDaemon = true, name = "fake-desktop") {
            while (!server.isClosed) {
                val socket = try {
                    server.accept()
                } catch (_: IOException) {
                    break
                }
                connections.incrementAndGet()
                thread(isDaemon = true, name = "fake-desktop-conn") { serve(socket) }
            }
        }
    }

    private fun serve(socket: Socket) {
        try {
            socket.use {
                val reader = LineReader(socket.getInputStream())
                val hello = reader.readLine()?.let { Json.parseObject(it) } ?: return
                received += hello
                if (!acceptHandshakes) return
                synchronized(lock) {
                    client = socket
                    out = socket.getOutputStream()
                }
                send(
                    linkedMapOf(
                        "type" to "welcome",
                        "protocol" to 1,
                        "server" to "durbun/test",
                        "appId" to "app:1",
                        "config" to config,
                        "mocks" to mocks,
                    ),
                )
                while (true) {
                    val line = reader.readLine() ?: break
                    Json.parseObject(line)?.let { received += it }
                }
            }
        } catch (_: IOException) {
        }
    }

    fun send(message: Map<String, Any?>) {
        synchronized(lock) {
            val o = out ?: throw IllegalStateException("no SDK connected")
            o.write((Json.encode(message) + "\n").toByteArray(Charsets.UTF_8))
            o.flush()
        }
    }

    /** Drops the current SDK connection (the SDK should reconnect). */
    fun dropClient() {
        synchronized(lock) {
            client?.close()
            client = null
            out = null
        }
    }

    fun messages(type: String? = null): List<Map<String, Any?>> =
        received.filter { type == null || it["type"] == type }

    fun await(
        type: String,
        timeoutMs: Long = 5_000,
        predicate: (Map<String, Any?>) -> Boolean = { true },
    ): Map<String, Any?> {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            received.firstOrNull { it["type"] == type && predicate(it) }?.let { return it }
            Thread.sleep(10)
        }
        throw AssertionError("Timed out waiting for '$type'. Received: ${received.map { it["type"] }}")
    }

    fun awaitCount(type: String, count: Int, timeoutMs: Long = 5_000, predicate: (Map<String, Any?>) -> Boolean = { true }): List<Map<String, Any?>> {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            val matching = received.filter { it["type"] == type && predicate(it) }
            if (matching.size >= count) return matching
            Thread.sleep(10)
        }
        val matching = received.filter { it["type"] == type && predicate(it) }
        throw AssertionError("Expected $count '$type' messages, got ${matching.size}")
    }

    override fun close() {
        dropClient()
        server.close()
    }
}

internal fun startCore(
    desktop: FakeDesktop,
    options: DurbunOptions = DurbunOptions(),
    env: FakeEnvironment = FakeEnvironment(),
    configure: (DurbunCore) -> Unit = {},
): DurbunCore {
    val core = DurbunCore(options.copy(port = desktop.port), env, FAST_TIMING)
    configure(core)
    core.start()
    return core
}

@Suppress("UNCHECKED_CAST")
internal fun Map<String, Any?>.objAt(key: String): Map<String, Any?> = this[key] as Map<String, Any?>

@Suppress("UNCHECKED_CAST")
internal fun Map<String, Any?>.listAt(key: String): List<Any?> = this[key] as List<Any?>

internal fun headerValue(message: Map<String, Any?>, name: String): String? =
    message.listAt("headers").map { it as List<*> }.lastOrNull { (it[0] as String).equals(name, true) }?.get(1) as String?

/* ───────────── tiny HTTP/1.1 server for interceptor tests ───────────── */

internal class RecordedRequest(val method: String, val path: String, val headers: List<Pair<String, String>>, val body: ByteArray) {
    fun header(name: String): String? = headers.lastOrNull { it.first.equals(name, true) }?.second
}

internal class TestResponse(
    val status: Int = 200,
    val reason: String = "OK",
    val headers: List<Pair<String, String>> = emptyList(),
    val body: ByteArray = ByteArray(0),
    /** Streaming: send headers + body, then keep the socket open this long (no Content-Length). */
    val holdOpenMs: Long = 0,
)

internal class TestHttpServer(private val handler: (RecordedRequest) -> TestResponse) : Closeable {
    private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    val port: Int get() = server.localPort
    val requests = CopyOnWriteArrayList<RecordedRequest>()

    init {
        thread(isDaemon = true, name = "test-http") {
            while (!server.isClosed) {
                val socket = try {
                    server.accept()
                } catch (_: IOException) {
                    break
                }
                thread(isDaemon = true, name = "test-http-conn") { handle(socket) }
            }
        }
    }

    fun url(path: String) = "http://127.0.0.1:$port$path"

    private fun handle(socket: Socket) {
        try {
            socket.use {
                val input = BufferedInputStream(socket.getInputStream())
                val requestLine = readLine(input) ?: return
                val headers = ArrayList<Pair<String, String>>()
                while (true) {
                    val line = readLine(input) ?: return
                    if (line.isEmpty()) break
                    val i = line.indexOf(':')
                    headers += line.substring(0, i).trim() to line.substring(i + 1).trim()
                }
                val length = headers.lastOrNull { it.first.equals("Content-Length", true) }?.second?.toInt()
                val chunked = headers.any { it.first.equals("Transfer-Encoding", true) && it.second.contains("chunked", true) }
                val body = when {
                    length != null -> readExactly(input, length)
                    chunked -> readChunked(input)
                    else -> ByteArray(0)
                }
                val parts = requestLine.split(' ')
                val request = RecordedRequest(parts[0], parts[1], headers, body)
                requests += request
                val response = handler(request)
                val head = StringBuilder("HTTP/1.1 ${response.status} ${response.reason}\r\n")
                response.headers.forEach { head.append(it.first).append(": ").append(it.second).append("\r\n") }
                if (response.holdOpenMs <= 0 && response.headers.none { it.first.equals("Content-Length", true) }) {
                    head.append("Content-Length: ").append(response.body.size).append("\r\n")
                }
                head.append("Connection: close\r\n\r\n")
                val out = socket.getOutputStream()
                out.write(head.toString().toByteArray(Charsets.ISO_8859_1))
                out.write(response.body)
                out.flush()
                if (response.holdOpenMs > 0) Thread.sleep(response.holdOpenMs)
            }
        } catch (_: IOException) {
        }
    }

    private fun readLine(input: InputStream): String? {
        val buffer = ByteArrayOutputStream()
        while (true) {
            val b = input.read()
            if (b < 0) return if (buffer.size() == 0) null else buffer.toString("ISO-8859-1")
            if (b == '\n'.code) break
            if (b != '\r'.code) buffer.write(b)
        }
        return buffer.toString("ISO-8859-1")
    }

    private fun readExactly(input: InputStream, n: Int): ByteArray {
        val out = ByteArray(n)
        var read = 0
        while (read < n) {
            val r = input.read(out, read, n - read)
            if (r < 0) break
            read += r
        }
        return out
    }

    private fun readChunked(input: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        while (true) {
            val size = readLine(input)?.trim()?.substringBefore(';')?.toInt(16) ?: break
            if (size == 0) {
                readLine(input)
                break
            }
            out.write(readExactly(input, size))
            readLine(input)
        }
        return out.toByteArray()
    }

    override fun close() = server.close()
}
