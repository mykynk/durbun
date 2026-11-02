package dev.durbun

import dev.durbun.internal.Json
import dev.durbun.internal.JsonException
import dev.durbun.internal.RawJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.math.BigDecimal

class JsonTest {
    private enum class Plan { FREE, PREMIUM }

    @Test
    fun encodesPrimitives() {
        assertEquals("null", Json.encode(null))
        assertEquals("true", Json.encode(true))
        assertEquals("42", Json.encode(42))
        assertEquals("-7", Json.encode(-7L))
        assertEquals("3.5", Json.encode(3.5))
        assertEquals("49.9", Json.encode(49.9f))
        assertEquals("49.9", Json.encode(49.9))
        assertEquals("1730540592345.123", Json.encode(1730540592345.123))
        assertEquals("100", Json.encode(100.0))
        assertEquals("0.000012", Json.encode(0.000012))
        assertEquals("\"NaN\"", Json.encode(Double.NaN))
        assertEquals("\"-Infinity\"", Json.encode(Double.NEGATIVE_INFINITY))
        assertEquals("12.50", Json.encode(BigDecimal("12.50")))
        assertEquals("\"PREMIUM\"", Json.encode(Plan.PREMIUM))
        assertEquals("\"x\"", Json.encode('x'))
    }

    @Test
    fun escapesStrings() {
        assertEquals("\"a\\\"b\\\\c\"", Json.encode("a\"b\\c"))
        assertEquals("\"line1\\nline2\\r\\tend\"", Json.encode("line1\nline2\r\tend"))
        assertEquals("\"\\u0001\\u001f\"", Json.encode("\u0001\u001f"))
        assertEquals("\"\\u2028\\u2029\"", Json.encode("\u2028\u2029"))
        // Turkish text and emoji stay readable (raw UTF-8), lone surrogates are escaped.
        assertEquals("\"Kullanıcı giriş yaptı: ğüşöçİ 🚀\"", Json.encode("Kullanıcı giriş yaptı: ğüşöçİ 🚀"))
        assertEquals("\"\\ud800x\"", Json.encode("\uD800x"))
        assertEquals("\"x\\udc00\"", Json.encode("x\uDC00"))
    }

    @Test
    fun encodesCollectionsAndObjects() {
        val data = linkedMapOf(
            "userId" to 42,
            "tags" to listOf("vip", "beta"),
            "scores" to intArrayOf(1, 2, 3),
            "pair" to ("a" to 1),
            "nested" to mapOf("ok" to true, "none" to null),
            "error" to IllegalStateException("boom"),
        )
        assertEquals(
            "{\"userId\":42,\"tags\":[\"vip\",\"beta\"],\"scores\":[1,2,3],\"pair\":[\"a\",1]," +
                "\"nested\":{\"ok\":true,\"none\":null},\"error\":{\"type\":\"java.lang.IllegalStateException\",\"message\":\"boom\"}}",
            Json.encode(data),
        )
        assertEquals("{\"raw\":[1,2]}", Json.encode(mapOf("raw" to RawJson("[1,2]"))))
        assertEquals("\"<4096 bytes>\"", Json.encode(ByteArray(4096)))
        assertEquals("[1,2]", Json.encode(byteArrayOf(1, 2)))
    }

    @Test
    fun survivesSelfReferencingData() {
        val list = ArrayList<Any?>()
        list.add(list)
        val encoded = Json.encode(list)
        assertTrue(encoded.contains("…"))
        Json.parse(encoded) // still valid JSON
    }

    @Test
    fun toStringFallbackForUnknownObjects() {
        class Point(val x: Int, val y: Int) {
            override fun toString() = "Point($x, $y)"
        }
        assertEquals("{\"p\":\"Point(1, 2)\"}", Json.encode(mapOf("p" to Point(1, 2))))
    }

    @Test
    fun parsesWelcomeMessage() {
        val text = """
            {"type":"welcome","protocol":1,"server":"durbun/0.1.0","appId":"app:3",
             "config":{"captureBodies":true,"maxBodyBytes":1048576,"metricsIntervalMs":1000,"deviceLogsAvailable":false},
             "mocks":[{"id":"m1","enabled":true,"method":"GET","url":"/users","match":"contains",
                       "action":{"type":"respond","status":200,"headers":[["Content-Type","application/json"]],
                                 "body":"{\"ok\":true}","delayMs":250},"createdAt":1730540592345}]}
        """.trimIndent()
        val parsed = Json.parse(text) as Map<*, *>
        assertEquals("welcome", parsed["type"])
        assertEquals(1L, parsed["protocol"])
        val config = parsed["config"] as Map<*, *>
        assertEquals(1048576L, config["maxBodyBytes"])
        assertEquals(false, config["deviceLogsAvailable"])
        val mock = (parsed["mocks"] as List<*>)[0] as Map<*, *>
        val action = mock["action"] as Map<*, *>
        assertEquals("{\"ok\":true}", action["body"])
        assertEquals(1730540592345L, mock["createdAt"])
    }

    @Test
    fun parsesNumbersAndEscapes() {
        assertEquals(-12L, Json.parse("-12"))
        assertEquals(1.5e3, Json.parse("1.5e3"))
        assertEquals(-0.25, Json.parse("-0.25"))
        assertEquals(1.0E20, Json.parse("100000000000000000000"))
        assertEquals("é😀\"\\/\n", Json.parse("\"\\u00e9\\ud83d\\ude00\\\"\\\\\\/\\n\""))
        assertEquals(listOf(1L, "two", null, true, emptyMap<String, Any?>(), emptyList<Any?>()), Json.parse(" [1, \"two\", null, true, {}, []] "))
    }

    @Test
    fun roundTripsUnicodeAndStructure() {
        val value = linkedMapOf(
            "message" to "Ödeme başarısız ❌\n\tat com.mykynk.pati.Pay.run(Pay.kt:12)",
            "list" to listOf(1L, 2.5, "x", null, false),
            "deep" to mapOf("a" to mapOf("b" to listOf(mapOf("c" to "d")))),
        )
        assertEquals(value, Json.parse(Json.encode(value)))
    }

    @Test
    fun rejectsMalformedInput() {
        val bad = listOf(
            "",
            "{",
            "{\"a\":}",
            "[1,]",
            "\"unterminated",
            "tru",
            "{\"a\":1} trailing",
            "{'a':1}",
            "\"bad \\x escape\"",
            "-",
            "[".repeat(600) + "]".repeat(600),
        )
        for (input in bad) {
            try {
                Json.parse(input)
                fail("expected JsonException for: ${input.take(30)}")
            } catch (_: JsonException) {
            }
        }
        assertEquals(null, Json.parseObject("[1,2]"))
        assertEquals(null, Json.parseObject("not json"))
    }

    @Test
    fun encodedOutputIsSingleLine() {
        val encoded = Json.encode(mapOf("text" to "a\nb\r\nc", "nested" to listOf("x\ny")))
        assertFalse(encoded.contains('\n'))
        assertFalse(encoded.contains('\r'))
    }
}
