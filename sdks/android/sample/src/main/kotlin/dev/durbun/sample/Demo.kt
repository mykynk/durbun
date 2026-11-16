package dev.durbun.sample

import android.os.Handler
import android.os.Looper
import dev.durbun.Durbun
import dev.durbun.Level
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import java.io.IOException

/** What the buttons (and the app's own Dürbün tools) do. Each result is shown on screen and in the Mac app. */
object Demo {
    @Volatile
    var verbose = false

    @Volatile
    var items = 3

    /** Receives one line per finished demo, on the main thread. */
    var onResult: ((String) -> Unit)? = null

    private val main = Handler(Looper.getMainLooper())
    private val base get() = SampleApp.server.baseUrl

    fun get200() = call("GET 200", Request.Builder().url("$base/json?items=$items").build())

    fun get404() = call("GET 404", Request.Builder().url("$base/missing").build())

    fun slow() = call("Slow (2 s)", Request.Builder().url("$base/slow?ms=2000").build())

    fun postJson() = call(
        "POST JSON",
        Request.Builder()
            .url("$base/echo")
            .header("Authorization", "Bearer sample-token") // masked by redactHeaders in SampleApp
            .post("""{"name":"Ada","plan":"premium","tags":["beta","ios","android"]}""".toRequestBody("application/json".toMediaType()))
            .build(),
    )

    /** Port 1 on the device: nothing listens there, so the call fails with ConnectException. */
    fun failing() = call("Failing (connection refused)", Request.Builder().url("http://127.0.0.1:1/unreachable").build())

    /** A real HTTPS call: the event listener factory adds DNS, connect and TLS times. */
    fun https() = call("HTTPS example.com", Request.Builder().url("https://example.com/").build())

    fun runAll() {
        get200(); get404(); slow(); postJson(); failing(); eventStream(); webSocket()
    }

    private fun call(label: String, request: Request) {
        if (verbose) Durbun.d("sample", "Starting $label", data = mapOf("url" to request.url.toString()))
        SampleApp.client.newCall(request).enqueue(object : Callback {
            override fun onResponse(call: Call, response: Response) {
                val size = response.use { it.body?.string()?.length ?: 0 }
                report("$label → ${response.code} · $size characters")
            }

            override fun onFailure(call: Call, e: IOException) {
                report("$label → ${e.javaClass.simpleName}: ${e.message}")
            }
        })
    }

    /**
     * Server-Sent Events over a plain call: the interceptor reports the response when the headers arrive, then
     * each event as the app reads it. No okhttp-sse needed.
     */
    fun eventStream() {
        val request = Request.Builder().url("$base/events").header("Accept", "text/event-stream").build()
        SampleApp.client.newCall(request).enqueue(object : Callback {
            override fun onResponse(call: Call, response: Response) {
                var events = 0
                response.use {
                    val source = it.body?.source() ?: return@use
                    while (true) {
                        val line = source.readUtf8Line() ?: break
                        if (line.startsWith("data:")) events++
                    }
                }
                report("Event stream → $events events")
            }

            override fun onFailure(call: Call, e: IOException) {
                report("Event stream → ${e.javaClass.simpleName}: ${e.message}")
            }
        })
    }

    /** A WebSocket opened through DurbunWebSocketFactory: every message in both directions shows up. */
    fun webSocket() {
        val request = Request.Builder().url("${base.replace("http://", "ws://")}/ws").build()
        SampleApp.webSockets.newWebSocket(request, object : WebSocketListener() {
            private var received = 0

            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send("hello")
                webSocket.send("""{"type":"subscribe","channel":"prices"}""")
                webSocket.send(ByteString.of(0x01, 0x02, 0x03, 0x04))
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                if (++received == 3) webSocket.close(1000, "done")
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                if (++received == 3) webSocket.close(1000, "done")
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                report("WebSocket → closed ($code), $received messages received")
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                report("WebSocket → ${t.javaClass.simpleName}: ${t.message}")
            }
        })
    }

    /** One line of each level; the error carries a throwable, so the Mac app shows its stack trace. */
    fun logEveryLevel() {
        Durbun.log(Level.VERBOSE, "sample", "A verbose line")
        Durbun.d("sample", "A debug line", data = mapOf("cache" to "warm", "entries" to 128))
        Durbun.i("auth", "User logged in", data = mapOf("userId" to 42, "plan" to "premium"))
        Durbun.w("sync", "Sync is slow", data = mapOf("ms" to 2300))
        Durbun.e("payment", "Payment failed", throwable = IllegalStateException("Card declined"))
        android.util.Log.i("SampleApp", "A plain logcat line (read by the Mac app over USB, forwarded by the SDK over Wi-Fi)")
        report("Logs → 5 Dürbün lines and 1 logcat line")
    }

    fun event() {
        Durbun.event("purchase", mapOf("amount" to 49.9, "currency" to "USD", "items" to 2))
        report("Event → purchase")
    }

    /** An uncaught exception on the main thread: the SDK reports it, then the app closes as usual. */
    fun crash(): Nothing = throw IllegalStateException("Crash button pressed in the Dürbün sample")

    private fun report(line: String) {
        main.post { onResult?.invoke(line) }
    }
}
