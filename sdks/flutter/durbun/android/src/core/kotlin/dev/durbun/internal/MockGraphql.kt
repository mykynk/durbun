package dev.durbun.internal

/**
 * Mock matching v2: rule conditions (`MockRule.when`) and the GraphQL operation of a request. Exact port of
 * `graphqlOperationsOf` / `mockRuleMatchesRequest` / `findMockRuleForRequest` in the shared protocol
 * (`packages/protocol/src/index.ts`); the shared vectors in `packages/protocol/vectors/mock-graphql.json` are the
 * test. Lengths count UTF-16 code units (Kotlin strings are UTF-16, like JavaScript's), JSON is read strictly
 * (RFC 8259, as `JSON.parse` reads it) and URL parameters are decoded like `decodeURIComponent`.
 */

/** A `MockRule.when.graphql` condition that can be evaluated (name non-empty, type absent or known). */
internal class GraphqlCondition(val operationName: String, val operationType: String?)

/** One GraphQL operation of a request: [name] null = anonymous, [type] null = not known. */
internal data class GraphqlOperation(val name: String?, val type: String?)

/**
 * What a rule is matched against. [body] returns the request body as text only when the SDK already holds it (never
 * a stream), or null; it is called at most once, and only when a rule with a condition matches method / URL / apps.
 */
internal class MockRequest(
    val method: String,
    val url: String,
    val appId: String?,
    val contentType: String? = null,
    private val body: (() -> String?)? = null,
) {
    private var read = false
    private var text: String? = null

    fun bodyText(): String? {
        if (!read) {
            read = true
            text = try {
                body?.invoke()
            } catch (_: Throwable) {
                null
            }
        }
        return text
    }
}

/** The conditions of a rule as received: the keys used (see [usedKeys]) and the GraphQL condition when valid. */
internal class MockConditions(
    /** Keys of `when` holding a value, in order; `when` itself when it is not an object (never matches). */
    val usedKeys: List<String>,
    /** The `graphql` condition, null when absent or malformed (a malformed one never matches). */
    val graphql: GraphqlCondition?,
) {
    companion object {
        val NONE = MockConditions(emptyList(), null)

        private val TYPES = setOf("query", "mutation", "subscription")

        /** Reads `rule.when` exactly like the reference's `mockRuleMatchersUsed` / condition check. */
        fun fromJson(value: Any?): MockConditions {
            if (value == null) return NONE
            if (value !is Map<*, *>) return MockConditions(listOf("when"), null)
            val keys = value.entries.filter { it.value != null }.map { it.key.toString() }
            if (keys.isEmpty()) return NONE
            val raw = value["graphql"] as? Map<*, *>
            val name = raw?.get("operationName") as? String
            val type = raw?.get("operationType")
            val condition = if (name != null && name.isNotEmpty() && (type == null || (type is String && type in TYPES))) {
                GraphqlCondition(name, type as String?)
            } else {
                null
            }
            return MockConditions(keys, condition)
        }
    }
}

internal object GraphqlMatching {
    /** Longest text (UTF-16 code units: a body or a `query` URL parameter) the GraphQL reading looks at. */
    const val MAX_CHARS = 64 * 1024

    /** Bodies longer than this many bytes have more than [MAX_CHARS] UTF-16 units and are never decoded. */
    const val MAX_BODY_BYTES = 3 * MAX_CHARS

    /** The matcher keys this SDK evaluates (`hello.sdk.mockMatchers`). */
    val MATCHERS: List<String> = listOf("graphql")

    /** Whether a rule (already matching method / URL / apps) holds for the request; see the reference. */
    fun conditionsHold(conditions: MockConditions, ops: () -> List<GraphqlOperation>?): Boolean {
        if (conditions.usedKeys.isEmpty()) return true
        if (conditions.usedKeys.any { it != "graphql" }) return false
        val condition = conditions.graphql ?: return false
        val found = ops() ?: return false
        return found.any { it.name == condition.operationName && (condition.operationType == null || it.type == condition.operationType) }
    }

