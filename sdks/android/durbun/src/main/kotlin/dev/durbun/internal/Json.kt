package dev.durbun.internal

import java.math.BigDecimal
import java.math.BigInteger
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

internal class JsonException(message: String) : Exception(message)

/** A JSON fragment that [Json.encode] embeds verbatim (must be valid JSON). */
internal class RawJson(val json: String) {
    override fun toString(): String = json
}

/**
 * Tiny JSON codec (no org.json, so the SDK core runs in plain JVM unit tests).
 *
 * Encoding accepts arbitrary app data: maps, collections, arrays, numbers, enums, throwables, and JSON
 * objects from org.json / Gson / kotlinx.serialization / Jackson (embedded as structured JSON, so the
 * desktop can show them as a tree). Anything else becomes its `toString()`.
 *
 * Parsing returns `LinkedHashMap<String, Any?>`, `ArrayList<Any?>`, `String`, `Long` (integers),
 * `Double`, `Boolean` or `null`.
 */
internal object Json {
    private const val MAX_ENCODE_DEPTH = 48
    private const val MAX_PARSE_DEPTH = 512
    private const val MAX_INLINE_BYTES = 256

    /** Classes whose `toString()` is JSON text; embedded as parsed JSON instead of a quoted string. */
    private val JSON_TEXT_CLASSES = setOf(
        "org.json.JSONObject",
        "org.json.JSONArray",
        "com.google.gson.JsonObject",
        "com.google.gson.JsonArray",
        "com.google.gson.JsonPrimitive",
        "com.google.gson.JsonNull",
        "kotlinx.serialization.json.JsonLiteral",
        "kotlinx.serialization.json.JsonNull",
        "com.fasterxml.jackson.databind.node.ObjectNode",
        "com.fasterxml.jackson.databind.node.ArrayNode",
    )

    fun encode(value: Any?): String {
        val sb = StringBuilder(64)
        write(sb, value, 0)
        return sb.toString()
    }

    fun write(sb: StringBuilder, value: Any?, depth: Int) {
        if (depth > MAX_ENCODE_DEPTH) {
            writeString(sb, "…")
            return
        }
        when (value) {
            null -> sb.append("null")
            is RawJson -> sb.append(value.json)
            is String -> writeString(sb, value)
            is Boolean -> sb.append(if (value) "true" else "false")
            is Int, is Long, is Short, is Byte, is BigInteger -> sb.append(value.toString())
            is AtomicInteger -> sb.append(value.get())
            is AtomicLong -> sb.append(value.get())
            is Double -> writeDouble(sb, value)
            is Float -> if (value.isNaN() || value.isInfinite()) writeDouble(sb, value.toDouble()) else writeDouble(sb, value.toString().toDouble())
            is BigDecimal -> writeBigDecimal(sb, value)
            is Number -> writeDouble(sb, value.toDouble())
            is Char -> writeString(sb, value.toString())
            is CharSequence -> writeString(sb, value.toString())
            is Enum<*> -> writeString(sb, value.name)
            is Map<*, *> -> writeMap(sb, value, depth)
            else -> writeOther(sb, value, depth)
        }
    }

    private fun writeOther(sb: StringBuilder, value: Any, depth: Int) {
        if (value.javaClass.name in JSON_TEXT_CLASSES) {
            val parsed = try {
                parse(value.toString())
            } catch (_: Throwable) {
                null
            }
            if (parsed != null) {
                write(sb, parsed, depth)
                return
            }
        }
        when (value) {
            is Collection<*> -> writeIterable(sb, value, depth)
            is Array<*> -> writeIterable(sb, value.asList(), depth)
            is IntArray -> writeIterable(sb, value.asList(), depth)
            is LongArray -> writeIterable(sb, value.asList(), depth)
            is ShortArray -> writeIterable(sb, value.asList(), depth)
            is DoubleArray -> writeIterable(sb, value.asList(), depth)
            is FloatArray -> writeIterable(sb, value.asList(), depth)
            is BooleanArray -> writeIterable(sb, value.asList(), depth)
            is CharArray -> writeString(sb, String(value))
            is ByteArray ->
                if (value.size <= MAX_INLINE_BYTES) writeIterable(sb, value.asList(), depth)
                else writeString(sb, "<${value.size} bytes>")
            is Iterable<*> -> writeIterable(sb, value, depth)
            is Pair<*, *> -> writeIterable(sb, listOf(value.first, value.second), depth)
            is Triple<*, *, *> -> writeIterable(sb, listOf(value.first, value.second, value.third), depth)
            is Throwable -> writeMap(sb, linkedMapOf("type" to value.javaClass.name, "message" to value.message), depth)
            else -> writeString(sb, safeToString(value))
        }
    }

