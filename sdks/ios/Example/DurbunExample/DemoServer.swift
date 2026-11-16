import Foundation
import Network

/// A tiny HTTP and WebSocket server inside the example app, on `127.0.0.1`, so every demo works offline and
/// gives the same answers each time. It is not part of the SDK and not a pattern to copy: it only gives the
/// requests something to talk to.
///
/// | Path | Answer |
/// |---|---|
/// | `GET /json?items=N` | 200, a JSON list of N items |
/// | `GET /missing` | 404 with a JSON error |
/// | `GET /slow?ms=N` | 200 after N milliseconds (at most 10 s) |
/// | `POST /echo` | 200, the request body back |
/// | `GET /events` | `text/event-stream`: five events, 400 ms apart |
/// | `GET /page` | the HTML page of the web view screen |
/// | `ws://…/ws` (second port) | a WebSocket that answers every text message with `echo: <text>` |
final class DemoServer: @unchecked Sendable {
    struct Ports: Sendable {
        let http: UInt16
        let webSocket: UInt16

        var baseURL: URL { URL(string: "http://127.0.0.1:\(http)")! }
        var webSocketURL: URL { URL(string: "ws://127.0.0.1:\(webSocket)/ws")! }
    }

    private let queue = DispatchQueue(label: "demo-server")
    private var httpListener: NWListener?
    private var webSocketListener: NWListener?
    private var ports: Ports?
    private var waiters: [(Ports) -> Void] = []

    init() {
        start()
    }

    /// The listening ports, once both listeners are ready.
    func ready() async -> Ports {
        await withCheckedContinuation { continuation in
            queue.async {
                if let ports = self.ports {
                    continuation.resume(returning: ports)
                } else {
                    self.waiters.append { continuation.resume(returning: $0) }
                }
            }
        }
    }

    private func start() {
        do {
            let http = try NWListener(using: Self.loopback())
            http.newConnectionHandler = { [weak self] in self?.acceptHTTP($0) }
            http.stateUpdateHandler = { [weak self] _ in self?.checkReady() }

            let webSocketParameters = Self.loopback()
            let webSocketOptions = NWProtocolWebSocket.Options()
            webSocketOptions.autoReplyPing = true
            webSocketParameters.defaultProtocolStack.applicationProtocols.insert(webSocketOptions, at: 0)
            let webSocket = try NWListener(using: webSocketParameters)
            webSocket.newConnectionHandler = { [weak self] in self?.acceptWebSocket($0) }
            webSocket.stateUpdateHandler = { [weak self] _ in self?.checkReady() }

            httpListener = http
            webSocketListener = webSocket
            http.start(queue: queue)
            webSocket.start(queue: queue)
        } catch {
            print("Demo server could not start: \(error)")
        }
    }

    private static func loopback() -> NWParameters {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        parameters.allowLocalEndpointReuse = true
        return parameters
    }

    private func checkReady() {
        guard ports == nil,
              let http = httpListener?.port?.rawValue, http != 0,
              let webSocket = webSocketListener?.port?.rawValue, webSocket != 0 else { return }
        let ready = Ports(http: http, webSocket: webSocket)
        ports = ready
        waiters.forEach { $0(ready) }
        waiters.removeAll()
    }

    // MARK: HTTP

    private struct Request {
        let method: String
        let path: String
        let query: [String: String]
        let headers: [String: String]
        let body: Data
    }

