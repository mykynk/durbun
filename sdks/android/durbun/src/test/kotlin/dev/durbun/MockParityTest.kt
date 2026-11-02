package dev.durbun

import dev.durbun.internal.Json
import dev.durbun.internal.MockAction
import dev.durbun.internal.MockMatcher
import dev.durbun.internal.MockRule
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `mock-parity.json` is generated from the protocol's reference `mockRuleMatches` / `findMockRule`
 * (tools/gen-mock-parity.mjs), so these assertions are the TypeScript results, not hand-written guesses.
 */
class MockParityTest {
    @Suppress("UNCHECKED_CAST")
    private val fixture: Map<String, Any?> by lazy {
        val text = javaClass.getResourceAsStream("/mock-parity.json")!!.use { it.readBytes().toString(Charsets.UTF_8) }
        Json.parse(text) as Map<String, Any?>
    }

    @Test
    fun matchesExactlyLikeTheProtocolReference() {
        val cases = fixture.listAt("cases")
        assertTrue("fixture should not be empty", cases.size >= 40)
        val failures = ArrayList<String>()
        for (item in cases) {
            @Suppress("UNCHECKED_CAST")
            val case = item as Map<String, Any?>
            val rule = MockRule.fromJson(case.objAt("rule"))
            assertNotNull("rule should parse: ${case["rule"]}", rule)
            val actual = MockMatcher.matches(rule!!, case["method"] as String, case["url"] as String, case["appId"] as String?)
            if (actual != case["expected"]) {
                failures += "${rule.match} '${rule.url}' ${case["method"]} ${case["url"]} → expected ${case["expected"]}, got $actual"
            }
        }
        assertTrue(failures.joinToString("\n"), failures.isEmpty())
    }

    @Test
    fun firstMatchingRuleWins() {
        val find = fixture.objAt("find")
        val rules = MockRule.listFromJson(find.listAt("rules"))
        assertEquals(4, rules.size)
        for (item in find.listAt("cases")) {
            @Suppress("UNCHECKED_CAST")
            val case = item as Map<String, Any?>
            val found = MockMatcher.find(rules, case["method"] as String, case["url"] as String, null)
            assertEquals("${case["method"]} ${case["url"]}", case["expectedId"], found?.id)
        }
    }

    @Test
    fun parsesEveryActionShape() {
        val rules = MockRule.listFromJson(
            Json.parse(
                """
                [
                  {"id":"a","enabled":true,"method":"POST","url":"/login","match":"contains",
                   "action":{"type":"respond","status":401,"headers":[["Content-Type","application/json"],["X-Trace","1"]],
                             "body":"eyJvayI6ZmFsc2V9","bodyEncoding":"base64","delayMs":120},"createdAt":1},
                  {"id":"b","enabled":true,"method":"*","url":"*/slow/*","match":"glob",
                   "action":{"type":"delay","delayMs":2500},"createdAt":2},
                  {"id":"c","enabled":true,"method":"GET","url":"^https://cdn\\.","match":"regex",
                   "action":{"type":"fail","error":"dns","message":"no DNS today"},"createdAt":3},
                  {"id":"d","enabled":true,"method":"GET","url":"x","match":"contains","action":{"type":"teleport"}},
                  {"enabled":true,"method":"GET","url":"x","match":"contains","action":{"type":"delay","delayMs":1}},
                  "not a rule"
                ]
                """.trimIndent(),
            ) as List<Any?>,
        )
        assertEquals(listOf("a", "b", "c"), rules.map { it.id })
        val respond = rules[0].action as MockAction.Respond
        assertEquals(401, respond.status)
        assertEquals("base64", respond.bodyEncoding)
        assertEquals(120L, respond.delayMs)
        assertEquals(listOf("Content-Type" to "application/json", "X-Trace" to "1"), respond.headers)
        assertEquals(2500L, (rules[1].action as MockAction.Delay).delayMs)
        val fail = rules[2].action as MockAction.Fail
        assertEquals("dns", fail.error)
        assertEquals("no DNS today", fail.message)
        assertEquals(0L, fail.delayMs)
    }

    @Test
    fun invalidRegexNeverMatchesAndIsCompiledOnce() {
        val rule = MockRule("r", true, null, "*", "([", "regex", emptyList(), MockAction.Delay(0))
        assertNull(rule.pattern)
        assertEquals(false, MockMatcher.matches(rule, "GET", "https://x.com/([", null))
    }
}