    private fun writeMap(sb: StringBuilder, map: Map<*, *>, depth: Int) {
        sb.append('{')
        var first = true
        for ((k, v) in map) {
            if (!first) sb.append(',')
            first = false
            writeString(sb, k?.toString() ?: "null")
            sb.append(':')
            write(sb, v, depth + 1)
        }
        sb.append('}')
    }

    private fun writeIterable(sb: StringBuilder, items: Iterable<*>, depth: Int) {
        sb.append('[')
        var first = true
        for (item in items) {
            if (!first) sb.append(',')
            first = false
            write(sb, item, depth + 1)
        }
        sb.append(']')
    }

    private fun safeToString(value: Any): String = try {
        value.toString()
    } catch (t: Throwable) {
        "<${value.javaClass.name}: toString() failed: ${t.javaClass.simpleName}>"
    }

    private fun writeDouble(sb: StringBuilder, d: Double) {
        when {
            d.isNaN() -> writeString(sb, "NaN")
            d.isInfinite() -> writeString(sb, if (d > 0) "Infinity" else "-Infinity")
            d == Math.rint(d) && Math.abs(d) < 1e15 -> sb.append(d.toLong())
            else -> {
                val a = Math.abs(d)
                if (a >= 1e-6 && a < 1e21) sb.append(BigDecimal.valueOf(d).toPlainString()) else sb.append(d.toString())
            }
        }
    }

    private fun writeBigDecimal(sb: StringBuilder, d: BigDecimal) {
        // Keep it a JSON number; scientific notation is valid JSON and avoids huge plain strings.
        val plainLength = d.precision() - d.scale()
        if (plainLength in -20..40) sb.append(d.toPlainString()) else sb.append(d.toString())
    }

    fun writeString(sb: StringBuilder, s: String) {
        sb.append('"')
        val n = s.length
        var i = 0
        while (i < n) {
            val c = s[i]
            when {
                c == '"' -> sb.append("\\\"")
                c == '\\' -> sb.append("\\\\")
                c == '\n' -> sb.append("\\n")
                c == '\r' -> sb.append("\\r")
                c == '\t' -> sb.append("\\t")
                c == '\b' -> sb.append("\\b")
                c == '\u000C' -> sb.append("\\f")
                c < ' ' || c == ' ' || c == ' ' -> appendUnicodeEscape(sb, c)
                Character.isHighSurrogate(c) -> {
                    if (i + 1 < n && Character.isLowSurrogate(s[i + 1])) {
                        sb.append(c).append(s[i + 1])
                        i++
                    } else {
                        appendUnicodeEscape(sb, c) // lone surrogate: escaped so the UTF-8 output stays valid
                    }
                }
                Character.isLowSurrogate(c) -> appendUnicodeEscape(sb, c)
                else -> sb.append(c)
            }
            i++
        }
        sb.append('"')
    }

    private fun appendUnicodeEscape(sb: StringBuilder, c: Char) {
        val hex = "0123456789abcdef"
        val v = c.code
        sb.append("\\u")
            .append(hex[(v shr 12) and 0xF])
            .append(hex[(v shr 8) and 0xF])
            .append(hex[(v shr 4) and 0xF])
            .append(hex[v and 0xF])
    }

    /** Parses one JSON document. Throws [JsonException] on malformed input. */
    fun parse(text: String): Any? {
        val p = Parser(text)
        val value = p.readValue(0)
        p.skipWhitespace()
        if (p.pos < text.length) throw JsonException("Unexpected trailing data at offset ${p.pos}")
        return value
    }

    /** Parses a JSON object; `null` when [text] is not a valid JSON object. */
    fun parseObject(text: String): Map<String, Any?>? = try {
        @Suppress("UNCHECKED_CAST")
        parse(text) as? Map<String, Any?>
    } catch (_: JsonException) {
        null
    } catch (_: RuntimeException) {
        null
    }

    private class Parser(private val s: String) {
        var pos = 0

        fun skipWhitespace() {
            while (pos < s.length) {
                val c = s[pos]
                if (c == ' ' || c == '\n' || c == '\r' || c == '\t') pos++ else break
            }
        }

        fun readValue(depth: Int): Any? {
            if (depth > MAX_PARSE_DEPTH) throw JsonException("Nesting deeper than $MAX_PARSE_DEPTH")
            skipWhitespace()
            if (pos >= s.length) throw JsonException("Unexpected end of input")
            val c = s[pos]
            return when {
                c == '{' -> readObject(depth)
                c == '[' -> readArray(depth)
                c == '"' -> readString()
                c == 't' -> readLiteral("true", true)
                c == 'f' -> readLiteral("false", false)
                c == 'n' -> readLiteral("null", null)
                c == '-' || c in '0'..'9' -> readNumber()
                else -> throw JsonException("Unexpected character '$c' at offset $pos")
            }
        }

