package dev.durbun

import dev.durbun.internal.DurbunCore
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.Proxy
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.Base64
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPOutputStream
import kotlin.concurrent.thread

/** WebSocket messages and Server-Sent Events (SPEC §6.1.1) against real OkHttp, local servers and a fake desktop. */
class StreamsTest {
    private lateinit var desktop: FakeDesktop
    private lateinit var sockets: TestWebSocketServer
    private var core: DurbunCore? = null
    private val closeables = ArrayList<Closeable>()

    @Before
    fun setUp() {
        desktop = FakeDesktop(config = streamsConfig(cap = 65_536))
        sockets = TestWebSocketServer()
    }

    @After
    fun tearDown() {
        Durbun.installForTesting(null)
        core?.stop()
        closeables.forEach { it.close() }
        sockets.close()
        desktop.close()
    }

    private fun streamsConfig(cap: Int, on: Boolean? = true): Map<String, Any?> {
        val config = linkedMapOf<String, Any?>(
            "captureBodies" to true,
            "maxBodyBytes" to 1_048_576,
            "metricsIntervalMs" to 1_000,
            "deviceLogsAvailable" to true,
        )
        if (on != null) {
            config["captureStreams"] = on
            config["maxStreamMessageBytes"] = cap
        }
        return config
    }

    private fun connect(options: DurbunOptions = DurbunOptions()): DurbunCore {
        val c = startCore(desktop, options)
        core = c
        Durbun.installForTesting(c)
        waitUntil { c.isConnected }
        return c
    }

    private fun client(interceptor: Boolean = true): OkHttpClient {
        val builder = OkHttpClient.Builder()
            .proxy(Proxy.NO_PROXY)
            .connectTimeout(3, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
        if (interceptor) builder.addInterceptor(DurbunInterceptor())
        return builder.build()
    }

    private fun waitUntil(timeoutMs: Long = 5_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (condition()) return
            Thread.sleep(10)
        }
        fail("condition not met in $timeoutMs ms")
    }

    private fun request(url: String) = Request.Builder().url(url).build()

    private fun wsOf(id: Any?) = desktop.messages("net.ws").filter { it["id"] == id }

    private fun sseOf(id: Any?) = desktop.messages("net.sse").filter { it["id"] == id }

    private fun describe(message: Map<String, Any?>) = "${message["dir"]} ${message["opcode"]}"

    private fun bodyData(message: Map<String, Any?>): Any? = (message["body"] as? Map<*, *>)?.get("data")

    private fun indexOf(predicate: (Map<String, Any?>) -> Boolean) = desktop.messages().indexOfFirst(predicate)

    /* ───────────── WebSockets ───────────── */

    @Test
    fun webSocketMessagesShareTheHandshakeEntry() {
        connect()
        val url = sockets.url("/chat?room=1")
        val listener = RecordingListener()
        val ws = DurbunWebSocketFactory(client()).newWebSocket(request(url), listener)
        listener.await { it == "open:101" }
        assertSame("the app's listener gets the socket the factory returned", ws, listener.sockets.first())
        assertEquals(url.replace("ws://", "http://"), ws.request().url.toString())

        assertTrue(ws.send("echo:merhaba"))
        listener.await { it == "text:merhaba" }
        assertTrue(ws.send(byteArrayOf(1, 2, 3).toByteString()))
        listener.await { it == "binary:010203" }
        assertTrue(ws.close(1000, "bitti"))
        listener.await { it.startsWith("closed:") }

        val handshake = desktop.await("net.request") { it["url"] == url }
        val id = handshake["id"]
        assertEquals("one entry for the connection", 1, desktop.messages("net.request").count { it["url"] == url })
        assertEquals("GET", handshake["method"])
        assertEquals("websocket", headerValue(handshake, "Upgrade"))
        val opened = desktop.await("net.response") { it["id"] == id }
        assertEquals(101L, opened["status"])
        assertNull("a factory socket (with the interceptor) never says noStream", opened["noStream"])

        val messages = desktop.awaitCount("net.ws", 6) { it["id"] == id }
        assertEquals(
            listOf("out text", "in text", "out binary", "in binary", "out close", "in close"),
            messages.map(::describe),
        )
        assertEquals("echo:merhaba", bodyData(messages[0]))
        assertEquals(12L, messages[0]["size"])
        assertEquals("merhaba", bodyData(messages[1]))
        assertEquals("AQID", bodyData(messages[2]))
        assertEquals("base64", messages[2].objAt("body")["encoding"])
        assertEquals(3L, messages[2]["size"])
        assertEquals(1000L, messages[4]["closeCode"])
        assertEquals("bitti", messages[4]["closeReason"])
        assertEquals(7L, messages[4]["size"])
        assertNull(messages[4]["body"])
        assertEquals(1000L, messages[5]["closeCode"])
        assertEquals("in", messages[5]["dir"])
        assertTrue(
            "messages come after the handshake",
            indexOf { it["type"] == "net.response" && it["id"] == id } < indexOf { it["type"] == "net.ws" && it["id"] == id },
        )
        Thread.sleep(200)
        assertEquals("the listener's own close() after the server's echo is not a frame", 6, wsOf(id).size)
    }

