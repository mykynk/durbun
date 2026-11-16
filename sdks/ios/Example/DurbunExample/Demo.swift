import Durbun
import Foundation

/// What the buttons (and the app's own Dürbün tools) do. Each result is shown on screen and in the Mac app.
@MainActor
final class Demo: ObservableObject {
    @Published private(set) var results: [String] = []
    @Published private(set) var status = ""
    @Published var verbose = false
    @Published var items = 3

    let server = DemoServer()

    /// The app's own session, created after `Durbun.start()`: sessions created after it are captured
    /// (`URLSession.shared` is too).
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 15
        return URLSession(configuration: configuration)
    }()

    private var statusObserver: NSObjectProtocol?

    init() {
        refreshStatus()
        statusObserver = NotificationCenter.default.addObserver(
            forName: Durbun.connectionStatusDidChangeNotification, object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.refreshStatus() }
        }
        registerTools()
    }

    func refreshStatus() {
        status = Durbun.isRunning ? "Dürbün: \(Durbun.connectionStatus.description)" : "Dürbün is not running in this build."
    }

    // MARK: Network (URLSession)

    func get200() { loadURL("GET 200") { $0.baseURL.appendingPathComponent("json").withQuery("items=\(self.items)") } }
    func get404() { loadURL("GET 404") { $0.baseURL.appendingPathComponent("missing") } }
    func slow() { loadURL("Slow (2 s)") { $0.baseURL.appendingPathComponent("slow").withQuery("ms=2000") } }

    func postJSON() {
        load("POST JSON") { ports in
            var request = URLRequest(url: ports.baseURL.appendingPathComponent("echo"))
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue("Bearer sample-token", forHTTPHeaderField: "Authorization") // masked by redactHeaders
            request.httpBody = Data(#"{"name":"Ada","plan":"premium","tags":["beta","ios","android"]}"#.utf8)
            return request
        }
    }

    /// Port 1 on the device: nothing listens there, so the request fails with "could not connect".
    func failing() { loadURL("Failing (connection refused)") { _ in URL(string: "http://127.0.0.1:1/unreachable")! } }

    /// A real HTTPS request: DNS, TCP and TLS times come from URLSessionTaskMetrics.
    func https() { loadURL("HTTPS example.com") { _ in URL(string: "https://example.com/")! } }

    func runAll() {
        get200(); get404(); slow(); postJSON(); failing(); eventStream(); webSocket()
    }

    private func loadURL(_ label: String, _ make: @escaping (DemoServer.Ports) -> URL) {
        load(label) { URLRequest(url: make($0)) }
    }

    private func load(_ label: String, _ make: @escaping (DemoServer.Ports) -> URLRequest) {
        Task {
            let request = make(await server.ready())
            if verbose { Durbun.debug("Starting \(label)", tag: "sample", data: ["url": request.url?.absoluteString ?? ""]) }
            do {
                let (data, response) = try await session.data(for: request)
                let code = (response as? HTTPURLResponse)?.statusCode ?? 0
                report("\(label) → \(code) · \(data.count) bytes")
            } catch {
                report("\(label) → \(error.localizedDescription)")
            }
        }
    }

    // MARK: Streams

    /// Server-Sent Events read with `bytes(for:)`: the response shows up at once, then every event.
    func eventStream() {
        Task {
            let ports = await server.ready()
            var request = URLRequest(url: ports.baseURL.appendingPathComponent("events"))
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            do {
                let (bytes, _) = try await session.bytes(for: request)
                var events = 0
                for try await line in bytes.lines where line.hasPrefix("data:") { events += 1 }
                report("Event stream → \(events) events")
            } catch {
                report("Event stream → \(error.localizedDescription)")
            }
        }
    }

    /// A `URLSessionWebSocketTask`: the handshake and every message in both directions show up.
    func webSocket() {
        Task {
            let ports = await server.ready()
            let task = session.webSocketTask(with: ports.webSocketURL)
            task.resume()
            do {
                try await task.send(.string("hello"))
                try await task.send(.string(#"{"type":"subscribe","channel":"prices"}"#))
                try await task.send(.data(Data([1, 2, 3, 4])))
                var received = 0
                while received < 4 {
                    _ = try await task.receive()
                    received += 1
                }
                task.cancel(with: .normalClosure, reason: Data("done".utf8))
                report("WebSocket → closed, \(received) messages received")
            } catch {
                report("WebSocket → \(error.localizedDescription)")
            }
        }
    }

    // MARK: Logs, events, crashes

    func logEveryLevel() {
        Durbun.verbose("A verbose line", tag: "sample")
        Durbun.debug("A debug line", tag: "sample", data: ["cache": "warm", "entries": 128])
        Durbun.info("User logged in", tag: "auth", data: ["userId": 42, "plan": "premium"])
        Durbun.warning("Sync is slow", tag: "sync", data: ["ms": 2300])
        Durbun.error("Payment failed", error: URLError(.notConnectedToInternet), tag: "payment")
        print("A print line (captured from stdout; Xcode's console still shows it)")
        report("Logs → 5 Dürbün lines and 1 print line")
    }

    func event() {
        Durbun.event("purchase", ["amount": 49.9, "currency": "USD", "items": 2])
        report("Event → purchase")
    }

    /// An uncaught Objective-C exception: reported at once, then the app closes.
    func crashWithException() {
        NSException(name: .internalInconsistencyException, reason: "Crash button pressed in the Dürbün example").raise()
    }

    /// A Swift runtime trap: reported on the next launch, with the last console lines and a backtrace.
    func crashWithFatalError() -> Never {
        fatalError("Crash button pressed in the Dürbün example")
    }

    // MARK: The app's own tools (Device → App tools in the Mac app)

    private func registerTools() {
        Durbun.registerAction(DurbunAction(id: "sample.runAll", label: "Run every request")) { [weak self] _ in
            self?.runAll()
            return nil
        }
        Durbun.registerAction(DurbunAction(id: "sample.verbose", label: "Verbose logging", kind: .toggle(verbose))) { [weak self] params in
            let on = params["value"] as? Bool ?? false
            self?.verbose = on
            Durbun.info("Verbose logging is \(on ? "on" : "off")", tag: "sample")
            return nil
        }
        let options = ["3", "50", "500"].map { DurbunAction.Option(value: $0, label: $0) }
        Durbun.registerAction(
            DurbunAction(id: "sample.items", label: "Items per JSON response", kind: .select(options: options, value: String(items)))
        ) { [weak self] params in
            if let value = params["value"] as? String, let count = Int(value) { self?.items = count }
            return nil
        }
    }

    private func report(_ line: String) {
        results.insert(line, at: 0)
        if results.count > 6 { results.removeLast(results.count - 6) }
    }
}

private extension URL {
    func withQuery(_ query: String) -> URL {
        var components = URLComponents(url: self, resolvingAgainstBaseURL: false)!
        components.percentEncodedQuery = query
        return components.url!
    }
}
