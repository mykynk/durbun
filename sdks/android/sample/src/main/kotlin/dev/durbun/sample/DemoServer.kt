package dev.durbun.sample

import android.util.Base64
import java.io.BufferedInputStream
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.URLDecoder
import java.security.MessageDigest
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * A tiny HTTP server inside the sample app, on `127.0.0.1` and a free port, so every demo works offline and gives
 * the same answers each time. It is not part of the SDK and not a pattern to copy: it only gives the requests
 * something to talk to.
 *
 * | Path | Answer |
 * |---|---|
 * | `GET /json?items=N` | 200, a JSON list of N items |
 * | `GET /missing` | 404 with a JSON error |
 * | `GET /slow?ms=N` | 200 after N milliseconds (at most 10 s) |
 * | `POST /echo` | 200, the request body back |
 * | `GET /events` | `text/event-stream`: five events, 400 ms apart |
 * | `GET /ws` | a WebSocket that answers every text message with `echo: <text>` |
 * | `GET /page` | the HTML page of the web view screen |
 */
class DemoServer private constructor(private val socket: ServerSocket) {
    val port: Int get() = socket.localPort
    val baseUrl: String get() = "http://127.0.0.1:$port"

    private val workers: ExecutorService = Executors.newFixedThreadPool(4) { task ->
        Thread(task, "demo-server").apply { isDaemon = true }
    }