    @Test
    fun factoryWithoutInterceptorReportsTheHandshakeAndEarlyMessagesAfterIt() {
        connect()
        val url = sockets.url("/greet")
        val listener = RecordingListener()
        val ws = DurbunWebSocketFactory(client(interceptor = false)).newWebSocket(request(url), listener)
        assertTrue(ws.send("echo:erken")) // before the socket opened: OkHttp queues it
        listener.await { it == "text:erken" }

        val handshake = desktop.await("net.request") { it["url"] == url }
        val id = handshake["id"]
        assertEquals("okhttp", handshake["source"])
        assertEquals("websocket", headerValue(handshake, "Upgrade"))
        val response = desktop.await("net.response") { it["id"] == id }
        assertEquals(101L, response["status"])
        assertNull(response["body"])
        assertNull(response["noStream"])
        val messages = desktop.awaitCount("net.ws", 3) { it["id"] == id }
        assertEquals(listOf("out text", "in text", "in text"), messages.take(3).map(::describe))
        assertEquals(listOf("echo:erken", "hoş geldin", "erken"), messages.take(3).map(::bodyData))
        assertEquals(11L, messages[1]["size"]) // "hoş geldin" in UTF-8
        assertTrue(
            indexOf { it["type"] == "net.response" && it["id"] == id } < indexOf { it["type"] == "net.ws" && it["id"] == id },
        )
        ws.close(1000, null)
    }

    @Test
    fun continuationFramesAreOneMessage() {
        connect()
        val listener = RecordingListener()
        val ws = DurbunWebSocketFactory(client()).newWebSocket(request(sockets.url("/fragmented")), listener)
        listener.await { it == "text:parça mesaj" }
        val id = desktop.await("net.request") { it["url"] == sockets.url("/fragmented") }["id"]
        val message = desktop.await("net.ws") { it["id"] == id && it["dir"] == "in" }
        assertEquals("parça mesaj", bodyData(message))
        assertEquals(12L, message["size"])
        ws.close(1000, null)
    }

    @Test
    fun payloadsAreCutAtTheDesktopsCapAndSizesStayFull() {
        desktop.config = streamsConfig(cap = 8)
        val c = connect()
        val listener = RecordingListener()
        val ws = DurbunWebSocketFactory(client()).newWebSocket(request(sockets.url("/chat")), listener)
        listener.await { it == "open:101" }
        ws.send("echo:ğğğğğ")
        listener.await { it == "text:ğğğğğ" }
        ws.send(ByteArray(20) { it.toByte() }.toByteString())
        listener.await { it.startsWith("binary:") }
        val id = desktop.await("net.request") { it["url"] == sockets.url("/chat") }["id"]
        val messages = desktop.awaitCount("net.ws", 4) { it["id"] == id }
        val outText = messages[0].objAt("body")
        assertEquals("cut on a character boundary", "echo:ğ", outText["data"])
        assertEquals(true, outText["truncated"])
        assertEquals(15L, messages[0]["size"])
        assertEquals("ğğğğ", bodyData(messages[1]))
        val outBinary = messages[2].objAt("body")
        assertEquals(Base64.getEncoder().encodeToString(ByteArray(8) { it.toByte() }), outBinary["data"])
        assertEquals(true, outBinary["truncated"])
        assertEquals(20L, messages[2]["size"])

        // 0: sizes only.
        desktop.send(mapOf("type" to "config", "config" to streamsConfig(cap = 0)))
        waitUntil { c.maxStreamMessageBytes == 0 }
        ws.send("echo:boyut")
        listener.await { it == "text:boyut" }
        val sized = desktop.awaitCount("net.ws", 6) { it["id"] == id }.drop(4)
        assertEquals(listOf(10L, 5L), sized.map { it["size"] })
        assertTrue(sized.all { it["body"] == null })
        ws.close(1000, null)
    }

