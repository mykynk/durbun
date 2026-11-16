#if canImport(WebKit)
import Foundation
import WebKit

/// Shows what a page inside a `WKWebView` does: its `fetch` and `XMLHttpRequest` calls (method, URL, status,
/// headers, bodies, timings) appear in the Network tab, and its `console.*` lines and uncaught errors in the log
/// stream, marked as coming from the web view (client `webview:fetch` / `webview:xhr`, tag `webview`).
///
/// ```swift
/// let configuration = WKWebViewConfiguration()
/// DurbunWebView.attach(to: configuration)          // before the web view is created
/// let webView = WKWebView(frame: .zero, configuration: configuration)
/// ```
///
/// A small script runs at document start in every frame, before the page's own scripts. It wraps `fetch`,
/// `XMLHttpRequest` and `console` without changing what the page sees: the original runs with the same arguments
/// and returns the same result, bodies are read from clones, and its own errors are swallowed. It reports
/// through one script message handler. The page can post to that handler too, so an entry from a web view is
/// whatever the page claims; messages are size- and rate-limited, and bodies follow the SDK's capture settings.
///
/// - Nothing happens while Dürbün is not running (release builds, `DurbunOptions.enabled` off): the
///   configuration is not touched. Requests follow `captureNetwork`, `ignoredHosts` and `redactHeaders`.
/// - Not captured: WebSocket and EventSource connections of the page, `navigator.sendBeacon`, and what the page
///   loads itself (documents, images, scripts, styles).
public enum DurbunWebView {
    /// Name of the script message handler the bridge reports through.
    static let handlerName = "__durbun"

    @MainActor private static var attached = NSHashTable<WKUserContentController>.weakObjects()

    /// Adds the bridge to a configuration, before a web view is created with it: every page of that web view is
    /// reported, the first one included. Returns false when Dürbün is not running (nothing was changed).
    @MainActor
    @discardableResult
    public static func attach(to configuration: WKWebViewConfiguration) -> Bool {
        attach(to: configuration.userContentController)
    }

    /// Adds the bridge to an existing web view: pages it loads from now on are reported (a page already loaded is
    /// not). Returns false when Dürbün is not running (nothing was changed).
    @MainActor
    @discardableResult
    public static func attach(_ webView: WKWebView) -> Bool {
        attach(to: webView.configuration.userContentController)
    }

    @MainActor
    private static func attach(to controller: WKUserContentController) -> Bool {
        guard DurbunCore.shared.webViewBridgeAllowed else { return false }
        if attached.contains(controller) { return true }
        attached.add(controller)
        controller.add(WebViewMessageHandler(receiver: WebViewReceiver()), name: handlerName)
        controller.addUserScript(WKUserScript(
            source: WebViewBridgeScript.source,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: false
        ))
        return true
    }
}

/// The only thing a page can reach: a message handler that hands each message to the receiver.
private final class WebViewMessageHandler: NSObject, WKScriptMessageHandler {
    private let receiver: WebViewReceiver

    init(receiver: WebViewReceiver) {
        self.receiver = receiver
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        receiver.receive(message.body)
    }
}
#endif
