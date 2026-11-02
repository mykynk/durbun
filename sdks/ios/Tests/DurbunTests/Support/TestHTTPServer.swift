import Foundation
import Network

/// A tiny HTTP/1.1 responder on 127.0.0.1 (one request per connection, `Connection: close`).
/// Understands Content-Length and chunked request bodies; records every request.
final class TestHTTPServer {
    struct Request {
        var method: String
        var path: String
        /// Lowercased header names.
        var headers: [String: String]
        var body: Data
    }

    struct Response {
        var status = 200
        var headers: [(String, String)] = []
        var body = Data()
        var delay: TimeInterval = 0

        static func json(_ text: String, status: Int = 200) -> Response {
            Response(status: status, headers: [("Content-Type", "application/json; charset=utf-8")], body: Data(text.utf8))
        }
    }

    private let queue = DispatchQueue(label: "test.http-server")
    private var listener: NWListener?
    private let lock = NSLock()
    private var recorded: [Request] = []
    var handler: (Request) -> Response = { _ in Response() }
    private(set) var port: UInt16 = 0

    var baseURL: String { "http://127.0.0.1:\(port)" }

    var requests: [Request] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func start() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            if case .ready = state { ready.signal() }
            if case .failed = state { ready.signal() }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            connection.start(queue: self.queue)
            self.read(connection, buffer: Data())
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        port = listener.port?.rawValue ?? 0
        self.listener = listener
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = Self.parse(buffer) {
                self.respond(connection, to: request)
            } else if complete || error != nil {
                connection.cancel()
            } else {
                self.read(connection, buffer: buffer)
            }
        }
    }

    private func respond(_ connection: NWConnection, to request: Request) {
        lock.lock()
        recorded.append(request)
        lock.unlock()
        let response = handler(request)
        let send = {
            var head = "HTTP/1.1 \(response.status) Test\r\n"
            head += "Content-Length: \(response.body.count)\r\n"
            head += "Connection: close\r\n"
            for (name, value) in response.headers { head += "\(name): \(value)\r\n" }
            head += "\r\n"
            var bytes = Data(head.utf8)
            bytes.append(response.body)
            connection.send(content: bytes, completion: .contentProcessed { _ in connection.cancel() })
        }
        if response.delay > 0 {
            queue.asyncAfter(deadline: .now() + response.delay, execute: send)
        } else {
            send()
        }
    }

    /// Returns a request once it is complete in `buffer`.
    static func parse(_ buffer: Data) -> Request? {
        guard let headerEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else { return nil }
        let head = String(decoding: buffer[buffer.startIndex..<headerEnd.lowerBound], as: UTF8.self)
        var lines = head.components(separatedBy: "\r\n")
        let requestLine = lines.removeFirst().split(separator: " ")
        guard requestLine.count >= 2 else { return nil }
        var headers: [String: String] = [:]
        for line in lines {
            guard let colon = line.firstIndex(of: ":") else { continue }
            headers[line[..<colon].lowercased()] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let rest = buffer[headerEnd.upperBound...]
        var body = Data()
        if headers["transfer-encoding"]?.lowercased() == "chunked" {
            var cursor = rest.startIndex
            while true {
                guard let lineEnd = rest[cursor...].range(of: Data("\r\n".utf8)) else { return nil }
                let sizeText = String(decoding: rest[cursor..<lineEnd.lowerBound], as: UTF8.self)
                guard let size = Int(sizeText.split(separator: ";").first ?? "", radix: 16) else { return nil }
                let dataStart = lineEnd.upperBound
                if size == 0 { break }
                guard rest.distance(from: dataStart, to: rest.endIndex) >= size + 2 else { return nil }
                let dataEnd = rest.index(dataStart, offsetBy: size)
                body.append(rest[dataStart..<dataEnd])
                cursor = rest.index(dataEnd, offsetBy: 2)
            }
        } else if let length = headers["content-length"].flatMap(Int.init), length > 0 {
            guard rest.count >= length else { return nil }
            body = Data(rest.prefix(length))
        }
        return Request(method: String(requestLine[0]), path: String(requestLine[1]), headers: headers, body: body)
    }
}