    @Test
    fun appOverrideTurnsPayloadsOff() {
        val c = connect(DurbunOptions(captureBodies = false))
        assertEquals(0, c.maxStreamMessageBytes)
        val listener = RecordingListener()
        val ws = DurbunWebSocketFactory(client()).newWebSocket(request(sockets.url("/chat")), listener)
        ws.send("echo:gizli")
        listener.await { it == "text:gizli" }
        val id = desktop.await("net.request") { it["url"] == sockets.url("/chat") }["id"]
        val messages = desktop.awaitCount("net.ws", 2) { it["id"] == id }
        assertTrue(messages.all { it["body"] == null && (it["size"] as Long) > 0 })
        ws.close(1000, null)
    }

    @Test
    fun messagesFollowTheLatestConfigOnly() {
        desktop.config = streamsConfig(cap = 0, on = null) // an older desktop: no captureStreams at all
        val c = connect()
        assertFalse(c.captureStreams)
        val url = sockets.url("/chat")
        val listener = RecordingListener()
        val ws = DurbunWebSocketFactory(client()).newWebSocket(request(url), listener)
        ws.send("echo:bir")
        listener.await { it == "text:bir" }
        // Off: the interceptor's entry is exactly what it was before streams existed (OkHttp's http:// URL).
        val plainUrl = url.replace("ws://", "http://")
        val id = desktop.await("net.request") { it["url"] == plainUrl }["id"]
        assertEquals("the handshake is always reported", 101L, desktop.await("net.response") { it["id"] == id }["status"])
        assertTrue(desktop.messages("net.request").none { it["url"] == url })

        desktop.send(mapOf("type" to "config", "config" to streamsConfig(cap = 65_536)))
        waitUntil { c.captureStreams }
        ws.send("echo:iki")
        listener.await { it == "text:iki" }
        val on = desktop.awaitCount("net.ws", 2) { it["id"] == id }
        assertEquals("nothing from before the change", listOf("echo:iki", "iki"), on.map(::bodyData))

        // A config without the field turns it off again, although the previous one had it on; the stream the
        // desktop already has still gets its close frames.
        desktop.send(mapOf("type" to "config", "config" to streamsConfig(cap = 0, on = null)))
        waitUntil { !c.captureStreams }
        ws.send("echo:üç")
        listener.await { it == "text:üç" }
        ws.close(1000, null)
        listener.await { it.startsWith("closed:") }
        val all = desktop.awaitCount("net.ws", 4) { it["id"] == id }
        assertEquals(listOf("out text", "in text", "out close", "in close"), all.map(::describe))
        Thread.sleep(200)
        assertEquals(4, wsOf(id).size)
        assertTrue(desktop.messages("net.ws").none { bodyData(it) == "echo:bir" || bodyData(it) == "echo:üç" })
    }

    @Test
    fun aSocketOnlyTheFactorySeesShowsUpWhenTheDesktopAsks() {
        desktop.config = streamsConfig(cap = 0, on = null)
        val c = connect()
        val url = sockets.url("/chat?quiet")
        val listener = RecordingListener()
        val ws = DurbunWebSocketFactory(client(interceptor = false)).newWebSocket(request(url), listener)
        ws.send("echo:sessiz")
        listener.await { it == "text:sessiz" }
        Thread.sleep(150)
        assertTrue("not reported at all while the desktop does not ask", desktop.messages("net.request").none { (it["url"] as String).contains("quiet") })

        desktop.send(mapOf("type" to "config", "config" to streamsConfig(cap = 65_536)))
        waitUntil { c.captureStreams }
        ws.send("echo:şimdi")
        listener.await { it == "text:şimdi" }
        val handshake = desktop.await("net.request") { it["url"] == url }
        val id = handshake["id"]
        val opened = desktop.await("net.response") { it["id"] == id }
        assertEquals(101L, opened["status"])
        assertNull("the factory's own handshake never says noStream", opened["noStream"])
        val messages = desktop.awaitCount("net.ws", 2) { it["id"] == id }
        assertEquals(listOf("echo:şimdi", "şimdi"), messages.map(::bodyData))
        assertTrue(indexOf { it["type"] == "net.response" && it["id"] == id } < indexOf { it["type"] == "net.ws" && it["id"] == id })

        desktop.send(mapOf("type" to "config", "config" to streamsConfig(cap = 0, on = false)))
        waitUntil { !c.captureStreams }
        ws.send("drop")
        listener.await { it.startsWith("failure:") }
        assertNull("the started stream still ends", desktop.await("net.error") { it["id"] == id }["cancelled"])
        assertEquals(2, wsOf(id).size)
    }

