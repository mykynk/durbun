package dev.durbun

import okhttp3.Interceptor
import okhttp3.Response

/** No-op interceptor for release builds: passes every call through untouched. */
class DurbunInterceptor @JvmOverloads constructor(
    @Suppress("UNUSED_PARAMETER") redactHeaders: Set<String> = emptySet(),
) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response = chain.proceed(chain.request())
}
