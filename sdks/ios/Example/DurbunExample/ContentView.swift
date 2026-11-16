import SwiftUI

/// One screen with every part of the SDK.
struct ContentView: View {
    @EnvironmentObject private var demo: Demo
    @State private var confirmCrash = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text(demo.status)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    if demo.results.isEmpty {
                        Text("Results show up here and in the Dürbün Mac app.")
                            .font(.footnote.monospaced())
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(Array(demo.results.enumerated()), id: \.offset) { _, line in
                            Text(line).font(.footnote.monospaced())
                        }
                    }
                }

                Section {
                    row("GET 200", "arrow.down.circle", demo.get200)
                    row("GET 404", "questionmark.circle", demo.get404)
                    row("Slow (2 s)", "tortoise", demo.slow)
                    row("POST JSON", "arrow.up.circle", demo.postJSON)
                    row("Failing (connection refused)", "xmark.octagon", demo.failing)
                    row("HTTPS example.com", "lock", demo.https)
                } header: {
                    Text("Network (URLSession)")
                } footer: {
                    Text("Each request is one row in the Network tab, with headers, body and timings.")
                }

                Section {
                    row("WebSocket", "arrow.left.arrow.right", demo.webSocket)
                    row("Event stream", "dot.radiowaves.left.and.right", demo.eventStream)
                } header: {
                    Text("Streams")
                } footer: {
                    Text("A URLSessionWebSocketTask and a Server-Sent Events response, with every message.")
                }

                Section {
                    row("Log every level", "text.alignleft", demo.logEveryLevel)
                    row("Send event", "sparkles", demo.event)
                } header: {
                    Text("Logs and events")
                }

                Section {
                    NavigationLink {
                        WebViewScreen()
                    } label: {
                        Label("Open the web view", systemImage: "globe")
                    }
                } header: {
                    Text("Web view")
                } footer: {
                    Text("A page whose fetch, XMLHttpRequest and console lines reach the Mac app through DurbunWebView.")
                }

                Section {
                    Button(role: .destructive) {
                        confirmCrash = true
                    } label: {
                        Label("Crash the app", systemImage: "bolt.trianglebadge.exclamationmark")
                    }
                } header: {
                    Text("Crash")
                } footer: {
                    Text("An Objective-C exception reaches the Mac app at once; a Swift fatalError on the next launch.")
                }

                Section {
                    Toggle("Verbose logging", isOn: $demo.verbose)
                    Picker("Items per JSON response", selection: $demo.items) {
                        ForEach([3, 50, 500], id: \.self) { Text("\($0)").tag($0) }
                    }
                } header: {
                    Text("Tools")
                } footer: {
                    Text("The Mac app's Device → App tools lists this app's own tools: \"Run every request\", \"Verbose logging\" and \"Items per JSON response\".")
                }
            }
            .navigationTitle("Dürbün example")
            .confirmationDialog("Crash the app?", isPresented: $confirmCrash, titleVisibility: .visible) {
                Button("Objective-C exception", role: .destructive) { demo.crashWithException() }
                Button("Swift fatalError", role: .destructive) { demo.crashWithFatalError() }
            } message: {
                Text("The app closes. Open it again to keep going.")
            }
        }
    }

    private func row(_ title: String, _ symbol: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: symbol)
        }
    }
}