    @Test
    fun serverCloseAndBrokenConnection() {
        connect()
        val closing = RecordingListener()
        val first = DurbunWebSocketFactory(client()).newWebSocket(request(sockets.url("/chat?a")), closing)
        first.send("close")
        closing.await { it.startsWith("closed:") }
        val firstId = desktop.await("net.request") { it["url"] == sockets.url("/chat?a") }["id"]
        val closeFrames = desktop.awaitCount("net.ws", 3) { it["id"] == firstId }
        assertEquals(listOf("out text", "in close", "out close"), closeFrames.map(::describe))
        assertEquals(1001L, closeFrames[1]["closeCode"])
        assertEquals("bye", closeFrames[1]["closeReason"])
        assertEquals(5L, closeFrames[1]["size"])
        assertEquals(1001L, closeFrames[2]["closeCode"])
        assertNull(closeFrames[2]["closeReason"])
        assertTrue(desktop.messages("net.error").none { it["id"] == firstId })

        val dropping = RecordingListener()
        val second = DurbunWebSocketFactory(client()).newWebSocket(request(sockets.url("/chat?b")), dropping)
        second.send("drop")
        dropping.await { it.startsWith("failure:") }
        val secondId = desktop.await("net.request") { it["url"] == sockets.url("/chat?b") }["id"]
        val error = desktop.await("net.error") { it["id"] == secondId }
        assertNull("not cancelled by the app", error["cancelled"])
        assertTrue(
            indexOf { it["type"] == "net.ws" && it["id"] == secondId } < indexOf { it["type"] == "net.error" && it["id"] == secondId },
        )
    }

    @Test
    fun cancelReportsACancelledError() {
        connect()
        val listener = RecordingListener()
        val ws = DurbunWebSocketFactory(client()).newWebSocket(request(sockets.url("/chat")), listener)
        listener.await { it == "open:101" }
        ws.cancel()
        listener.await { it.startsWith("failure:") }
        val id = desktop.await("net.request") { it["url"] == sockets.url("/chat") }["id"]
        assertEquals(true, desktop.await("net.error") { it["id"] == id }["cancelled"])
    }

    @Test
    fun refusedUpgradeIsAnOrdinaryResponse() {
        connect()
        // Without the interceptor the factory reports it; with it, only the interceptor does (no duplicate).
        for ((path, interceptor) in listOf("/reject?plain" to false, "/reject?intercepted" to true)) {
            val listener = RecordingListener()
            DurbunWebSocketFactory(client(interceptor)).newWebSocket(request(sockets.url(path)), listener)
            listener.await { it.startsWith("failure:403") }
            val url = sockets.url(path)
            val id = desktop.await("net.request") { it["url"] == url }["id"]
            assertEquals(403L, desktop.await("net.response") { it["id"] == id }["status"])
            Thread.sleep(150)
            assertEquals(1, desktop.messages("net.request").count { it["url"] == url })
            assertTrue(desktop.messages("net.error").none { it["id"] == id })
            assertTrue(wsOf(id).isEmpty())
        }
    }

    @Test
    fun socketsOpenedWithoutTheFactoryShowTheHandshakeAndSayWhy() {
        connect()
        val client = client()
        repeat(2) { n ->
            val listener = RecordingListener()
            val ws = client.newWebSocket(request(sockets.url("/chat?n=$n")), listener)
            ws.send("echo:görünmez")
            listener.await { it == "text:görünmez" }
            val id = desktop.await("net.request") { it["url"] == sockets.url("/chat?n=$n") }["id"]
            val opened = desktop.await("net.response") { it["id"] == id }
            assertEquals(101L, opened["status"])
            assertEquals("no hook on its messages", true, opened["noStream"])
            ws.close(1000, null)
        }
        val hint = desktop.await("log") { (it["data"] as? Map<*, *>)?.get("reason") == "noWebSocketFactory" }
        assertTrue((hint["message"] as String).contains("DurbunWebSocketFactory"))
        Thread.sleep(150)
        assertEquals("said once", 1, desktop.messages("log").count { (it["data"] as? Map<*, *>)?.get("reason") == "noWebSocketFactory" })
        assertTrue(desktop.messages("net.ws").isEmpty())
    }

