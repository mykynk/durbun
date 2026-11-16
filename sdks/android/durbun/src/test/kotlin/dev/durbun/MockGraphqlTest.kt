package dev.durbun

import dev.durbun.internal.DurbunCore
import dev.durbun.internal.GraphqlMatching
import dev.durbun.internal.GraphqlOperation
import dev.durbun.internal.Json
import dev.durbun.internal.MockMatcher
import dev.durbun.internal.MockRequest
import dev.durbun.internal.MockRule
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okio.BufferedSink
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.File
import java.net.Proxy
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Mock matching v2 (rules limited to a GraphQL operation). `mock-graphql.json` is a copy of the shared vectors
 * (`packages/protocol/vectors/mock-graphql.json`, generated from the protocol's reference functions; copied by
 * tools/gen-mock-parity.mjs), so the parity assertions are the TypeScript results. The interceptor tests check
 * that a body is read only when that cannot break the app's request.
 */
class MockGraphqlTest {
    @Suppress("UNCHECKED_CAST")
    private val vectors: Map<String, Any?> by lazy {
        val text = javaClass.getResourceAsStream("/mock-graphql.json")!!.use { it.readBytes().toString(Charsets.UTF_8) }
        Json.parse(text) as Map<String, Any?>
    }

    private class VectorRequest(val method: String, val url: String, val appId: String?, val contentType: String?, val body: String?)

    @Suppress("UNCHECKED_CAST")
    private fun requestOf(map: Map<String, Any?>): VectorRequest {
        val pattern = map["bodyPattern"] as List<Any?>?
        val body = pattern?.joinToString("") { part ->
            val pair = part as List<Any?>
            (pair[0] as String).repeat((pair[1] as Number).toInt())
        } ?: map["body"] as String?
        return VectorRequest(map["method"] as String, map["url"] as String, map["appId"] as String?, map["contentType"] as String?, body)
    }

    private fun inputOf(r: VectorRequest) = MockRequest(r.method, r.url, r.appId, r.contentType) { r.body }

    @Suppress("UNCHECKED_CAST")
    private fun expectedOps(value: Any?): List<GraphqlOperation>? =
        (value as List<Any?>?)?.map { item ->
            val op = item as Map<String, Any?>
            GraphqlOperation(op["name"] as String?, op["type"] as String?)
        }

    @Test
    fun theCopyOfTheSharedVectorsIsCurrent() {
        val original = File("../../../packages/protocol/vectors/mock-graphql.json")
        if (!original.isFile) return // module built outside the repository
        val copy = javaClass.getResourceAsStream("/mock-graphql.json")!!.use { it.readBytes() }
        assertTrue(
            "src/test/resources/mock-graphql.json is stale: run node --import tsx sdks/android/tools/gen-mock-parity.mjs",
            original.readBytes().contentEquals(copy),
        )
    }