    /** The reference's `graphqlOperationsOf`: the operation(s) of a request, or null when unknown. */
    fun operationsOf(method: String, url: String, contentType: String?, body: String?): List<GraphqlOperation>? {
        val raw = body ?: ""
        val trimmed = trimAsciiWhitespace(raw)
        if (trimmed.isNotEmpty()) {
            if (raw.length > MAX_CHARS) return null
            val ct = (contentType ?: "").lowercase()
            if (ct.contains("application/graphql") && !ct.contains("json")) {
                val first = documentOperations(trimmed).firstOrNull() ?: return null
                return listOf(first)
            }
            if (trimmed[0] != '{' && trimmed[0] != '[') return null
            val payloads = StrictJson.payloads(trimmed) ?: return null
            val ops = payloads.mapNotNull { payloadOperation(it.query, it.operationName) }
            return ops.ifEmpty { null }
        }
        if (method.uppercase() != "GET") return null
        val params = urlQueryParams(url) ?: return null
        val op = payloadOperation(params["query"], params["operationName"]) ?: return null
        return listOf(op)
    }

    /** One `{ query?, operationName? }` payload (values that are not strings arrive as null). */
    private fun payloadOperation(query: String?, operationName: String?): GraphqlOperation? {
        val name = operationName?.takeIf { it.isNotEmpty() }
        if (query != null) {
            if (query.length > MAX_CHARS) return null
            val ops = documentOperations(query)
            if (name != null) return GraphqlOperation(name, ops.firstOrNull { it.name == name }?.type)
            return ops.firstOrNull()
        }
        return name?.let { GraphqlOperation(it, null) }
    }

    private fun isNameStart(c: Char): Boolean = c in 'a'..'z' || c in 'A'..'Z' || c == '_'

    private fun isNameChar(c: Char): Boolean = isNameStart(c) || c in '0'..'9'

    /** Operation definitions of a GraphQL document, in order (fragments skipped); the reference's tokenizer. */
    fun documentOperations(doc: String): List<GraphqlOperation> {
        val ops = ArrayList<GraphqlOperation>()
        val n = doc.length
        var i = 0
        var depth = 0
        var parens = 0
        // A definition word was read at depth 0 and its selection set has not started yet.
        var pending = false
        while (i < n) {
            val c = doc[i]
            when {
                c == '#' -> while (i < n && doc[i] != '\n' && doc[i] != '\r') i++
                c == '"' -> if (doc.startsWith("\"\"\"", i)) {
                    i += 3
                    while (i < n && !doc.startsWith("\"\"\"", i)) i += if (doc.startsWith("\\\"\"\"", i)) 4 else 1
                    i = minOf(n, i + 3)
                } else {
                    i++
                    while (i < n && doc[i] != '"' && doc[i] != '\n') i += if (doc[i] == '\\') 2 else 1
                    i = minOf(n, i + 1)
                }
                c == '(' -> {
                    parens++
                    i++
                }
                c == ')' -> {
                    parens = maxOf(0, parens - 1)
                    i++
                }
                c == '{' -> {
                    if (depth == 0 && parens == 0) {
                        if (!pending) ops.add(GraphqlOperation(null, "query"))
                        pending = false
                    }
                    depth++
                    i++
                }
                c == '}' -> {
                    depth = maxOf(0, depth - 1)
                    i++
                }
                isNameStart(c) -> {
                    val start = i
                    while (i < n && isNameChar(doc[i])) i++
                    if (depth == 0 && parens == 0 && !pending) {
                        val word = doc.substring(start, i)
                        if (word == "query" || word == "mutation" || word == "subscription") {
                            var j = i
                            while (j < n) {
                                val d = doc[j]
                                if (d == '#') {
                                    while (j < n && doc[j] != '\n' && doc[j] != '\r') j++
                                } else if (d == ' ' || d == '\t' || d == '\n' || d == '\r' || d == ',' || d == '﻿') {
                                    j++
                                } else {
                                    break
                                }
                            }
                            if (j < n && isNameStart(doc[j])) {
                                var k = j
                                while (k < n && isNameChar(doc[k])) k++
                                ops.add(GraphqlOperation(doc.substring(j, k), word))
                                i = k
                            } else {
                                ops.add(GraphqlOperation(null, word))
                            }
                            pending = true
                        } else if (word == "fragment") {
                            pending = true
                        }
                    }
                }
                else -> i++
            }
        }
        return ops
    }