    @Test
    fun theDesktopsOwnSocketsAndIgnoredHostsAreLeftAlone() {
        val c = connect(DurbunOptions(ignoredHosts = listOf("localhost")))
        assertTrue(c.isDesktopEndpoint("127.0.0.1", desktop.port, "/"))
        assertTrue(c.isDesktopEndpoint("localhost", 9750, "/ui"))
        assertFalse(c.isDesktopEndpoint("api.example.com", 443, "/ui"))
        assertFalse(c.isDesktopEndpoint("127.0.0.1", 8080, "/api/users"))
        assertFalse("a plain request to /ui on a local server is the app's own", c.isDesktopEndpoint("localhost", 9750, "/ui", webSocket = false))
        assertTrue(c.isDesktopEndpoint("127.0.0.1", desktop.port, "/anything", webSocket = false))

        val own = RecordingListener()
        val ownSocket = DurbunWebSocketFactory(client()).newWebSocket(request(sockets.url("/ui")), own)
        own.await { it == "open:101" }
        assertTrue("the desktop's /ui socket is not wrapped", ownSocket.javaClass.name.startsWith("okhttp3."))
        ownSocket.send("echo:kendi")
        own.await { it == "text:kendi" }
        ownSocket.close(1000, null)

        val ignored = RecordingListener()
        val ignoredSocket = DurbunWebSocketFactory(client()).newWebSocket(
            request("ws://localhost:${sockets.port}/chat"),
            ignored,
        )
        ignored.await { it == "open:101" }
        assertTrue(ignoredSocket.javaClass.name.startsWith("okhttp3."))
        ignoredSocket.close(1000, null)
        Thread.sleep(200)
        assertTrue(desktop.messages("net.request").none { (it["url"] as String).contains("/ui") || (it["url"] as String).contains("localhost") })
        assertTrue(desktop.messages("net.ws").isEmpty())

        // The desktop's own SDK connection never shows up as a network entry either.
        assertTrue(desktop.messages("net.request").none { (it["url"] as String).contains(":${desktop.port}") })
    }

    @Test
    fun withoutDurbunTheFactoryIsTheDelegate() {
        val listener = RecordingListener()
        val ws = DurbunWebSocketFactory(client(interceptor = false)).newWebSocket(request(sockets.url("/chat")), listener)
        listener.await { it == "open:101" }
        assertSame(ws, listener.sockets.first())
        assertTrue(ws.javaClass.name.startsWith("okhttp3."))
        ws.close(1000, null)
    }

    @Test
    fun helloAnnouncesStreams() {
        connect()
        assertTrue(desktop.await("hello").listAt("capabilities").contains("streams"))
        val other = FakeDesktop()
        closeables += other
        val quiet = startCore(other, DurbunOptions(captureNetwork = false))
        try {
            assertFalse(other.await("hello").listAt("capabilities").contains("streams"))
        } finally {
            quiet.stop()
        }
    }

    /* ───────────── Server-Sent Events ───────────── */

    /** Event-stream bytes and where the server splits them: inside a line, a CRLF and UTF-8 characters. */
    private val sseText = ":merhaba\r\n" +
        "event: fiyat\r\nid: 7\r\nretry: 3000\r\ndata: {\"tl\":12}\r\ndata: ikinci satır\r\n\r\n" +
        "data: düz\n\n" +
        "id: 8\nevent: message\ndata\n\n" +
        "data:boşluksuz\r\r" +
        "data: yarım"

    private fun sseChunks(): List<ByteArray> {
        val bytes = sseText.toByteArray(Charsets.UTF_8)
        val cuts = ArrayList<Int>()
        fun after(marker: String, extraBytes: Int = 0) {
            val index = indexOfBytes(bytes, marker.toByteArray(Charsets.UTF_8))
            cuts += index + marker.toByteArray(Charsets.UTF_8).size + extraBytes
        }
        after("data: {\"tl\":") // inside a line
        after("12}\r") // between CR and LF
        after("sat", 1) // inside "ı" (2 bytes)
        after("bo", 1) // inside "ş"
        after("boşluksuz\r") // between the two CRs
        val chunks = ArrayList<ByteArray>()
        var start = 0
        for (cut in cuts.sorted()) {
            chunks += bytes.copyOfRange(start, cut)
            start = cut
        }
        chunks += bytes.copyOfRange(start, bytes.size)
        return chunks
    }

    private fun indexOfBytes(haystack: ByteArray, needle: ByteArray): Int {
        outer@ for (i in 0..haystack.size - needle.size) {
            for (j in needle.indices) if (haystack[i + j] != needle[j]) continue@outer
            return i
        }
        error("marker not found")
    }

