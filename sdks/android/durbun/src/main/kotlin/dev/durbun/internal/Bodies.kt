package dev.durbun.internal

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.nio.charset.Charset
import java.util.zip.GZIPInputStream
import java.util.zip.Inflater
import java.util.zip.InflaterInputStream

/** A captured body as sent on the wire (`WireBody` in the protocol). */
internal class WireBody(
    /** `utf8` (text) or `base64` (binary). */
    val encoding: String,
    val data: String,
    /** Full decoded size in bytes, even when [data] is truncated. */
    val size: Long,
    val truncated: Boolean,
) {
    fun toJson(): Map<String, Any?> {
        val map = linkedMapOf<String, Any?>("encoding" to encoding, "data" to data, "size" to size)
        if (truncated) map["truncated"] = true
        return map
    }

    companion object {
        /** Body whose bytes were not captured (capture off, streaming or one-shot) but whose size is known. */
        fun sizeOnly(size: Long): WireBody? = if (size > 0) WireBody("utf8", "", size, truncated = true) else null
    }
}

/** Standard Base64 (RFC 4648, padded). `android.util.Base64` is not available in JVM tests. */
internal object Base64Codec {
    private const val ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    private val DECODE = IntArray(128) { -1 }.also { table ->
        ALPHABET.forEachIndexed { i, c -> table[c.code] = i }
        table['-'.code] = 62 // URL-safe variants
        table['_'.code] = 63
    }

    fun encode(bytes: ByteArray, length: Int = bytes.size): String {
        val out = StringBuilder((length + 2) / 3 * 4)
        var i = 0
        while (i + 2 < length) {
            val n = (bytes[i].toInt() and 0xFF shl 16) or (bytes[i + 1].toInt() and 0xFF shl 8) or (bytes[i + 2].toInt() and 0xFF)
            out.append(ALPHABET[n shr 18 and 63]).append(ALPHABET[n shr 12 and 63])
                .append(ALPHABET[n shr 6 and 63]).append(ALPHABET[n and 63])
            i += 3
        }
        val rest = length - i
        if (rest == 1) {
            val n = bytes[i].toInt() and 0xFF shl 16
            out.append(ALPHABET[n shr 18 and 63]).append(ALPHABET[n shr 12 and 63]).append("==")
        } else if (rest == 2) {
            val n = (bytes[i].toInt() and 0xFF shl 16) or (bytes[i + 1].toInt() and 0xFF shl 8)
            out.append(ALPHABET[n shr 18 and 63]).append(ALPHABET[n shr 12 and 63])
                .append(ALPHABET[n shr 6 and 63]).append('=')
        }
        return out.toString()
    }

    /** Lenient decoder (ignores whitespace, accepts missing padding and URL-safe chars); `null` on bad input. */
    fun decode(text: String): ByteArray? {
        val out = ByteArrayOutputStream(text.length * 3 / 4)
        var buffer = 0
        var bits = 0
        for (c in text) {
            if (c == '=' ) break
            if (c == ' ' || c == '\n' || c == '\r' || c == '\t') continue
            val v = if (c.code < 128) DECODE[c.code] else -1
            if (v < 0) return null
            buffer = (buffer shl 6) or v
            bits += 6
            if (bits >= 8) {
                bits -= 8
                out.write(buffer shr bits and 0xFF)
            }
        }
        return out.toByteArray()
    }
}

/** Turns captured body bytes into a [WireBody] (Content-Encoding undone, text vs base64, truncation). */
internal object BodyCapture {
    /**
     * @param raw bytes as transferred (a prefix of the body when [rawComplete] is false)
     * @param rawLength number of valid bytes in [raw]
     * @param rawComplete [raw] holds the entire transferred body
     * @param transferSize full transferred size when known (Content-Length), else -1
     * @param contentEncoding `Content-Encoding` header (gzip / deflate are decoded; others stay binary)
     * @param limit maximum number of decoded bytes to keep
     */
    fun encode(
        raw: ByteArray,
        rawLength: Int,
        rawComplete: Boolean,
        transferSize: Long,
        contentType: String?,
        contentEncoding: String?,
        limit: Int,
    ): WireBody {
        val encoded = !contentEncoding.isNullOrBlank() && !contentEncoding.trim().equals("identity", ignoreCase = true)
        if (encoded) {
            val decoded = BodyCodec.decodeContentEncoding(raw.copyOf(rawLength), contentEncoding, limit)
            if (decoded != null) {
                val bytes = decoded.bytes
                val complete = decoded.complete && rawComplete && bytes.size <= limit
                val keep = minOf(bytes.size, limit)
                return build(bytes, keep, bytes.size.toLong(), !complete, contentType, allowText = true)
            }
            // br / zstd / unknown: keep the transferred bytes as binary.
            val keep = minOf(rawLength, limit)
            val size = if (transferSize >= 0) transferSize else rawLength.toLong()
            return build(raw, keep, size, !(rawComplete && rawLength <= limit), contentType, allowText = false)
        }
        val keep = minOf(rawLength, limit)
        val complete = rawComplete && rawLength <= limit
        val size = when {
            transferSize >= 0 -> transferSize
            else -> rawLength.toLong()
        }
        return build(raw, keep, size, !complete, contentType, allowText = true)
    }

    private fun build(
        bytes: ByteArray,
        keep: Int,
        size: Long,
        truncated: Boolean,
        contentType: String?,
        allowText: Boolean,
    ): WireBody {
        val asText = allowText && BodyCodec.shouldSendAsText(contentType, bytes, keep)
        val data = if (asText) BodyCodec.decodeText(bytes, keep, contentType) else Base64Codec.encode(bytes, keep)
        return WireBody(if (asText) "utf8" else "base64", data, maxOf(size, keep.toLong()), truncated)
    }
}