    private fun acceptLoop() {
        Thread({
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (_: Exception) {
                    break
                }
                workers.execute { serve(client) }
            }
        }, "demo-server-accept").apply { isDaemon = true }.start()
    }

    private class Request(val method: String, val path: String, val query: Map<String, String>, val headers: Map<String, String>, val body: ByteArray)

    private fun serve(client: Socket) {
        client.use { socket ->
            try {
                socket.soTimeout = 30_000
                val input = BufferedInputStream(socket.getInputStream())
                val output = socket.getOutputStream()
                val request = readRequest(input) ?: return
                route(request, input, output)
            } catch (_: Exception) {
                // The client went away: nothing to do.
            }
        }
    }

    private fun route(request: Request, input: InputStream, output: OutputStream) {
        when (request.path) {
            "/json" -> {
                val count = request.query["items"]?.toIntOrNull()?.coerceIn(1, 2_000) ?: 3
                val items = (1..count).joinToString(",") { """{"id":$it,"name":"Item $it","price":${it * 10 + 0.5}}""" }
                respond(output, 200, "OK", "application/json", """{"items":[$items],"count":$count}""")
            }
            "/missing" -> respond(output, 404, "Not Found", "application/json", """{"error":"not_found","message":"No such item"}""")
            "/slow" -> {
                val ms = request.query["ms"]?.toLongOrNull()?.coerceIn(0, 10_000) ?: 2_000
                Thread.sleep(ms)
                respond(output, 200, "OK", "application/json", """{"waitedMs":$ms}""")
            }
            "/echo" -> respond(output, 200, "OK", request.headers["content-type"] ?: "application/octet-stream", request.body)
            "/events" -> events(output)
            "/ws" -> webSocket(request, input, output)
            "/page" -> respond(output, 200, "OK", "text/html; charset=utf-8", WebPage.html)
            else -> respond(output, 404, "Not Found", "text/plain", "Not found")
        }
    }

    private fun respond(output: OutputStream, status: Int, reason: String, type: String, body: String) =
        respond(output, status, reason, type, body.toByteArray())

    private fun respond(output: OutputStream, status: Int, reason: String, type: String, body: ByteArray) {
        val head = "HTTP/1.1 $status $reason\r\nContent-Type: $type\r\nContent-Length: ${body.size}\r\n" +
            "X-Demo-Server: durbun-sample\r\nConnection: close\r\n\r\n"
        output.write(head.toByteArray())
        output.write(body)
        output.flush()
    }

    private fun events(output: OutputStream) {
        output.write("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n".toByteArray())
        output.flush()
        for (i in 1..5) {
            Thread.sleep(400)
            output.write("id: $i\nevent: tick\ndata: {\"tick\":$i,\"of\":5}\n\n".toByteArray())
            output.flush()
        }
    }

    // ───────────── WebSocket (RFC 6455, just enough for the demo) ─────────────

    private fun webSocket(request: Request, input: InputStream, output: OutputStream) {
        val key = request.headers["sec-websocket-key"]
        if (key == null || !request.headers["upgrade"].equals("websocket", ignoreCase = true)) {
            respond(output, 400, "Bad Request", "text/plain", "Expected a WebSocket upgrade")
            return
        }
        val digest = MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray())
        val accept = Base64.encodeToString(digest, Base64.NO_WRAP)
        output.write(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n".toByteArray(),
        )
        output.flush()
        writeFrame(output, 0x1, "connected to the demo server".toByteArray())
        while (true) {
            val frame = readFrame(input) ?: return
            when (frame.first) {
                0x1 -> writeFrame(output, 0x1, ("echo: " + String(frame.second)).toByteArray())
                0x2 -> writeFrame(output, 0x2, frame.second)
                0x8 -> {
                    writeFrame(output, 0x8, frame.second)
                    return
                }
                0x9 -> writeFrame(output, 0xA, frame.second)
            }
        }
    }

    /** One client frame (opcode, unmasked payload); fragmented messages are not used by the demo. */
    private fun readFrame(input: InputStream): Pair<Int, ByteArray>? {
        val b0 = input.read()
        val b1 = input.read()
        if (b0 < 0 || b1 < 0) return null
        var length = (b1 and 0x7F).toLong()
        if (length == 126L) length = ((input.read() shl 8) or input.read()).toLong()
        if (length == 127L) {
            length = 0
            repeat(8) { length = (length shl 8) or input.read().toLong() }
        }
        if (length > 1_000_000) return null
        val mask = if (b1 and 0x80 != 0) ByteArray(4).also { readFully(input, it) } else null
        val payload = ByteArray(length.toInt())
        readFully(input, payload)
        if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
        return (b0 and 0x0F) to payload
    }

    private fun writeFrame(output: OutputStream, opcode: Int, payload: ByteArray) {
        output.write(0x80 or opcode)
        when {
            payload.size < 126 -> output.write(payload.size)
            payload.size < 65_536 -> {
                output.write(126)
                output.write(payload.size shr 8)
                output.write(payload.size and 0xFF)
            }
            else -> {
                output.write(127)
                for (shift in 56 downTo 0 step 8) output.write(((payload.size.toLong() shr shift) and 0xFF).toInt())
            }
        }
        output.write(payload)
        output.flush()
    }

    // ───────────── HTTP/1.1 request parsing ─────────────

    private fun readRequest(input: InputStream): Request? {
        val requestLine = readLine(input) ?: return null
        val parts = requestLine.split(" ")
        if (parts.size < 2) return null
        val headers = HashMap<String, String>()
        while (true) {
            val line = readLine(input) ?: return null
            if (line.isEmpty()) break
            val colon = line.indexOf(':')
            if (colon > 0) headers[line.substring(0, colon).trim().lowercase()] = line.substring(colon + 1).trim()
        }
        val length = headers["content-length"]?.toIntOrNull()?.coerceIn(0, 4_000_000) ?: 0
        val body = ByteArray(length).also { readFully(input, it) }
        val target = parts[1]
        val path = target.substringBefore('?')
        val query = target.substringAfter('?', "").split('&').filter { '=' in it }.associate {
            URLDecoder.decode(it.substringBefore('='), "UTF-8") to URLDecoder.decode(it.substringAfter('='), "UTF-8")
        }
        return Request(parts[0], path, query, headers, body)
    }

    private fun readLine(input: InputStream): String? {
        val sb = StringBuilder()
        while (true) {
            val c = input.read()
            if (c < 0) return if (sb.isEmpty()) null else sb.toString()
            if (c == '\n'.code) return sb.toString().trimEnd('\r')
            if (sb.length > 16_384) return null
            sb.append(c.toChar())
        }
    }

    private fun readFully(input: InputStream, into: ByteArray) {
        var read = 0
        while (read < into.size) {
            val n = input.read(into, read, into.size - read)
            if (n < 0) throw java.io.EOFException()
            read += n
        }
    }

    companion object {
        /** Binds `127.0.0.1` on a free port (a quick local call) and serves on background threads. */
        fun start(): DemoServer {
            val socket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
            return DemoServer(socket).also { it.acceptLoop() }
        }
    }
}