    @Test
    fun sseEventsShareTheResponseEntryAndTheAppReadsEveryByte() {
        connect()
        val released = CountDownLatch(1)
        val chunks = sseChunks()
        val server = SseServer { out ->
            out.chunk(chunks[0])
            released.await(5, TimeUnit.SECONDS)
            chunks.drop(1).forEach { out.chunk(it); Thread.sleep(5) }
            out.end()
        }
        closeables += server
        val url = server.url("/events")
        client().newCall(request(url)).execute().use { response ->
            val id = desktop.await("net.request") { it["url"] == url }["id"]
            val reported = desktop.await("net.response") { it["id"] == id }
            assertEquals("headers are reported before the stream ends", 200L, reported["status"])
            assertNull("no body for an event stream", reported["body"])
            released.countDown()
            assertEquals("the app reads the stream unchanged", sseText, response.body!!.string())

            desktop.await("net.sse") { it["id"] == id && it["end"] == true }
            val events = sseOf(id)
            assertEquals(5, events.size)
            val first = events[0]
            assertEquals("fiyat", first["event"])
            assertEquals("7", first["eventId"])
            assertEquals(3000L, first["retry"])
            assertEquals("{\"tl\":12}\nikinci satır", bodyData(first))
            assertEquals("{\"tl\":12}\nikinci satır".toByteArray().size.toLong(), first["size"])
            assertEquals(null, events[1]["event"])
            assertEquals("düz", bodyData(events[1]))
            assertEquals("8", events[2]["eventId"])
            assertNull("\"message\" is the default event", events[2]["event"])
            assertEquals(0L, events[2]["size"])
            assertNull(events[2]["body"])
            assertEquals("boşluksuz", bodyData(events[3]))
            assertEquals(true, events[4]["end"])
            assertTrue("the cut-off last event is not sent", events.none { bodyData(it) == "yarım" })
            Thread.sleep(100)
            assertEquals("reported once", 1, desktop.messages("net.response").count { it["id"] == id })
            assertTrue(desktop.messages("net.error").none { it["id"] == id })
        }
    }

    @Test
    fun sseClosedByTheAppIsCancelled() {
        connect()
        val done = CountDownLatch(1)
        val server = SseServer { out ->
            out.chunk("data: ilk\n\n")
            done.await(5, TimeUnit.SECONDS)
        }
        closeables += server
        val url = server.url("/events")
        client().newCall(request(url)).execute().use { response ->
            val source = response.body!!.source()
            assertEquals("data: ilk", source.readUtf8Line())
            assertEquals("", source.readUtf8Line())
        }
        val id = desktop.await("net.request") { it["url"] == url }["id"]
        assertEquals("ilk", bodyData(desktop.await("net.sse") { it["id"] == id }))
        assertEquals(true, desktop.await("net.error") { it["id"] == id }["cancelled"])
        done.countDown()
        assertTrue(sseOf(id).none { it["end"] == true })
    }

    @Test
    fun sseBrokenByTheServerIsAnError() {
        connect()
        val server = SseServer { out ->
            out.chunk("data: tek\n\n")
            Thread.sleep(50)
            // returns without the last chunk: the connection closes mid-stream
        }
        closeables += server
        val url = server.url("/events")
        try {
            client().newCall(request(url)).execute().use { it.body!!.string() }
            fail("expected the read to fail")
        } catch (_: IOException) {
        }
        val id = desktop.await("net.request") { it["url"] == url }["id"]
        assertEquals("tek", bodyData(desktop.await("net.sse") { it["id"] == id }))
        val error = desktop.await("net.error") { it["id"] == id }
        assertNull(error["cancelled"])
        assertTrue(sseOf(id).none { it["end"] == true })
    }

    @Test
    fun sseEventsStartWithTheConfigAndAreCapped() {
        desktop.config = streamsConfig(cap = 0, on = false)
        val c = connect()
        val step = CountDownLatch(1)
        val server = SseServer { out ->
            out.chunk("data: önce\n\n")
            step.await(5, TimeUnit.SECONDS)
            out.chunk("data: ğğğğğ\n\n")
            out.end()
        }
        closeables += server
        val url = server.url("/events")
        client().newCall(request(url)).execute().use { response ->
            val source = response.body!!.source()
            assertEquals("data: önce", source.readUtf8Line())
            assertEquals("", source.readUtf8Line())
            desktop.send(mapOf("type" to "config", "config" to streamsConfig(cap = 8)))
            waitUntil { c.captureStreams }
            step.countDown()
            assertEquals("data: ğğğğğ\n\n", source.readUtf8())
        }
        val id = desktop.await("net.request") { it["url"] == url }["id"]
        desktop.await("net.sse") { it["id"] == id && it["end"] == true }
        val events = sseOf(id)
        assertEquals(2, events.size)
        val body = events[0].objAt("body")
        assertEquals("ğğğğ", body["data"])
        assertEquals(true, body["truncated"])
        assertEquals(10L, events[0]["size"])
    }

