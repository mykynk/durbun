import Foundation
import Network
@testable import Durbun

/// A minimal Dürbün desktop: NDJSON over TCP on 127.0.0.1, answers `hello` with `welcome`, records
/// every message and can also dial the SDK's on-device listener (what the usbmux tunnel does).
final class FakeDesktop {
    struct Received {
        let connection: Int
        let object: [String: Any]

        var type: String? { object["type"] as? String }
    }

    let queue = DispatchQueue(label: "test.fake-desktop")
    private var listener: NWListener?
    private var connections: [Int: NWConnection] = [:]
    private var framers: [Int: NDJSONFramer] = [:]
    private var nextId = 1
    private let condition = NSCondition()
    private var received: [Received] = []
    private var closed: Set<Int> = []

    private var _autoWelcome = true
    private var _config: [String: Any] = [
        "captureBodies": true,
        "maxBodyBytes": 1_048_576,
        "metricsIntervalMs": 1000,
        "deviceLogsAvailable": false,
    ]
    private var _mocks: [[String: Any]] = []

    // Set from the test thread, read on `queue`: guarded by `condition`.
    var autoWelcome: Bool {
        get { locked { _autoWelcome } }
        set { locked { _autoWelcome = newValue } }
    }

    var config: [String: Any] {
        get { locked { _config } }
        set { locked { _config = newValue } }
    }

    var mocks: [[String: Any]] {
        get { locked { _mocks } }
        set { locked { _mocks = newValue } }
    }

    private func locked<T>(_ body: () -> T) -> T {
        condition.lock()
        defer { condition.unlock() }
        return body()
    }

    private(set) var port: UInt16 = 0

    func start(port requested: UInt16 = 0) throws {
        let parameters = NWParameters.tcp
        let port = requested == 0 ? NWEndpoint.Port.any : NWEndpoint.Port(rawValue: requested)!
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: port)
        let listener = try NWListener(using: parameters)
        let ready = DispatchSemaphore(value: 0)
        var failure: NWError?
        listener.stateUpdateHandler = { state in
            switch state {
            case .ready: ready.signal()
            case let .failed(error):
                failure = error
                ready.signal()
            default: break
            }
        }
        listener.newConnectionHandler = { [weak self] connection in
            _ = self?.register(connection)
        }
        listener.start(queue: queue)
        _ = ready.wait(timeout: .now() + 5)
        if let failure { throw failure }
        self.port = listener.port?.rawValue ?? 0
        self.listener = listener
    }

    /// Dials the SDK's on-device listener like the desktop's usbmux tunnel. Returns the connection id.
    func connect(toPort port: UInt16) -> Int {
        let connection = NWConnection(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: port)!, using: .tcp)
        return queue.sync { register(connection) }
    }

    func stop() {
        queue.sync {
            listener?.cancel()
            listener = nil
            for connection in connections.values { connection.cancel() }
            connections.removeAll()
        }
    }

    /// Drops every SDK connection (the listener keeps running).
    func closeConnections() {
        queue.sync {
            for (id, connection) in connections {
                connection.cancel()
                markClosed(id)
            }
            connections.removeAll()
        }
    }

    func send(_ object: [String: Any], to connection: Int? = nil) {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(0x0A)
        queue.async {
            let targets = connection.map { [$0] } ?? Array(self.connections.keys)
            for id in targets {
                self.connections[id]?.send(content: data, completion: .contentProcessed { _ in })
            }
        }
    }

    // MARK: Inspection

    var all: [Received] {
        condition.lock()
        defer { condition.unlock() }
        return received
    }

    func messages(ofType type: String) -> [[String: Any]] {
        all.filter { $0.type == type }.map(\.object)
    }

    /// Waits until a message matching `predicate` was received (returns the first such message).
    /// Spins the main run loop while waiting, so main-queue work (action handlers) keeps running.
    @discardableResult
    func waitFor(timeout: TimeInterval = 5, _ predicate: (Received) -> Bool) -> Received? {
        var match: Received?
        _ = spinUntil(timeout: timeout) {
            match = all.first(where: predicate)
            return match != nil
        }
        return match
    }

    @discardableResult
    func waitForType(_ type: String, timeout: TimeInterval = 5, where predicate: (([String: Any]) -> Bool)? = nil) -> [String: Any]? {
        waitFor(timeout: timeout) { $0.type == type && (predicate?($0.object) ?? true) }?.object
    }

    /// Waits until at least `count` messages match.
    func waitForCount(_ count: Int, timeout: TimeInterval = 5, _ predicate: (Received) -> Bool) -> [Received] {
        var matches: [Received] = []
        _ = spinUntil(timeout: timeout) {
            matches = all.filter(predicate)
            return matches.count >= count
        }
        return matches
    }

    func waitForClose(_ connection: Int, timeout: TimeInterval = 5) -> Bool {
        spinUntil(timeout: timeout) {
            condition.lock()
            defer { condition.unlock() }
            return closed.contains(connection)
        }
    }

    // MARK: Connections (queue)

    private func register(_ connection: NWConnection) -> Int {
        let id = nextId
        nextId += 1
        connections[id] = connection
        framers[id] = NDJSONFramer()
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: self?.markClosed(id)
            default: break
            }
        }
        connection.start(queue: queue)
        receive(id, connection)
        return id
    }

    private func receive(_ id: Int, _ connection: NWConnection) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, complete, error in
            guard let self else { return }
            if let data, !data.isEmpty, var framer = self.framers[id] {
                let lines = (try? framer.push(data)) ?? []
                self.framers[id] = framer
                for line in lines { self.handle(line, from: id) }
            }
            if complete || error != nil {
                self.markClosed(id)
                connection.cancel()
                return
            }
            self.receive(id, connection)
        }
    }

    private func handle(_ line: Data, from id: Int) {
        guard let object = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else { return }
        condition.lock()
        received.append(Received(connection: id, object: object))
        condition.broadcast()
        condition.unlock()
        if object["type"] as? String == "hello", autoWelcome {
            send([
                "type": "welcome",
                "protocol": 1,
                "server": "durbun/test",
                "appId": "app:1",
                "config": config,
                "mocks": mocks,
            ], to: id)
        }
    }

    private func markClosed(_ id: Int) {
        condition.lock()
        closed.insert(id)
        condition.broadcast()
        condition.unlock()
    }
}

/// Polls `condition` until it holds or `timeout` elapses. On the main thread the run loop keeps
/// running (main-queue blocks execute); elsewhere it sleeps briefly between checks.
func spinUntil(timeout: TimeInterval, _ condition: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while true {
        if condition() { return true }
        if Date() >= deadline { return condition() }
        if Thread.isMainThread {
            if !RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.01)) {
                Thread.sleep(forTimeInterval: 0.002)
            }
        } else {
            Thread.sleep(forTimeInterval: 0.005)
        }
    }
}

/// Finds a currently free TCP port on 127.0.0.1 (bind to 0, read it back, close).
func freeLocalPort() -> UInt16 {
    let fd = socket(AF_INET, SOCK_STREAM, 0)
    defer { close(fd) }
    var address = sockaddr_in()
    address.sin_family = sa_family_t(AF_INET)
    address.sin_addr.s_addr = inet_addr("127.0.0.1")
    address.sin_port = 0
    var length = socklen_t(MemoryLayout<sockaddr_in>.size)
    _ = withUnsafePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, length) } }
    _ = withUnsafeMutablePointer(to: &address) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) } }
    return UInt16(bigEndian: address.sin_port)
}
