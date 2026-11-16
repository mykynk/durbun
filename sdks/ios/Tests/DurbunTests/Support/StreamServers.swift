import Foundation
import Network

/// A WebSocket server on 127.0.0.1 (Network.framework). Echoes text and binary messages, answers pings,
/// and obeys a few text commands:
///  - `close:<code>:<reason>` sends a close frame;
///  - `drop` cuts the TCP connection without a close frame;
///  - `push:<n>` sends the text messages `m1` … `m<n>`.
/// Records what it received (opcode and payload) to check that the app's traffic is untouched.
final class TestWebSocketServer {
    struct Received {
        var opcode: NWProtocolWebSocket.Opcode
        var data: Data
    }

    private let queue = DispatchQueue(label: "test.ws-server")
    private var listener: NWListener?
    private var connections: [NWConnection] = []
    private let lock = NSLock()
    private var recorded: [Received] = []
    private(set) var port: UInt16 = 0

    var received: [Received] {
        lock.lock()
        defer { lock.unlock() }
        return recorded
    }

    func start() throws {
        let options = NWProtocolWebSocket.Options()
        options.autoReplyPing = false // answered in `receive` (the automatic reply is not reliable here)
        options.setSubprotocols(["chat"])
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(options, at: 0)
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready, .failed: ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            guard let self else { return }
            self.connections.append(connection)
            connection.start(queue: self.queue)
            self.receive(on: connection)
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        port = listener.port?.rawValue ?? 0
        self.listener = listener
    }

    func stop() {
        queue.sync {
            listener?.cancel()
            listener = nil
            for connection in connections { connection.forceCancel() }
            connections.removeAll()
        }
    }

    private func receive(on connection: NWConnection) {
        connection.receiveMessage { [weak self] data, context, _, error in
            guard let self, error == nil else { return }
            let metadata = context?.protocolMetadata(definition: NWProtocolWebSocket.definition) as? NWProtocolWebSocket.Metadata
            guard let opcode = metadata?.opcode else { return }
            self.lock.lock()
            self.recorded.append(Received(opcode: opcode, data: data ?? Data()))
            self.lock.unlock()
            if opcode == .close { return }
            if opcode == .ping { self.send(data ?? Data(), opcode: .pong, on: connection) }
            if opcode == .text, let data, self.command(String(decoding: data, as: UTF8.self), on: connection) { return }
            if opcode == .text || opcode == .binary { self.send(data ?? Data(), opcode: opcode, on: connection) }
            self.receive(on: connection)
        }
    }

    /// Returns true when the connection ends here.
    private func command(_ text: String, on connection: NWConnection) -> Bool {
        let parts = text.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false).map(String.init)
        switch parts.first {
        case "close" where parts.count == 3:
            let metadata = NWProtocolWebSocket.Metadata(opcode: .close)
            metadata.closeCode = .applicationCode(UInt16(parts[1]) ?? 4000)
            let context = NWConnection.ContentContext(identifier: "close", metadata: [metadata])
            connection.send(content: Data(parts[2].utf8), contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
            return true
        case "drop":
            connection.forceCancel()
            return true
        case "push" where parts.count == 2:
            for index in 1...(Int(parts[1]) ?? 1) { send(Data("m\(index)".utf8), opcode: .text, on: connection) }
            receive(on: connection)
            return true
        default:
            return false
        }
    }

    private func send(_ data: Data, opcode: NWProtocolWebSocket.Opcode, on connection: NWConnection) {
        let metadata = NWProtocolWebSocket.Metadata(opcode: opcode)
        let context = NWConnection.ContentContext(identifier: "message", metadata: [metadata])
        connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { _ in })
    }
}

/// An HTTP/1.1 server on 127.0.0.1 that answers every request with `text/event-stream` headers and a
/// chunked body the test writes piece by piece (`send`), then ends (`finish`) or cuts (`cut`).
final class TestEventStreamServer {
    private let queue = DispatchQueue(label: "test.sse-server")
    private var listener: NWListener?
    private var connection: NWConnection?
    private let condition = NSCondition()
    private var requests: [TestHTTPServer.Request] = []
    private(set) var port: UInt16 = 0
    var contentType = "text/event-stream; charset=utf-8"

    var url: URL { URL(string: "http://127.0.0.1:\(port)/events")! }

    func start() throws {
        let parameters = NWParameters.tcp
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: .any)
        let listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready, .failed: ready.signal()
            default: break
            }
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
        queue.sync {
            listener?.cancel()
            listener = nil
            connection?.forceCancel()
            connection = nil
        }
    }

    var requestCount: Int {
        condition.lock()
        defer { condition.unlock() }
        return requests.count
    }

    /// Waits until `count` requests arrived and the last one's headers were answered (later chunks go
    /// to that one).
    func waitForRequest(count: Int, timeout: TimeInterval = 5) -> TestHTTPServer.Request? {
        let deadline = Date().addingTimeInterval(timeout)
        condition.lock()
        defer { condition.unlock() }
        while requests.count < count {
            if !condition.wait(until: deadline) { return nil }
        }
        return requests.last
    }

    /// One HTTP chunk with these bytes.
    func send(_ bytes: Data) {
        var chunk = Data(String(bytes.count, radix: 16).utf8)
        chunk.append(contentsOf: [0x0D, 0x0A])
        chunk.append(bytes)
        chunk.append(contentsOf: [0x0D, 0x0A])
        write(chunk)
    }

    func send(_ text: String) {
        send(Data(text.utf8))
    }

    /// Ends the body normally (last chunk) and closes.
    func finish() {
        queue.async {
            let connection = self.connection
            connection?.send(content: Data("0\r\n\r\n".utf8), completion: .contentProcessed { _ in connection?.cancel() })
        }
    }

    /// Cuts the connection in the middle of the body.
    func cut() {
        queue.async { self.connection?.forceCancel() }
    }

    private func write(_ data: Data) {
        queue.async { self.connection?.send(content: data, completion: .contentProcessed { _ in }) }
    }

    private func read(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) { [weak self] data, _, complete, error in
            guard let self else { return }
            var buffer = buffer
            if let data { buffer.append(data) }
            if let request = TestHTTPServer.parse(buffer) {
                self.connection = connection
                let head = "HTTP/1.1 200 OK\r\nContent-Type: \(self.contentType)\r\nCache-Control: no-cache\r\n"
                    + "Transfer-Encoding: chunked\r\n\r\n"
                connection.send(content: Data(head.utf8), completion: .contentProcessed { _ in
                    self.condition.lock()
                    self.requests.append(request)
                    self.condition.broadcast()
                    self.condition.unlock()
                })
            } else if complete || error != nil {
                connection.cancel()
            } else {
                self.read(connection, buffer: buffer)
            }
        }
    }
}