    @Test
    fun aStartedEventStreamAlwaysEnds() {
        val c = connect()
        val step = CountDownLatch(1)
        val server = SseServer { out ->
            out.chunk("data: bir\n\n")
            step.await(5, TimeUnit.SECONDS)
            out.chunk("data: iki\n\n")
            out.end()
        }
        closeables += server
        val url = server.url("/events")
        client().newCall(request(url)).execute().use { response ->
            val source = response.body!!.source()
            assertEquals("data: bir", source.readUtf8Line())
            desktop.send(mapOf("type" to "config", "config" to streamsConfig(cap = 0, on = null)))
            waitUntil { !c.captureStreams }
            step.countDown()
            source.readUtf8()
        }
        val id = desktop.await("net.request") { it["url"] == url }["id"]
        desktop.await("net.sse") { it["id"] == id && it["end"] == true }
        assertEquals(listOf("bir", null), sseOf(id).map(::bodyData))
    }

    @Test
    fun anEventStreamSeenWhileOffIsReportedAsBefore() {
        desktop.config = streamsConfig(cap = 0, on = null)
        connect()
        val server = SseServer { out ->
            out.chunk("data: x\n\n")
            out.end()
        }
        closeables += server
        val url = server.url("/events")
        client().newCall(request(url)).execute().use { it.body!!.string() }
        val id = desktop.await("net.request") { it["url"] == url }["id"]
        Thread.sleep(150)
        assertTrue(sseOf(id).isEmpty())
        assertTrue(desktop.messages("net.error").none { it["id"] == id })
    }

    @Test
    fun compressedEventStreamsKeepTheirHeadersOnly() {
        connect()
        val zipped = ByteArrayOutputStream().also { out -> GZIPOutputStream(out).use { it.write("data: x\n\n".toByteArray()) } }.toByteArray()
        val server = SseServer(listOf("Content-Encoding" to "gzip")) { out ->
            out.chunk(zipped)
            out.end()
        }
        closeables += server
        val url = server.url("/events")
        val call = Request.Builder().url(url).header("Accept-Encoding", "gzip").build()
        client().newCall(call).execute().use { assertEquals(zipped.size, it.body!!.bytes().size) }
        val id = desktop.await("net.request") { it["url"] == url }["id"]
        assertNull(desktop.await("net.response") { it["id"] == id }["body"])
        Thread.sleep(100)
        assertTrue(sseOf(id).isEmpty())
    }

    /* ───────────── test servers ───────────── */

    private class RecordingListener : WebSocketListener() {
        val events = CopyOnWriteArrayList<String>()
        val sockets = CopyOnWriteArrayList<WebSocket>()

        override fun onOpen(webSocket: WebSocket, response: Response) {
            sockets += webSocket
            events += "open:${response.code}"
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            sockets += webSocket
            events += "text:$text"
        }

        override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
            events += "binary:${bytes.hex()}"
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            events += "closing:$code:$reason"
            webSocket.close(code, null)
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            events += "closed:$code"
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            events += "failure:${response?.code}:${t.javaClass.simpleName}"
        }

