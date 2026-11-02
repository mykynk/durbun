package dev.durbun

import dev.durbun.internal.Base64Codec
import dev.durbun.internal.BodyCapture
import dev.durbun.internal.BodyCodec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.util.Base64
import java.util.Random
import java.util.zip.DeflaterOutputStream
import java.util.zip.GZIPOutputStream

class BodiesTest {
    private fun gzip(bytes: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        GZIPOutputStream(out).use { it.write(bytes) }
        return out.toByteArray()
    }

    private fun deflate(bytes: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        DeflaterOutputStream(out).use { it.write(bytes) }
        return out.toByteArray()
    }

    @Test
    fun base64MatchesTheJdk() {
        val random = Random(7)
        for (length in 0..70) {
            val bytes = ByteArray(length).also(random::nextBytes)
            val expected = Base64.getEncoder().encodeToString(bytes)
            assertEquals(expected, Base64Codec.encode(bytes))
            assertArrayEquals(bytes, Base64Codec.decode(expected))
        }
        assertEquals("aGVs", Base64Codec.encode("hello".toByteArray(), 3))
    }

    @Test
    fun base64DecodeIsLenient() {
        assertEquals("{\"ok\":false}", String(Base64Codec.decode("eyJvayI6ZmFsc2V9")!!))
        assertEquals("hi", String(Base64Codec.decode("aGk")!!)) // missing padding
        assertEquals("hi", String(Base64Codec.decode(" aG\nk= ")!!)) // whitespace
        assertArrayEquals(byteArrayOf(-5, -1), Base64Codec.decode("-_8")) // URL-safe alphabet
        assertNull(Base64Codec.decode("not*base64"))
    }

    @Test
    fun textContentTypesFollowTheProtocolList() {
        for (ct in listOf(
            "application/json; charset=utf-8", "text/plain", "application/problem+json", "application/xml",
            "text/html", "application/javascript", "application/x-www-form-urlencoded", "application/graphql",
            "application/x-yaml", "text/csv",
        )) assertTrue(ct, BodyCodec.isTextContentType(ct))
        for (ct in listOf(null, "", "image/png", "application/octet-stream", "application/pdf", "multipart/form-data")) {
            assertFalse("$ct", BodyCodec.isTextContentType(ct))
        }
    }

    @Test
    fun utf8CutInsideACharacterIsTrimmed() {
        val bytes = "Ağ".toByteArray() // 41 C4 9F
        assertEquals(3, bytes.size)
        assertEquals(1, BodyCodec.utf8SafeLength(bytes, 2))
        assertEquals(3, BodyCodec.utf8SafeLength(bytes, 3))
        val emoji = "x🚀".toByteArray() // 78 F0 9F 9A 80
        assertEquals(1, BodyCodec.utf8SafeLength(emoji, 4))
        assertEquals(5, BodyCodec.utf8SafeLength(emoji, 5))
        assertEquals("A", BodyCodec.decodeText(bytes, 2, "text/plain"))
    }

    @Test
    fun sniffsUntypedTextButNotBinary() {
        val json = "{\"items\":[1,2,3],\"name\":\"Çağrı\"}".toByteArray()
        assertTrue(BodyCodec.shouldSendAsText(null, json, json.size))
        val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0x0D)
        assertFalse(BodyCodec.shouldSendAsText(null, png, png.size))
        assertFalse(BodyCodec.shouldSendAsText("image/png", json, json.size))
    }

    @Test
    fun capturesCompleteJson() {
        val json = "{\"id\":42,\"name\":\"Pati\"}".toByteArray()
        val body = BodyCapture.encode(json, json.size, true, json.size.toLong(), "application/json", null, 1024)
        assertEquals("utf8", body.encoding)
        assertEquals("{\"id\":42,\"name\":\"Pati\"}", body.data)
        assertEquals(json.size.toLong(), body.size)
        assertFalse(body.truncated)
        assertEquals(mapOf("encoding" to "utf8", "data" to body.data, "size" to json.size.toLong()), body.toJson())
    }

    @Test
    fun truncatesAtTheLimitButKeepsTheRealSize() {
        val text = "ğ".repeat(1000).toByteArray() // 2000 bytes
        val body = BodyCapture.encode(text, 101, false, 2000, "text/plain; charset=utf-8", null, 100)
        assertEquals("ğ".repeat(50), body.data) // 100 bytes = 50 complete characters
        assertEquals(2000L, body.size)
        assertTrue(body.truncated)
        assertEquals(true, body.toJson()["truncated"])
    }

    @Test
    fun decodesGzipAndDeflate() {
        val json = ("{\"users\":[" + (1..200).joinToString(",") { "{\"id\":$it}" } + "]}").toByteArray()
        val zipped = gzip(json)
        val body = BodyCapture.encode(zipped, zipped.size, true, zipped.size.toLong(), "application/json", "gzip", 1_000_000)
        assertEquals(String(json), body.data)
        assertEquals(json.size.toLong(), body.size)
        assertFalse(body.truncated)

        val deflated = deflate(json)
        val body2 = BodyCapture.encode(deflated, deflated.size, true, -1, "application/json", "deflate", 1_000_000)
        assertEquals(String(json), body2.data)
    }

    @Test
    fun partialGzipKeepsWhatCouldBeDecoded() {
        val text = (1..5000).joinToString("\n") { "line $it: Dürbün" }.toByteArray()
        val zipped = gzip(text)
        val cut = zipped.size / 2
        val body = BodyCapture.encode(zipped, cut, false, zipped.size.toLong(), "text/plain", "gzip", 10_000_000)
        assertTrue(body.truncated)
        assertTrue(body.data.isNotEmpty())
        assertTrue(String(text).startsWith(body.data))

        // Decoded body larger than the limit → truncated to the limit.
        val limited = BodyCapture.encode(zipped, zipped.size, true, zipped.size.toLong(), "text/plain", "gzip", 1000)
        assertTrue(limited.truncated)
        assertTrue(limited.data.length <= 1000)
    }

    @Test
    fun binaryAndUnknownEncodingsAreBase64() {
        val png = ByteArray(300) { (it * 7).toByte() }
        val body = BodyCapture.encode(png, png.size, true, png.size.toLong(), "image/png", null, 1024)
        assertEquals("base64", body.encoding)
        assertArrayEquals(png, Base64.getDecoder().decode(body.data))

        val brotli = byteArrayOf(0x1b, 0x2f, 0x00, 0x00)
        val br = BodyCapture.encode(brotli, brotli.size, true, 4, "application/json", "br", 1024)
        assertEquals("base64", br.encoding)
        assertEquals(4L, br.size)
    }

    @Test
    fun honoursDeclaredCharset() {
        val turkish = "Şöför çiçek İğne".toByteArray(Charset.forName("ISO-8859-9"))
        val body = BodyCapture.encode(turkish, turkish.size, true, turkish.size.toLong(), "text/plain; charset=ISO-8859-9", null, 1024)
        assertEquals("Şöför çiçek İğne", body.data)
    }

    @Test
    fun zeroLimitSendsSizeOnly() {
        val bytes = "hello".toByteArray()
        val body = BodyCapture.encode(bytes, bytes.size, true, 5, "text/plain", null, 0)
        assertEquals("", body.data)
        assertEquals(5L, body.size)
        assertTrue(body.truncated)
    }
}
