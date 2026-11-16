package dev.durbun.internal

import android.webkit.JavascriptInterface

/**
 * The only object a page in an attached web view can reach (`window.__durbun`): one method that hands a message
 * to the receiver. It runs on the WebView's JavaScript bridge thread.
 */
internal class WebViewChannel(private val receiver: WebViewReceiver) {
    @JavascriptInterface
    fun post(message: String?) {
        receiver.receive(message)
    }
}
