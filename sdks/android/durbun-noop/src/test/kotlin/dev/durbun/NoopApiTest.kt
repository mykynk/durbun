package dev.durbun

import okhttp3.OkHttpClient
import okhttp3.Protocol
import okhttp3.Request
import okhttp3.Response
import okhttp3.ResponseBody.Companion.toResponseBody
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** The no-op module compiles against the same calls as the real one and does nothing. */
class NoopApiTest {
    @Test
    fun everyCallIsANoOp() {
        Durbun.stop()
        Durbun.log(Level.INFO, "auth", "Logged in", data = mapOf("userId" to 42))
        Durbun.v("t", "v")
        Durbun.d("t", "d", mapOf("a" to 1))
        Durbun.i("t", "i")
        Durbun.w("t", "w", throwable = IllegalStateException())
        Durbun.e("t", "e", null, RuntimeException("x"))
        Durbun.event("purchase", mapOf("amount" to 49.9))
        Durbun.event("opened")
        val action = DurbunAction.toggle("app.staging", "Use staging API", initial = false) { }
        Durbun.addAction(action)
        Durbun.removeAction("app.staging")
        assertFalse(Durbun.isStarted)
        assertFalse(Durbun.isConnected)
        assertEquals("0.2.0", Durbun.VERSION)
        assertEquals(Level.ERROR, Level.fromPriority(6))
        assertEquals(9751, DurbunOptions().port)
        assertNull(DurbunOptions().host)
    }

    @Test
    fun interceptorPassesThrough() {
        val client = OkHttpClient.Builder()
            .addInterceptor(DurbunInterceptor(setOf("Authorization")))
            .addInterceptor { chain ->
                Response.Builder()
                    .request(chain.request())
                    .protocol(Protocol.HTTP_1_1)
                    .code(204)
                    .message("No Content")
                    .body("".toResponseBody(null))
                    .build()
            }
            .build()
        val response = client.newCall(Request.Builder().url("http://localhost/ping").build()).execute()
        assertEquals(204, response.code)
        response.close()
    }
}