    private fun isAsciiSpace(c: Char): Boolean = c == ' ' || c == '\t' || c == '\n' || c == '\r'

    private fun trimAsciiWhitespace(s: String): String {
        var a = 0
        var b = s.length
        while (a < b && isAsciiSpace(s[a])) a++
        while (b > a && isAsciiSpace(s[b - 1])) b--
        return s.substring(a, b)
    }

    /** `name=value` pairs of a URL's query string (first occurrence wins); null when one cannot be decoded. */
    fun urlQueryParams(url: String): Map<String, String>? {
        val params = HashMap<String, String>()
        val q = url.indexOf('?')
        if (q < 0) return params
        val hash = url.indexOf('#', q)
        val query = url.substring(q + 1, if (hash < 0) url.length else hash)
        for (part in query.split('&')) {
            if (part.isEmpty()) continue
            val eq = part.indexOf('=')
            val rawKey = if (eq < 0) part else part.substring(0, eq)
            val rawValue = if (eq < 0) "" else part.substring(eq + 1)
            val key = decodeUriComponent(rawKey.replace('+', ' ')) ?: return null
            val value = decodeUriComponent(rawValue.replace('+', ' ')) ?: return null
            if (!params.containsKey(key)) params[key] = value
        }
        return params
    }

    /** JavaScript's `decodeURIComponent`: `%XX` runs decoded as strict UTF-8; null where it would throw. */
    fun decodeUriComponent(s: String): String? {
        if (s.indexOf('%') < 0) return s
        val out = StringBuilder(s.length)
        var i = 0
        val n = s.length
        while (i < n) {
            val c = s[i]
            if (c != '%') {
                out.append(c)
                i++
                continue
            }
            val bytes = java.io.ByteArrayOutputStream()
            while (i < n && s[i] == '%') {
                if (i + 2 >= n) return null
                val hi = Character.digit(s[i + 1], 16)
                val lo = Character.digit(s[i + 2], 16)
                if (hi < 0 || lo < 0 || s[i + 1].code > 0x7F || s[i + 2].code > 0x7F) return null
                bytes.write(hi * 16 + lo)
                i += 3
            }
            val raw = bytes.toByteArray()
            out.append(StrictUtf8.decode(raw, 0, raw.size) ?: return null)
        }
        return out.toString()
    }
}

/** Strict UTF-8 (no overlong forms, no encoded surrogates, nothing above U+10FFFF), producing UTF-16. */
internal object StrictUtf8 {
    /** Decodes [length] bytes from [offset]; null when they are not well-formed UTF-8. */
    fun decode(bytes: ByteArray, offset: Int, length: Int): String? {
        val end = offset + length
        val out = StringBuilder(length)
        var i = offset
        while (i < end) {
            val b0 = bytes[i].toInt() and 0xFF
            if (b0 < 0x80) {
                out.append(b0.toChar())
                i++
                continue
            }
            val need: Int
            var lower = 0x80
            var upper = 0xBF
            var cp: Int
            when (b0) {
                in 0xC2..0xDF -> {
                    need = 1
                    cp = b0 and 0x1F
                }
                in 0xE0..0xEF -> {
                    need = 2
                    cp = b0 and 0x0F
                    if (b0 == 0xE0) lower = 0xA0
                    if (b0 == 0xED) upper = 0x9F
                }
                in 0xF0..0xF4 -> {
                    need = 3
                    cp = b0 and 0x07
                    if (b0 == 0xF0) lower = 0x90
                    if (b0 == 0xF4) upper = 0x8F
                }
                else -> return null
            }
            if (i + need >= end) return null
            for (k in 1..need) {
                val b = bytes[i + k].toInt() and 0xFF
                if (b < lower || b > upper) return null
                lower = 0x80
                upper = 0xBF
                cp = (cp shl 6) or (b and 0x3F)
            }
            out.appendCodePoint(cp)
            i += need + 1
        }
        return out.toString()
    }