        fun await(timeoutMs: Long = 5_000, predicate: (String) -> Boolean): String {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                events.firstOrNull(predicate)?.let { return it }
                Thread.sleep(10)
            }
            throw AssertionError("listener: timed out, got $events")
        }
    }

    /**
     * A minimal WebSocket server (RFC 6455, no extensions). Text "echo:X" → "X"; binary → echoed; "close" → a close
     * frame 1001 "bye"; "drop" → the connection is cut. `/greet` says hello first, `/fragmented` sends one message
     * in three frames, `/reject` refuses the upgrade with 403.
     */
    private class TestWebSocketServer : Closeable {
        private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
        val port: Int get() = server.localPort

        init {
            thread(isDaemon = true, name = "test-ws") {
                while (!server.isClosed) {
                    val socket = try {
                        server.accept()
                    } catch (_: IOException) {
                        break
                    }
                    thread(isDaemon = true, name = "test-ws-conn") { handle(socket) }
                }
            }
        }

        fun url(path: String) = "ws://127.0.0.1:$port$path"

        private fun handle(socket: Socket) {
            try {
                socket.use {
                    val input = BufferedInputStream(socket.getInputStream())
                    val out = socket.getOutputStream()
                    val (path, headers) = readHead(input) ?: return
                    if (path.startsWith("/reject")) {
                        out.write("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray())
                        out.flush()
                        return
                    }
                    val key = headers.lastOrNull { it.first.equals("Sec-WebSocket-Key", true) }?.second ?: return
                    val accept = Base64.getEncoder().encodeToString(
                        MessageDigest.getInstance("SHA-1").digest((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").toByteArray()),
                    )
                    out.write(
                        ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                            "Sec-WebSocket-Accept: $accept\r\n\r\n").toByteArray(),
                    )
                    out.flush()
                    if (path.startsWith("/greet")) frame(out, 0x1, "hoş geldin".toByteArray())
                    if (path.startsWith("/fragmented")) {
                        frame(out, 0x1, "par".toByteArray(), fin = false)
                        frame(out, 0x0, "ça ".toByteArray(), fin = false)
                        frame(out, 0x0, "mesaj".toByteArray())
                    }
                    var sentClose = false
                    while (true) {
                        val (opcode, payload) = readFrame(input) ?: return
                        when (opcode) {
                            0x1 -> {
                                val text = String(payload, Charsets.UTF_8)
                                when {
                                    text == "close" -> {
                                        frame(out, 0x8, byteArrayOf(0x03, 0xE9.toByte()) + "bye".toByteArray())
                                        sentClose = true
                                    }
                                    text == "drop" -> return
                                    text.startsWith("echo:") -> frame(out, 0x1, text.substring(5).toByteArray())
                                }
                            }
                            0x2 -> frame(out, 0x2, payload)
                            0x8 -> {
                                if (!sentClose) frame(out, 0x8, payload)
                                return
                            }
                            0x9 -> frame(out, 0xA, payload)
                        }
                    }
                }
            } catch (_: IOException) {
            }
        }

        /** Request path and headers. */
        private fun readHead(input: InputStream): Pair<String, List<Pair<String, String>>>? {
            val requestLine = readLine(input) ?: return null
            val headers = ArrayList<Pair<String, String>>()
            while (true) {
                val line = readLine(input) ?: return null
                if (line.isEmpty()) break
                val i = line.indexOf(':')
                headers += line.substring(0, i).trim() to line.substring(i + 1).trim()
            }
            return requestLine.split(' ')[1] to headers
        }

        private fun readLine(input: InputStream): String? {
            val buffer = ByteArrayOutputStream()
            while (true) {
                val b = input.read()
                if (b < 0) return null
                if (b == '\n'.code) break
                if (b != '\r'.code) buffer.write(b)
            }
            return buffer.toString("ISO-8859-1")
        }

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
            val mask = if (b1 and 0x80 != 0) ByteArray(4) { input.read().toByte() } else null
            val payload = ByteArray(length.toInt())
            var read = 0
            while (read < payload.size) {
                val n = input.read(payload, read, payload.size - read)
                if (n < 0) return null
                read += n
            }
            if (mask != null) for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
            return (b0 and 0x0F) to payload
        }

        @Synchronized
        private fun frame(out: OutputStream, opcode: Int, payload: ByteArray, fin: Boolean = true) {
            out.write((if (fin) 0x80 else 0) or opcode)
            when {
                payload.size < 126 -> out.write(payload.size)
                payload.size < 65_536 -> {
                    out.write(126)
                    out.write(payload.size shr 8)
                    out.write(payload.size and 0xFF)
                }
                else -> error("test frames stay small")
            }
            out.write(payload)
            out.flush()
        }

        override fun close() = server.close()
    }

    /** Writes a `text/event-stream` response in HTTP/1.1 chunks as [script] says; a script that never calls `end()` cuts it. */
    private class SseServer(
        private val extraHeaders: List<Pair<String, String>> = emptyList(),
        private val script: (Chunks) -> Unit,
    ) : Closeable {
        private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))

        class Chunks(private val out: OutputStream) {
            fun chunk(text: String) = chunk(text.toByteArray(Charsets.UTF_8))

            fun chunk(bytes: ByteArray) {
                out.write("${Integer.toHexString(bytes.size)}\r\n".toByteArray())
                out.write(bytes)
                out.write("\r\n".toByteArray())
                out.flush()
            }

            fun end() {
                out.write("0\r\n\r\n".toByteArray())
                out.flush()
            }
        }

        init {
            thread(isDaemon = true, name = "test-sse") {
                while (!server.isClosed) {
                    val socket = try {
                        server.accept()
                    } catch (_: IOException) {
                        break
                    }
                    thread(isDaemon = true, name = "test-sse-conn") {
                        try {
                            socket.use {
                                val input = BufferedInputStream(socket.getInputStream())
                                var blank = 0
                                // Skip the request head (ends with CRLF CRLF).
                                while (blank < 2) {
                                    val b = input.read()
                                    if (b < 0) return@use
                                    if (b == '\n'.code) blank++ else if (b != '\r'.code) blank = 0
                                }
                                val out = socket.getOutputStream()
                                val head = StringBuilder("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n")
                                extraHeaders.forEach { head.append(it.first).append(": ").append(it.second).append("\r\n") }
                                head.append("Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n")
                                out.write(head.toString().toByteArray())
                                out.flush()
                                script(Chunks(out))
                            }
                        } catch (_: IOException) {
                        }
                    }
                }
            }
        }

        fun url(path: String) = "http://127.0.0.1:${server.localPort}$path"

        override fun close() = server.close()
    }
}
