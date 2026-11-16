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
    /** `when`: conditions besides method / URL / apps (mock matching v2). */
    val conditions: MockConditions = MockConditions.NONE,
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
                conditions = MockConditions.fromJson(map["when"]),
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
 * Exact port of `mockRuleMatches` / `mockRuleMatchesRequest` / `findMockRuleForRequest` from the shared protocol, so
 * every SDK makes the same decision for the same rule:
 *  - method: `*` matches anything, otherwise case-insensitive equality;
 *  - contains / exact / glob: case-insensitive; glob `*` = any run of characters (including `/`),
 *    `?` = one character, and the WHOLE url must match;
 *  - regex: pattern as-is (case-sensitive), searched anywhere in the url; an invalid pattern never matches;
 *  - apps: empty = every app, otherwise it must contain the app id;
 *  - conditions (`when`): every one must hold; `graphql` = one of the request's GraphQL operations has that name
 *    (and type); an operation that cannot be read (no body held, body too large, not GraphQL) never matches, and
 *    an unknown condition key never matches.
 */
internal object MockMatcher {
    /** What JavaScript's `.` refuses to match (no `s` flag); `*` / `?` in globs inherit that. */
    private const val JS_DOT = "[^\\n\\r\\u2028\\u2029]"

    /** The reference's `mockRuleMatches`: a rule with conditions is checked without a body (GET URLs only). */
    fun matches(rule: MockRule, method: String, url: String, appId: String?): Boolean =
        matchesRequest(rule, MockRequest(method, url, appId))

    /** The reference's `mockRuleMatchesRequest`. */
    fun matchesRequest(rule: MockRule, request: MockRequest): Boolean {
        if (!urlMatches(rule, request.method, request.url, request.appId)) return false
        return GraphqlMatching.conditionsHold(rule.conditions) { operationsOf(request) }
    }

    /** Method / URL / apps part of the matcher. */
    fun urlMatches(rule: MockRule, method: String, url: String, appId: String?): Boolean {
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
        find(rules, MockRequest(method, url, appId))

    /**
     * The reference's `findMockRuleForRequest`: first matching rule. The body is read at most once, and only when a
     * rule with a condition matches method / URL / apps.
     */
    fun find(rules: List<MockRule>, request: MockRequest): MockRule? {
        var ops: List<GraphqlOperation>? = null
        var opsRead = false
        val lazyOps = {
            if (!opsRead) {
                opsRead = true
                ops = operationsOf(request)
            }
            ops
        }
        for (rule in rules) {
            if (!urlMatches(rule, request.method, request.url, request.appId)) continue
            if (GraphqlMatching.conditionsHold(rule.conditions, lazyOps)) return rule
        }
        return null
    }

    /**
     * Whether a decision for this method / URL may depend on the body: the first rule matching method / URL / apps
     * has a condition. Lets a caller read a body only when a rule could use it.
     */
    fun needsBody(rules: List<MockRule>, method: String, url: String, appId: String?): Boolean {
        for (rule in rules) {
            if (!urlMatches(rule, method, url, appId)) continue
            if (rule.conditions.usedKeys.isEmpty()) return false
            if (rule.conditions.graphql != null && rule.conditions.usedKeys.size == 1) return true
        }
        return false
    }

    private fun operationsOf(request: MockRequest): List<GraphqlOperation>? =
        GraphqlMatching.operationsOf(request.method, request.url, request.contentType, request.bodyText())

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
