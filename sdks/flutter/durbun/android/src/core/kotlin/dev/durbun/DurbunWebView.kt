package dev.durbun

import android.util.Log
import android.webkit.WebView
import dev.durbun.internal.DocumentStartScripts
import dev.durbun.internal.WebViewBridgeScript
import dev.durbun.internal.WebViewChannel
import dev.durbun.internal.WebViewReceiver
import java.util.WeakHashMap

/**
 * Shows what a page inside a [WebView] does: its `fetch` and `XMLHttpRequest` calls (method, URL, status, headers,
 * bodies, timings) appear in the Network tab, and its `console.*` lines and uncaught errors in the log stream,
 * marked as coming from the web view (client `webview:fetch` / `webview:xhr`, tag `webview`).
 *
 * ```kotlin
 * webView.settings.javaScriptEnabled = true
 * DurbunWebView.attach(webView)                 // before the first loadUrl
 * webView.webViewClient = object : WebViewClient() {
 *     override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
 *         DurbunWebView.onPageStarted(view)     // needed when the app does not have androidx.webkit
 *     }
 * }
 * webView.loadUrl("https://example.com/")
 * ```
 *
 * A small script is added to every page. It wraps `fetch`, `XMLHttpRequest` and `console` without changing what
 * the page sees: the original runs with the same arguments and returns the same result, bodies are read from
 * clones, and its own errors are swallowed. It reports through one JavaScript interface with a single method.
 * The page can call that method too, so an entry from a web view is whatever the page claims; messages are
 * size- and rate-limited, and bodies follow the SDK's capture settings.
 *
 * - With androidx.webkit in the app and a WebView that supports it (`WebViewFeature.DOCUMENT_START_SCRIPT`), the
 *   script runs at document start in every frame, before the page's own scripts. Otherwise [onPageStarted]
 *   injects it into the main frame when a page starts loading: requests the page makes before that are missed.
 * - Call both from the main thread. JavaScript must be on ([android.webkit.WebSettings.setJavaScriptEnabled]).
 * - Nothing happens while Dürbün is not running (release builds, `durbun-noop`, [DurbunOptions.enabled] off):
 *   then the web view is not touched at all. Requests follow [DurbunOptions.captureNetwork],
 *   [DurbunOptions.ignoredHosts] and [DurbunOptions.redactHeaders].
 * - Not captured: WebSocket and EventSource connections of the page, `navigator.sendBeacon`, and what the page
 *   loads itself (documents, images, scripts, styles).
 */
object DurbunWebView {
    private const val TAG = "Durbun"

    /** Name of the JavaScript interface the script reports through. */
    private const val INTERFACE = "__durbun"

    private class Attachment(val documentStart: Boolean)

    private val attached = WeakHashMap<WebView, Attachment>()

    /**
     * Adds the bridge to [webView]. Returns true when it is attached (also when it already was), false when
     * Dürbün is not running (the web view is left untouched) or the bridge could not be added.
     */
    @JvmStatic
    fun attach(webView: WebView): Boolean {
        val core = Durbun.coreOrNull() ?: return false
        return try {
            synchronized(attached) {
                if (attached.containsKey(webView)) return true
            }
            val receiver = WebViewReceiver({ Durbun.coreOrNull() })
            webView.addJavascriptInterface(WebViewChannel(receiver), INTERFACE)
            val documentStart = DocumentStartScripts.add(webView, WebViewBridgeScript.SOURCE)
            synchronized(attached) { attached[webView] = Attachment(documentStart) }
            if (!documentStart) {
                core.logger.debug("DurbunWebView: no document-start scripts here (androidx.webkit); onPageStarted injects the bridge.")
            }
            true
        } catch (t: Throwable) {
            Log.w(TAG, "DurbunWebView could not attach to the web view.", t)
            false
        }
    }

    /**
     * Call from your `WebViewClient.onPageStarted`. Injects the bridge into the page that starts loading when the
     * script cannot run at document start; otherwise (and for a web view without [attach]) it does nothing.
     */
    @JvmStatic
    fun onPageStarted(webView: WebView) {
        try {
            val attachment = synchronized(attached) { attached[webView] } ?: return
            if (attachment.documentStart || Durbun.coreOrNull() == null) return
            webView.evaluateJavascript(WebViewBridgeScript.SOURCE, null)
        } catch (_: Throwable) {
            // The page loads as usual without the bridge.
        }
    }
}
