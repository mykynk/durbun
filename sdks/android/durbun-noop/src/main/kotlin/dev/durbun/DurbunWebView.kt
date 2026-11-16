package dev.durbun

import android.webkit.WebView

/** No-op web view bridge for release builds: the web view is never touched. */
object DurbunWebView {
    /** Does nothing and returns false. */
    @JvmStatic
    fun attach(webView: WebView): Boolean = false

    /** Does nothing. */
    @JvmStatic
    fun onPageStarted(webView: WebView) = Unit
}
