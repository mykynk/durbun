package dev.durbun.sample

import android.annotation.SuppressLint
import android.app.Activity
import android.graphics.Bitmap
import android.os.Bundle
import android.webkit.WebView
import android.webkit.WebViewClient
import dev.durbun.DurbunWebView

/**
 * A web view whose page (served by the demo server) calls fetch, XMLHttpRequest and console. With DurbunWebView
 * attached, those show up in the Mac app's Network tab and log stream, marked as coming from the web view.
 */
class WebViewActivity : Activity() {
    private lateinit var webView: WebView

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        webView = WebView(this)
        webView.settings.javaScriptEnabled = true

        // 1. Attach before the first page loads.
        DurbunWebView.attach(webView)
        webView.webViewClient = object : WebViewClient() {
            override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                // 2. Without androidx.webkit (as in this sample) the bridge is injected here, as the page starts.
                DurbunWebView.onPageStarted(view)
            }
        }

        setContentView(webView)
        webView.loadUrl("${SampleApp.server.baseUrl}/page")
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
