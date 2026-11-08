package dev.durbun.internal

import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException

/** HTTP header as an ordered name/value pair (duplicates allowed). */
internal typealias Header = Pair<String, String>

internal sealed class MockAction {
    abstract val delayMs: Long

    class Respond(
        val status: Int,
        val headers: List<Header>,
        val body: String?,
        /** `utf8` or `base64`. */
        val bodyEncoding: String,
        override val delayMs: Long,
    ) : MockAction()

    class Delay(override val delayMs: Long) : MockAction()

    class Fail(
        /** `timeout` | `connection` | `dns` | `tls` | `custom`. */
        val error: String,
        val message: String?,
        override val delayMs: Long,
    ) : MockAction()
}

/** A mock rule pushed by the desktop (`welcome.mocks` / `{type:'mocks'}`), mirroring `MockRule` in the protocol. */
internal class MockRule(
    val id: String,
    val enabled: Boolean,
    val name: String?,
    /** `*` or an HTTP method. */
    val method: String,
    val url: String,
    /** `contains` | `exact` | `glob` | `regex`. */
    val match: String,
    /** Package names the rule applies to; empty = every app. */
    val apps: List<String>,
    val action: MockAction,
) {
    /** Compiled pattern for `glob` / `regex` rules; `null` when the pattern is invalid (never matches). */
    internal val pattern: Pattern? by lazy(LazyThreadSafetyMode.PUBLICATION) {
        when (match) {
            "glob" -> MockMatcher.globToPattern(url.lowercase())
            "regex" -> try {
                Pattern.compile(url)
            } catch (_: PatternSyntaxException) {
                null
            } catch (_: RuntimeException) {
                null
            }
            else -> null
        }
    }

    override fun toString(): String = "MockRule(id=$id, $method $match '$url' → ${action.javaClass.simpleName})"

    companion object {
        private const val MAX_DELAY_MS = 5 * 60_000L

        /** Parses one rule; `null` when the shape is unusable (the rule is then ignored). */
        fun fromJson(map: Map<String, Any?>): MockRule? {
            val id = map.str("id") ?: return null
            val actionMap = map.obj("action") ?: return null
            val action = parseAction(actionMap) ?: return null
            val apps = map.list("apps")?.mapNotNull { it as? String } ?: emptyList()
            return MockRule(
                id = id,
                enabled = map.bool("enabled") ?: false,
                name = map.str("name"),
                method = map.str("method")?.takeIf { it.isNotEmpty() } ?: "*",
                url = map.str("url") ?: "",
                match = map.str("match") ?: "contains",
                apps = apps,
                action = action,
            )
        }

        @Suppress("UNCHECKED_CAST")
        fun listFromJson(list: List<Any?>?): List<MockRule> =
            list.orEmpty().mapNotNull { (it as? Map<String, Any?>)?.let(::fromJson) }

        private fun delay(map: Map<String, Any?>): Long =
            (map.num("delayMs")?.toLong() ?: 0L).coerceIn(0L, MAX_DELAY_MS)

        private fun parseAction(map: Map<String, Any?>): MockAction? = when (map.str("type")) {
            "respond" -> MockAction.Respond(
                status = map.num("status")?.toInt() ?: 200,
                headers = parseHeaders(map.list("headers")),
                body = map.str("body"),
                bodyEncoding = if (map.str("bodyEncoding") == "base64") "base64" else "utf8",
                delayMs = delay(map),
            )
            "delay" -> MockAction.Delay(delay(map))
            "fail" -> MockAction.Fail(
                error = map.str("error") ?: "connection",
                message = map.str("message")?.takeIf { it.isNotEmpty() },
                delayMs = delay(map),
            )
            else -> null
        }

        private fun parseHeaders(list: List<Any?>?): List<Header> = list.orEmpty().mapNotNull { item ->
            val pair = item as? List<*> ?: return@mapNotNull null
            val name = pair.getOrNull(0) as? String ?: return@mapNotNull null
            val value = pair.getOrNull(1)?.toString() ?: ""
            name to value
        }
    }
}

/**
 * Exact port of `mockRuleMatches` / `findMockRule` from the shared protocol, so every SDK makes the same
 * decision for the same rule:
 *  - method: `*` matches anything, otherwise case-insensitive equality;
 *  - contains / exact / glob: case-insensitive; glob `*` = any run of characters (including `/`),
 *    `?` = one character, and the WHOLE url must match;
 *  - regex: pattern as-is (case-sensitive), searched anywhere in the url; an invalid pattern never matches;
 *  - apps: empty = every app, otherwise it must contain the app id.
 */
internal object MockMatcher {
    /** What JavaScript's `.` refuses to match (no `s` flag); `*` / `?` in globs inherit that. */
    private const val JS_DOT = "[^\\n\\r\\u2028\\u2029]"

    fun matches(rule: MockRule, method: String, url: String, appId: String?): Boolean {
        if (!rule.enabled) return false
        if (rule.apps.isNotEmpty() && (appId == null || appId !in rule.apps)) return false
        if (rule.method != "*" && rule.method.uppercase() != method.uppercase()) return false
        val u = url.lowercase()
        val p = rule.url.lowercase()
        return when (rule.match) {
            "contains" -> p.isNotEmpty() && u.contains(p)
            "exact" -> u == p
            "glob" -> rule.pattern?.matcher(u)?.matches() ?: false
            "regex" -> rule.pattern?.matcher(url)?.find() ?: false
            else -> false
        }
    }

    /** First enabled matching rule (rules are ordered; first match wins). */
    fun find(rules: List<MockRule>, method: String, url: String, appId: String?): MockRule? =
        rules.firstOrNull { matches(it, method, url, appId) }

    /** Glob → anchored regex: literal runs are quoted, `*` → any run, `?` → one character. */
    fun globToPattern(glob: String): Pattern? {
        val regex = StringBuilder()
        val literal = StringBuilder()
        fun flush() {
            if (literal.isNotEmpty()) {
                regex.append(Pattern.quote(literal.toString()))
                literal.setLength(0)
            }
        }
        for (ch in glob) {
            when (ch) {
                '*' -> {
                    flush()
                    regex.append(JS_DOT).append('*')
                }
                '?' -> {
                    flush()
                    regex.append(JS_DOT)
                }
                else -> literal.append(ch)
            }
        }
        flush()
        return try {
            Pattern.compile(regex.toString())
        } catch (_: RuntimeException) {
            null
        }
    }
}