    /** The body text a matcher may read: well-formed UTF-8 (one leading BOM dropped, as `TextDecoder` does). */
    fun bodyText(bytes: ByteArray, length: Int): String? {
        val bom = length >= 3 && (bytes[0].toInt() and 0xFF) == 0xEF && (bytes[1].toInt() and 0xFF) == 0xBB && (bytes[2].toInt() and 0xFF) == 0xBF
        return if (bom) decode(bytes, 3, length - 3) else decode(bytes, 0, length)
    }
}

/**
 * Strict JSON reading for GraphQL payloads (RFC 8259 as `JSON.parse` accepts it: no comments, single quotes, trailing
 * commas, leading zeros or raw control characters; lone surrogate escapes allowed; any nesting depth, without
 * recursion). Only the `query` and `operationName` members of the payload objects (the top-level object, or the
 * objects directly inside a top-level array) are kept; the last duplicate key wins, like `JSON.parse`.
 */
internal object StrictJson {
    /** A payload's members: a string value, or null (absent, or a value that is not a string). */
    class Payload {
        var query: String? = null
        var operationName: String? = null
    }

    private class Frame(val isObject: Boolean, val isTopArray: Boolean, val payload: Payload?) {
        /** The member of [payload] the current value goes to: 1 = query, 2 = operationName, 0 = none. */
        var member = 0
    }

    private class Invalid : RuntimeException() {
        override fun fillInStackTrace(): Throwable = this
    }

    /** The payloads of a JSON document whose top-level value is an object or array; null when it is not valid JSON. */
    fun payloads(text: String): List<Payload>? = try {
        Reader(text).read()
    } catch (_: Invalid) {
        null
    }

    private class Reader(private val s: String) {
        private var pos = 0
        private val n = s.length
        private val stack = ArrayList<Frame>()
        private val payloads = ArrayList<Payload>()

        fun read(): List<Payload> {
            var expectValue = true
            while (true) {
                if (expectValue) {
                    expectValue = false
                    if (openValue()) {
                        expectValue = true
                        continue
                    }
                }
                // A value just ended: continue or close the enclosing container.
                if (stack.isEmpty()) break
                val top = stack[stack.size - 1]
                skipWs()
                if (pos >= n) throw Invalid()
                val c = s[pos++]
                if (top.isObject) {
                    when (c) {
                        ',' -> {
                            readKey(top)
                            expectValue = true
                        }
                        '}' -> close()
                        else -> throw Invalid()
                    }
                } else {
                    when (c) {
                        ',' -> expectValue = true
                        ']' -> close()
                        else -> throw Invalid()
                    }
                }
            }
            skipWs()
            if (pos != n) throw Invalid()
            return payloads
        }

        private fun close() {
            val frame = stack.removeAt(stack.size - 1)
            frame.payload?.let { payloads.add(it) }
        }

        private fun skipWs() {
            while (pos < n) {
                val c = s[pos]
                if (c == ' ' || c == '\t' || c == '\n' || c == '\r') pos++ else break
            }
        }

        /** Sets the current member of the enclosing payload object (if any) to [value]. */
        private fun assign(value: String?) {
            val top = stack.lastOrNull() ?: return
            val payload = top.payload ?: return
            when (top.member) {
                1 -> payload.query = value
                2 -> payload.operationName = value
            }
        }