        private fun readLiteral(word: String, value: Any?): Any? {
            if (!s.startsWith(word, pos)) throw JsonException("Invalid literal at offset $pos")
            pos += word.length
            return value
        }

        private fun readObject(depth: Int): Map<String, Any?> {
            pos++ // {
            val map = LinkedHashMap<String, Any?>()
            skipWhitespace()
            if (pos < s.length && s[pos] == '}') {
                pos++
                return map
            }
            while (true) {
                skipWhitespace()
                if (pos >= s.length || s[pos] != '"') throw JsonException("Expected a string key at offset $pos")
                val key = readString()
                skipWhitespace()
                if (pos >= s.length || s[pos] != ':') throw JsonException("Expected ':' at offset $pos")
                pos++
                map[key] = readValue(depth + 1)
                skipWhitespace()
                if (pos >= s.length) throw JsonException("Unterminated object")
                when (s[pos]) {
                    ',' -> pos++
                    '}' -> {
                        pos++
                        return map
                    }
                    else -> throw JsonException("Expected ',' or '}' at offset $pos")
                }
            }
        }

        private fun readArray(depth: Int): List<Any?> {
            pos++ // [
            val list = ArrayList<Any?>()
            skipWhitespace()
            if (pos < s.length && s[pos] == ']') {
                pos++
                return list
            }
            while (true) {
                list.add(readValue(depth + 1))
                skipWhitespace()
                if (pos >= s.length) throw JsonException("Unterminated array")
                when (s[pos]) {
                    ',' -> pos++
                    ']' -> {
                        pos++
                        return list
                    }
                    else -> throw JsonException("Expected ',' or ']' at offset $pos")
                }
            }
        }

        private fun readString(): String {
            pos++ // opening quote
            var sb: StringBuilder? = null
            var runStart = pos
            while (pos < s.length) {
                val c = s[pos]
                when (c) {
                    '"' -> {
                        val builder = sb
                        val result = if (builder == null) {
                            s.substring(runStart, pos)
                        } else {
                            builder.append(s, runStart, pos).toString()
                        }
                        pos++
                        return result
                    }
                    '\\' -> {
                        var b = sb
                        if (b == null) {
                            b = StringBuilder()
                            sb = b
                        }
                        b.append(s, runStart, pos)
                        pos++
                        if (pos >= s.length) throw JsonException("Unterminated escape")
                        when (val e = s[pos]) {
                            '"' -> b.append('"')
                            '\\' -> b.append('\\')
                            '/' -> b.append('/')
                            'b' -> b.append('\b')
                            'f' -> b.append('\u000C')
                            'n' -> b.append('\n')
                            'r' -> b.append('\r')
                            't' -> b.append('\t')
                            'u' -> {
                                if (pos + 4 >= s.length) throw JsonException("Truncated unicode escape")
                                val code = s.substring(pos + 1, pos + 5).toIntOrNull(16)
                                    ?: throw JsonException("Invalid unicode escape at offset $pos")
                                b.append(code.toChar())
                                pos += 4
                            }
                            else -> throw JsonException("Invalid escape '\\$e' at offset $pos")
                        }
                        pos++
                        runStart = pos
                    }
                    else -> pos++
                }
            }
            throw JsonException("Unterminated string")
        }

        private fun readNumber(): Any {
            val start = pos
            var isDecimal = false
            if (s[pos] == '-') pos++
            while (pos < s.length) {
                val c = s[pos]
                if (c in '0'..'9') {
                    pos++
                } else if (c == '.' || c == 'e' || c == 'E' || c == '+' || c == '-') {
                    isDecimal = true
                    pos++
                } else {
                    break
                }
            }
            val text = s.substring(start, pos)
            if (text == "-" || text.isEmpty()) throw JsonException("Invalid number at offset $start")
            if (!isDecimal) {
                text.toLongOrNull()?.let { return it }
            }
            return text.toDoubleOrNull() ?: throw JsonException("Invalid number '$text' at offset $start")
        }
    }
}

/* ───────────── typed accessors for parsed JSON objects ───────────── */

internal fun Map<String, Any?>.str(key: String): String? = this[key] as? String

internal fun Map<String, Any?>.num(key: String): Number? = this[key] as? Number

internal fun Map<String, Any?>.bool(key: String): Boolean? = this[key] as? Boolean

@Suppress("UNCHECKED_CAST")
internal fun Map<String, Any?>.obj(key: String): Map<String, Any?>? = this[key] as? Map<String, Any?>

@Suppress("UNCHECKED_CAST")
internal fun Map<String, Any?>.list(key: String): List<Any?>? = this[key] as? List<Any?>