    @Test
    fun operationsAreReadExactlyLikeTheReference() {
        assertEquals(GraphqlMatching.MAX_CHARS.toLong(), vectors["maxChars"])
        val cases = vectors.listAt("operations")
        assertTrue(cases.size > 80)
        val failures = ArrayList<String>()
        for (item in cases) {
            @Suppress("UNCHECKED_CAST")
            val case = item as Map<String, Any?>
            val r = requestOf(case.objAt("request"))
            val actual = GraphqlMatching.operationsOf(r.method, r.url, r.contentType, r.body)
            val expected = expectedOps(case["expected"])
            if (actual != expected) failures += "${case["description"]}: expected $expected, got $actual"
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun rulesMatchExactlyLikeTheReference() {
        val failures = ArrayList<String>()
        for (item in vectors.listAt("matches")) {
            @Suppress("UNCHECKED_CAST")
            val case = item as Map<String, Any?>
            val rule = MockRule.fromJson(case.objAt("rule"))
            assertNotNull("rule should parse: ${case["rule"]}", rule)
            val r = requestOf(case.objAt("request"))
            val actual = MockMatcher.matchesRequest(rule!!, inputOf(r))
            if (actual != case["expected"]) failures += "${case["rule"]} / ${case["request"]}: expected ${case["expected"]}, got $actual"
            val noBody = MockMatcher.matches(rule, r.method, r.url, r.appId)
            if (noBody != case["matchesNoBody"]) failures += "no body ${case["rule"]}: expected ${case["matchesNoBody"]}, got $noBody"
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun firstMatchingRuleWinsAndTheBodyIsReadOnce() {
        val finds = vectors.objAt("finds")
        val rules = MockRule.listFromJson(finds.listAt("rules"))
        assertEquals(4, rules.size)
        for (item in finds.listAt("cases")) {
            @Suppress("UNCHECKED_CAST")
            val case = item as Map<String, Any?>
            val r = requestOf(case.objAt("request"))
            val reads = AtomicInteger()
            val found = MockMatcher.find(rules, MockRequest(r.method, r.url, r.appId, r.contentType) { reads.incrementAndGet(); r.body })
            assertEquals("${case["request"]}", case["expectedId"], found?.id)
            assertTrue("body read at most once", reads.get() <= 1)
        }
        // A plain rule first: the body is never read.
        val plain = MockRule.listFromJson(Json.parse("""[{"id":"p","enabled":true,"method":"*","url":"/graphql","match":"contains","action":{"type":"delay","delayMs":0}}]""") as List<Any?>)
        val reads = AtomicInteger()
        assertEquals("p", MockMatcher.find(plain, MockRequest("POST", "https://x/graphql", null, null) { reads.incrementAndGet(); "{}" })?.id)
        assertEquals(0, reads.get())
    }

    /* ───────────── through DurbunInterceptor ───────────── */

    private lateinit var desktop: FakeDesktop
    private lateinit var server: TestHttpServer
    private var core: DurbunCore? = null

    @Before
    fun setUp() {
        desktop = FakeDesktop()
        server = TestHttpServer { request ->
            TestResponse(headers = listOf("Content-Type" to "application/json"), body = "{\"real\":true}".toByteArray() + request.body.size.toString().toByteArray())
        }
    }

    @After
    fun tearDown() {
        Durbun.installForTesting(null)
        core?.stop()
        desktop.close()
        server.close()
    }

    private fun connect() {
        val c = startCore(desktop, DurbunOptions())
        core = c
        Durbun.installForTesting(c)
        val deadline = System.currentTimeMillis() + 5_000
        while (!c.isConnected && System.currentTimeMillis() < deadline) Thread.sleep(10)
        assertTrue(c.isConnected)
    }

    private fun client() = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .addInterceptor(DurbunInterceptor())
        .connectTimeout(3, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .build()

    private fun graphqlRule(id: String, operation: String) = linkedMapOf(
        "id" to id,
        "enabled" to true,
        "method" to "POST",
        "url" to "/graphql",
        "match" to "contains",
        "when" to mapOf("graphql" to mapOf("operationName" to operation)),
        "action" to mapOf("type" to "respond", "status" to 200, "body" to "{\"mocked\":\"$operation\"}"),
        "createdAt" to 1,
    )

    private val json = "application/json".toMediaType()

    @Test
    fun helloDeclaresTheGraphqlMatcher() {
        connect()
        val hello = desktop.await("hello")
        assertEquals(listOf("graphql"), hello.objAt("sdk")["mockMatchers"])
    }

    @Test
    fun aRuleForOneOperationMocksOnlyThatOperation() {
        desktop.mocks = listOf(graphqlRule("g-user", "GetUser"))
        connect()
        val url = server.url("/graphql")
        val getUser = "{\"operationName\":\"GetUser\",\"query\":\"query GetUser { me { id } }\"}"
        client().newCall(Request.Builder().url(url).post(getUser.toRequestBody(json)).build()).execute().use {
            assertEquals("{\"mocked\":\"GetUser\"}", it.body!!.string())
        }
        assertTrue("a mocked operation never reaches the server", server.requests.isEmpty())

        val other = "{\"query\":\"query GetFeed { feed { id } }\"}"
        client().newCall(Request.Builder().url(url).post(other.toRequestBody(json)).build()).execute().use {
            assertEquals("{\"real\":true}${other.length}", it.body!!.string())
        }
        assertEquals("the other operation reaches the server whole", other, String(server.requests.single().body))
        val reported = desktop.awaitCount("net.request", 2) { it["url"] == url }
        assertTrue(reported.isNotEmpty())
        val responses = desktop.awaitCount("net.response", 2)
        assertEquals(listOf(true, null), responses.map { it["mocked"] })
    }

    @Test
    fun anAppBodyIsWrittenOnceAndOneShotBodiesAreNeverRead() {
        desktop.mocks = listOf(graphqlRule("g-user", "GetUser"))
        connect()
        val url = server.url("/graphql")
        val payload = "{\"operationName\":\"GetUser\"}".toByteArray()

        // A custom repeatable body: read once for matching, then sent from that copy (no second write).
        val writes = AtomicInteger()
        val repeatable = object : RequestBody() {
            override fun contentType() = json
            override fun contentLength() = payload.size.toLong()
            override fun writeTo(sink: BufferedSink) {
                writes.incrementAndGet()
                sink.write(payload)
            }
        }
        client().newCall(Request.Builder().url(url).post(repeatable).build()).execute().use {
            assertEquals("{\"mocked\":\"GetUser\"}", it.body!!.string())
        }
        assertEquals(1, writes.get())

        // One-shot: unknown, so the rule does not match and the request goes to the network untouched.
        val oneShotWrites = AtomicInteger()
        val oneShot = object : RequestBody() {
            override fun contentType() = json
            override fun contentLength() = payload.size.toLong()
            override fun isOneShot() = true
            override fun writeTo(sink: BufferedSink) {
                oneShotWrites.incrementAndGet()
                sink.write(payload)
            }
        }
        client().newCall(Request.Builder().url(url).post(oneShot).build()).execute().use {
            assertTrue(it.body!!.string().startsWith("{\"real\":true}"))
        }
        assertEquals(1, oneShotWrites.get())
        assertEquals(String(payload), String(server.requests.last().body))

        // Unknown length (streaming): never read for matching either.
        val streamed = object : RequestBody() {
            override fun contentType() = json
            override fun contentLength() = -1L
            override fun writeTo(sink: BufferedSink) {
                sink.write(payload)
            }
        }
        client().newCall(Request.Builder().url(url).post(streamed).build()).execute().use {
            assertTrue(it.body!!.string().startsWith("{\"real\":true}"))
        }
        assertEquals(String(payload), String(server.requests.last().body))
    }

    @Test
    fun aBodyTooLargeToReadGoesToTheNetwork() {
        desktop.mocks = listOf(graphqlRule("g-big", "Big"))
        connect()
        val url = server.url("/graphql")
        val pad = "a".repeat(GraphqlMatching.MAX_BODY_BYTES)
        val big = "{\"operationName\":\"Big\",\"pad\":\"$pad\"}"
        client().newCall(Request.Builder().url(url).post(big.toRequestBody(json)).build()).execute().use {
            assertTrue(it.body!!.string().startsWith("{\"real\":true}"))
        }
        assertEquals(big.length, server.requests.single().body.size)
        assertFalse(desktop.messages("net.response").any { it["mocked"] == true })
    }
}
