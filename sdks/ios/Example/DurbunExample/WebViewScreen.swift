import Durbun
import SwiftUI
import WebKit

/// A web view whose page (served by the demo server) calls fetch, XMLHttpRequest and console. With DurbunWebView
/// attached, those show up in the Mac app's Network tab and log stream, marked as coming from the web view.
struct WebViewScreen: View {
    @EnvironmentObject private var demo: Demo
    @State private var url: URL?

    var body: some View {
        Group {
            if let url {
                WebView(url: url)
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Web view")
        .navigationBarTitleDisplayMode(.inline)
        .task { url = await demo.server.ready().baseURL.appendingPathComponent("page") }
    }
}

private struct WebView: UIViewRepresentable {
    let url: URL

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        DurbunWebView.attach(to: configuration) // before the web view is created: every page is reported
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.load(URLRequest(url: url))
        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}
}