        /** Reads `"key" :` inside [frame] and selects the payload member it names. */
        private fun readKey(frame: Frame) {
            skipWs()
            if (pos >= n || s[pos] != '"') throw Invalid()
            val key = readString(frame.payload != null)
            frame.member = when (key) {
                "query" -> 1
                "operationName" -> 2
                else -> 0
            }
            skipWs()
            if (pos >= n || s[pos] != ':') throw Invalid()
            pos++
        }

        /**
         * Reads one value. A container is opened (pushed); returns true when its first member is due next (no
         * recursion: nesting depth costs heap, not stack). Scalars and empty containers are read whole.
         */
        private fun openValue(): Boolean {
            skipWs()
            if (pos >= n) throw Invalid()
            when (val c = s[pos]) {
                '{', '[' -> {
                    assign(null)
                    pos++
                    val isObject = c == '{'
                    val payload = if (isObject && (stack.isEmpty() || (stack.size == 1 && stack[0].isTopArray))) Payload() else null
                    val frame = Frame(isObject, !isObject && stack.isEmpty(), payload)
                    stack.add(frame)
                    skipWs()
                    if (pos < n && s[pos] == (if (isObject) '}' else ']')) {
                        pos++
                        close()
                        return false
                    }
                    if (isObject) readKey(frame)
                    return true
                }
                '"' -> {
                    val top = stack.lastOrNull()
                    val wanted = top?.payload != null && top.member != 0
                    val value = readString(wanted)
                    assign(if (wanted) value else null)
                }
                't' -> literal("true")
                'f' -> literal("false")
                'n' -> literal("null")
                else -> if (c == '-' || c in '0'..'9') {
                    number()
                    assign(null)
                } else {
                    throw Invalid()
                }
            }
            return false
        }

        private fun literal(word: String) {
            if (!s.startsWith(word, pos)) throw Invalid()
            pos += word.length
            assign(null)
        }

        private fun digits(): Int {
            val start = pos
            while (pos < n && s[pos] in '0'..'9') pos++
            return pos - start
        }

        private fun number() {
            if (s[pos] == '-') pos++
            if (pos >= n) throw Invalid()
            if (s[pos] == '0') {
                pos++
            } else if (s[pos] in '1'..'9') {
                digits()
            } else {
                throw Invalid()
            }
            if (pos < n && s[pos] == '.') {
                pos++
                if (digits() == 0) throw Invalid()
            }
            if (pos < n && (s[pos] == 'e' || s[pos] == 'E')) {
                pos++
                if (pos < n && (s[pos] == '+' || s[pos] == '-')) pos++
                if (digits() == 0) throw Invalid()
            }
        }

        /** Reads a string starting at the opening quote; decodes it only when [decode] (else returns ""). */
        private fun readString(decode: Boolean): String {
            pos++ // opening quote
            val out = if (decode) StringBuilder() else null
            while (true) {
                if (pos >= n) throw Invalid()
                val c = s[pos]
                when {
                    c == '"' -> {
                        pos++
                        return out?.toString() ?: ""
                    }
                    c == '\\' -> {
                        if (pos + 1 >= n) throw Invalid()
                        when (s[pos + 1]) {
                            '"' -> out?.append('"')
                            '\\' -> out?.append('\\')
                            '/' -> out?.append('/')
                            'b' -> out?.append('\b')
                            'f' -> out?.append('\u000C')
                            'n' -> out?.append('\n')
                            'r' -> out?.append('\r')
                            't' -> out?.append('\t')
                            'u' -> {
                                if (pos + 5 >= n) throw Invalid()
                                var code = 0
                                for (k in 2..5) {
                                    val d = s[pos + k]
                                    val v = if (d.code < 0x80) Character.digit(d, 16) else -1
                                    if (v < 0) throw Invalid()
                                    code = code * 16 + v
                                }
                                out?.append(code.toChar())
                                pos += 4
                            }
                            else -> throw Invalid()
                        }
                        pos += 2
                    }
                    c < ' ' -> throw Invalid()
                    else -> {
                        out?.append(c)
                        pos++
                    }
                }
            }
        }
    }
}