    private func acceptHTTP(_ connection: NWConnection) {
        connection.start(queue: queue)
        receive(connection, buffer: Data())
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65_536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = Self.parse(buffer) {
                self.route(request, connection)
            } else if isComplete || error != nil || buffer.count > 4_000_000 {
                connection.cancel()
            } else {
                self.receive(connection, buffer: buffer)
            }
        }
    }

    private static func parse(_ buffer: Data) -> Request? {
        guard let end = buffer.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: buffer[buffer.startIndex..<end.lowerBound], encoding: .utf8) else { return nil }
        var lines = head.components(separatedBy: "\r\n")
        let parts = lines.removeFirst().split(separator: " ")
        guard parts.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()] =
                line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "") ?? 0
        let bodyStart = end.upperBound
        guard buffer.count - bodyStart >= length else { return nil }
        let components = URLComponents(string: String(parts[1]))
        var query: [String: String] = [:]
        for item in components?.queryItems ?? [] { query[item.name] = item.value ?? "" }
        return Request(
            method: String(parts[0]),
            path: components?.path ?? "/",
            query: query,
            headers: headers,
            body: buffer[bodyStart..<(bodyStart + length)]
        )
    }

    private func route(_ request: Request, _ connection: NWConnection) {
        switch request.path {
        case "/json":
            let count = min(max(Int(request.query["items"] ?? "") ?? 3, 1), 2_000)
            let items = (1...count).map { #"{"id":\#($0),"name":"Item \#($0)","price":\#(Double($0) * 10 + 0.5)}"# }
            respond(connection, 200, "OK", "application/json", Data(#"{"items":[\#(items.joined(separator: ","))],"count":\#(count)}"#.utf8))
        case "/missing":
            respond(connection, 404, "Not Found", "application/json", Data(#"{"error":"not_found","message":"No such item"}"#.utf8))
        case "/slow":
            let ms = min(max(Int(request.query["ms"] ?? "") ?? 2_000, 0), 10_000)
            queue.asyncAfter(deadline: .now() + .milliseconds(ms)) {
                self.respond(connection, 200, "OK", "application/json", Data(#"{"waitedMs":\#(ms)}"#.utf8))
            }
        case "/echo":
            respond(connection, 200, "OK", request.headers["content-type"] ?? "application/octet-stream", request.body)
        case "/events":
            events(connection)
        case "/page":
            respond(connection, 200, "OK", "text/html; charset=utf-8", Data(WebPage.html.utf8))
        default:
            respond(connection, 404, "Not Found", "text/plain", Data("Not found".utf8))
        }
    }

    private func respond(_ connection: NWConnection, _ status: Int, _ reason: String, _ type: String, _ body: Data) {
        let head = "HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(body.count)\r\n"
            + "X-Demo-Server: durbun-example\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8) + body, completion: .contentProcessed { _ in connection.cancel() })
    }

    private func events(_ connection: NWConnection) {
        let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n"
        connection.send(content: Data(head.utf8), completion: .idempotent)
        for tick in 1...5 {
            queue.asyncAfter(deadline: .now() + .milliseconds(400 * tick)) {
                let event = "id: \(tick)\nevent: tick\ndata: {\"tick\":\(tick),\"of\":5}\n\n"
                connection.send(content: Data(event.utf8), completion: .contentProcessed { _ in
                    if tick == 5 { connection.cancel() }
                })
            }
        }
    }

    // MARK: WebSocket

    private func acceptWebSocket(_ connection: NWConnection) {
        connection.start(queue: queue)
        send(connection, .text, Data("connected to the demo server".utf8))
        receiveMessage(connection)
    }

    private func receiveMessage(_ connection: NWConnection) {
        connection.receiveMessage { [weak self] content, context, _, error in
            guard let self, error == nil else { return connection.cancel() }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            switch metadata?.opcode {
            case .text?:
                self.send(connection, .text, Data("echo: ".utf8) + (content ?? Data()))
            case .binary?:
                self.send(connection, .binary, content ?? Data())
            case .close?:
                self.send(connection, .close, Data()) { connection.cancel() }
                return
            default:
                break
            }
            self.receiveMessage(connection)
        }
    }

    private func send(_ connection: NWConnection, _ opcode: NWProtocolWebSocket.Opcode, _ data: Data, then: (() -> Void)? = nil) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: opcode)
        if opcode == .close { metadata.closeCode = .protocolCode(.normalClosure) }
        let context = NWConnection.ContentContext(identifier: "message", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in then?() })
    }
}