/** Helpers shared by the HTTP capture code: text detection, charset decoding, gzip/deflate. */
internal object BodyCodec {
    /** Same list as `isTextContentType` in the protocol. */
    fun isTextContentType(contentType: String?): Boolean {
        if (contentType.isNullOrEmpty()) return false
        val ct = contentType.lowercase()
        return ct.startsWith("text/") ||
            ct.contains("json") ||
            ct.contains("xml") ||
            ct.contains("html") ||
            ct.contains("javascript") ||
            ct.contains("x-www-form-urlencoded") ||
            ct.contains("graphql") ||
            ct.contains("yaml") ||
            ct.contains("csv")
    }

    /** `charset=` parameter of a content type, when present and supported. */
    fun charsetOf(contentType: String?): Charset? {
        if (contentType == null) return null
        for (part in contentType.split(';')) {
            val kv = part.trim()
            if (kv.startsWith("charset=", ignoreCase = true)) {
                val name = kv.substring(8).trim().trim('"', '\'')
                return try {
                    Charset.forName(name)
                } catch (_: Exception) {
                    null
                }
            }
        }
        return null
    }

    /**
     * Decides how a body is shipped. Declared text types → text; no declared type → text when the bytes
     * look like UTF-8 text (keeps untyped JSON readable); everything else → base64.
     */
    fun shouldSendAsText(contentType: String?, bytes: ByteArray, length: Int): Boolean {
        if (isTextContentType(contentType)) return true
        if (!contentType.isNullOrBlank()) return false
        return looksLikeUtf8Text(bytes, length)
    }

    /** Valid UTF-8 without binary control characters (a truncated trailing sequence is tolerated). */
    fun looksLikeUtf8Text(bytes: ByteArray, length: Int): Boolean {
        if (length == 0) return true
        var i = 0
        val end = utf8SafeLength(bytes, length)
        while (i < end) {
            val b = bytes[i].toInt() and 0xFF
            when {
                b < 0x20 -> if (b != 0x09 && b != 0x0A && b != 0x0D && b != 0x0C) return false else i++
                b < 0x80 -> i++
                b in 0xC2..0xDF -> {
                    if (!isContinuation(bytes, i + 1, end)) return false
                    i += 2
                }
                b in 0xE0..0xEF -> {
                    if (!isContinuation(bytes, i + 1, end) || !isContinuation(bytes, i + 2, end)) return false
                    i += 3
                }
                b in 0xF0..0xF4 -> {
                    if (!isContinuation(bytes, i + 1, end) || !isContinuation(bytes, i + 2, end) ||
                        !isContinuation(bytes, i + 3, end)
                    ) return false
                    i += 4
                }
                else -> return false
            }
        }
        return true
    }

    private fun isContinuation(bytes: ByteArray, index: Int, end: Int): Boolean =
        index < end && (bytes[index].toInt() and 0xC0) == 0x80

    /** Length without an incomplete UTF-8 sequence at the end (for text cut at the capture limit). */
    fun utf8SafeLength(bytes: ByteArray, length: Int): Int {
        if (length == 0) return 0
        var i = length - 1
        var continuation = 0
        while (i >= 0 && continuation < 3 && (bytes[i].toInt() and 0xC0) == 0x80) {
            i--
            continuation++
        }
        if (i < 0) return length
        val lead = bytes[i].toInt() and 0xFF
        val needed = when {
            lead < 0x80 -> 1
            lead in 0xC0..0xDF -> 2
            lead in 0xE0..0xEF -> 3
            lead in 0xF0..0xF7 -> 4
            else -> 1
        }
        return if (continuation + 1 < needed) i else length
    }

    /** Decodes captured bytes to text with the declared charset (UTF-8 by default). */
    fun decodeText(bytes: ByteArray, length: Int, contentType: String?): String {
        val charset = charsetOf(contentType) ?: Charsets.UTF_8
        val usable = if (charset == Charsets.UTF_8) utf8SafeLength(bytes, length) else length
        return String(bytes, 0, usable, charset)
    }

    class Decoded(val bytes: ByteArray, val complete: Boolean)

    /**
     * Undoes `Content-Encoding` (gzip / deflate) of a possibly truncated body, keeping at most [maxOut]+1 bytes
     * so callers can tell whether the decoded body exceeds their limit. Unknown encodings (br, zstd) → `null`.
     */
    fun decodeContentEncoding(bytes: ByteArray, encoding: String?, maxOut: Int): Decoded? {
        val enc = encoding?.trim()?.lowercase()
        if (enc.isNullOrEmpty() || enc == "identity") return Decoded(bytes, true)
        return when (enc) {
            "gzip", "x-gzip" -> inflate(maxOut) { GZIPInputStream(ByteArrayInputStream(bytes)) }
            "deflate" -> inflate(maxOut) { InflaterInputStream(ByteArrayInputStream(bytes)) }
                ?.takeIf { it.bytes.isNotEmpty() || bytes.isEmpty() }
                ?: inflate(maxOut) { InflaterInputStream(ByteArrayInputStream(bytes), Inflater(true)) }
            else -> null
        }
    }

    private inline fun inflate(maxOut: Int, open: () -> InputStream): Decoded? {
        val out = ByteArrayOutputStream()
        var complete = true
        try {
            open().use { input ->
                val buf = ByteArray(8192)
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    if (out.size() > maxOut) {
                        complete = false
                        break
                    }
                }
            }
        } catch (_: EOFException) {
            complete = false // truncated input: keep what was decoded
        } catch (_: IOException) {
            if (out.size() == 0) return null
            complete = false
        }
        return Decoded(out.toByteArray(), complete)
    }
}
