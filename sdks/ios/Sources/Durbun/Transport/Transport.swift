import Foundation
import Network

/// Desktop connection manager (SPEC §6.1 transport strategy):
///  1. client → 127.0.0.1:<port> (simulator, Mac);
///  2. client → user-configured host (Wi-Fi);
///  3. physical iOS devices: listener on 127.0.0.1:<first free of 9752…9755>, reached by the desktop
///     through usbmux; inbound connections are accepted only while no link is active.
/// The first link that completes hello → welcome becomes active and every other link is closed.
/// Clients reconnect with backoff (0.5 s → 3 s) forever. Outgoing lines are queued in a bounded
/// buffer while disconnected and flushed after the handshake.
///
/// All state lives on `queue` (Network.framework callbacks are delivered there as well).
final class Transport {
    enum Origin: String {
        case loopback
        case host
        case usb
    }

    struct Configuration {
        var loopbackPort: UInt16?
        var host: String?
        var hostPort: UInt16 = 9751
        var listenerPorts: ClosedRange<UInt16>?
        var maxBufferedMessages: Int = 5000
        var maxBufferedBytes: Int = 32 * 1024 * 1024
        var reconnectMinDelay: TimeInterval = 0.5
        var reconnectMaxDelay: TimeInterval = 3
        var handshakeTimeout: TimeInterval = 10
        var idleTimeout: TimeInterval = 60
        var listenerRetryDelay: TimeInterval = 3
    }

    struct Callbacks {
        var hello: () -> JSONValue
        var welcome: (ServerWelcome, Origin) -> Void
        var message: (ServerMessage) -> Void
        var disconnected: () -> Void
    }

    private final class Link {
        let id: Int
        let origin: Origin
        let connection: NWConnection
        var framer = NDJSONFramer()
        var welcomed = false
        var closed = false
        var createdAt = DispatchTime.now()
        var lastInbound = DispatchTime.now()
        var inFlightBytes = 0

        init(id: Int, origin: Origin, connection: NWConnection) {
            self.id = id
            self.origin = origin
            self.connection = connection
        }
    }

    private struct ClientSlot {
        var delay: TimeInterval
        var link: Link?
        var timer: DispatchWorkItem?
    }

    /// Bytes handed to Network.framework but not yet processed, per link (backpressure).
    private static let inFlightLimit = 1 << 20
    /// Lines are coalesced into writes of at most this size.
    private static let batchBytes = 64 * 1024

    let queue: DispatchQueue
    private let config: Configuration
    private let callbacks: Callbacks
    private var running = false
    private var links: [Int: Link] = [:]
    private var active: Link?
    private var nextLinkId = 1
    private var slots: [Origin: ClientSlot] = [:]
    private var listener: NWListener?
    private var listenerReadyPort: UInt16?
    private var listenerRetry: DispatchWorkItem?
    private var outgoing: OutgoingBuffer
    private var watchdog: DispatchSourceTimer?
    private var flushWaiters: [FlushWaiter] = []

    init(configuration: Configuration, callbacks: Callbacks) {
        config = configuration
        self.callbacks = callbacks
        queue = DispatchQueue(label: "dev.durbun.transport", qos: .utility)
        outgoing = OutgoingBuffer(maxMessages: configuration.maxBufferedMessages, maxBytes: configuration.maxBufferedBytes)
    }

    // MARK: Public (thread-safe)

    func start() {
        queue.async { self.startOnQueue() }
    }

    func stop() {
        queue.async { self.stopOnQueue() }
    }

    /// Queues one message; it is serialized on the transport queue so callers never pay for it.
    func send(_ message: JSONValue) {
        queue.async {
            guard self.running else { return }
            self.outgoing.append(JSONWriter.line(message))
            self.pump()
        }
    }

    /// Blocks the caller until everything queued so far was handed to the socket, or `timeout`
    /// elapsed. Returns false quickly when no link is active. Used right before the process dies;
    /// never waits on `queue` synchronously, so it cannot deadlock even if called from it.
    func flush(timeout: TimeInterval) -> Bool {
        let waiter = FlushWaiter()
        queue.async {
            guard let link = self.active, !link.closed else {
                waiter.finish(false)
                return
            }
            if self.outgoing.isEmpty && link.inFlightBytes == 0 {
                waiter.finish(true)
            } else {
                self.flushWaiters.append(waiter)
                self.pump()
            }
        }
        return waiter.wait(timeout: timeout)
    }

    /// Re-attempts connections right away (e.g. when the app returns to the foreground).
    func nudge() {
        queue.async {
            guard self.running, self.active == nil else { return }
            for origin in Array(self.slots.keys) {
                guard var slot = self.slots[origin], slot.link == nil else { continue }
                slot.timer?.cancel()
                slot.timer = nil
                slot.delay = self.config.reconnectMinDelay
                self.slots[origin] = slot
                self.connect(origin)
            }
            if self.config.listenerPorts != nil, self.listener == nil {
                self.listenerRetry?.cancel()
                self.listenerRetry = nil
                self.startListener(portIndex: 0)
            }
        }
    }

    /// For tests and diagnostics.
    var snapshot: (activeOrigin: Origin?, listenerPort: UInt16?, buffered: Int) {
        queue.sync { (active?.origin, listenerReadyPort, outgoing.count) }
    }

    // MARK: Lifecycle

    private func startOnQueue() {
        guard !running else { return }
        running = true
        if config.loopbackPort != nil {
            slots[.loopback] = ClientSlot(delay: config.reconnectMinDelay)
            connect(.loopback)
        }
        if let host = config.host, !host.isEmpty {
            slots[.host] = ClientSlot(delay: config.reconnectMinDelay)
            connect(.host)
        }
        if config.listenerPorts != nil { startListener(portIndex: 0) }
        startWatchdog()
    }

    private func stopOnQueue() {
        guard running else { return }
        running = false
        for slot in slots.values { slot.timer?.cancel() }
        slots.removeAll()
        listenerRetry?.cancel()
        listenerRetry = nil
        listener?.newConnectionHandler = nil
        listener?.stateUpdateHandler = nil
        listener?.cancel()
        listener = nil
        listenerReadyPort = nil
        watchdog?.cancel()
        watchdog = nil
        let wasActive = active != nil
        active = nil
        for link in Array(links.values) { closeQuietly(link) }
        links.removeAll()
        outgoing.removeAll()
        signalFlushWaiters(drained: false)
        if wasActive { callbacks.disconnected() }
    }

    // MARK: Clients

    private func endpoint(for origin: Origin) -> NWEndpoint? {
        switch origin {
        case .loopback:
            guard let port = config.loopbackPort.flatMap(NWEndpoint.Port.init(rawValue:)) else { return nil }
            return .hostPort(host: .ipv4(.loopback), port: port)
        case .host:
            guard let host = config.host, !host.isEmpty,
                  let port = NWEndpoint.Port(rawValue: config.hostPort)
            else { return nil }
            return .hostPort(host: NWEndpoint.Host(host), port: port)
        case .usb:
            return nil
        }
    }

    private func connect(_ origin: Origin) {
        guard running, active == nil, var slot = slots[origin], slot.link == nil,
              let endpoint = endpoint(for: origin)
        else { return }
        let tcp = NWProtocolTCP.Options()
        tcp.noDelay = true
        tcp.connectionTimeout = 5
        let parameters = NWParameters(tls: nil, tcp: tcp)
        let link = makeLink(origin, NWConnection(to: endpoint, using: parameters))
        slot.link = link
        slot.timer = nil
        slots[origin] = slot
        startLink(link)
    }

    private func scheduleReconnect(_ origin: Origin) {
        guard running, var slot = slots[origin], slot.link == nil, slot.timer == nil else { return }
        let delay = slot.delay
        slot.delay = min(slot.delay * 2, config.reconnectMaxDelay)
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.slots[origin]?.timer = nil
            // While another link is active the slot stays idle; it is rescheduled when that link drops.
            if self.active == nil { self.connect(origin) }
        }
        slot.timer = work
        slots[origin] = slot
        queue.asyncAfter(deadline: .now() + delay, execute: work)
    }

    // MARK: Listener (physical iOS devices)

    private func startListener(portIndex: Int) {
        guard running, listener == nil, let range = config.listenerPorts else { return }
        let ports = Array(range)
        guard portIndex < ports.count else {
            scheduleListenerRetry()
            return
        }
        let port = ports[portIndex]
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            startListener(portIndex: portIndex + 1)
            return
        }
        let parameters = NWParameters.tcp
        // Loopback only: the desktop arrives through usbmux, nobody on the network can connect.
        // (The port comes from requiredLocalEndpoint; `NWListener(using:on:)` rejects that combination.)
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: nwPort)
        let newListener: NWListener
        do {
            newListener = try NWListener(using: parameters)
        } catch {
            startListener(portIndex: portIndex + 1)
            return
        }
        newListener.stateUpdateHandler = { [weak self, weak newListener] state in
            guard let self, let listener = newListener, self.listener === listener else { return }
            switch state {
            case .ready:
                self.listenerReadyPort = port
                Diagnostics.info("Dürbün listening for USB connections on 127.0.0.1:\(port)")
            case let .failed(error), let .waiting(error):
                let wasReady = self.listenerReadyPort == port
                self.dropListener(listener)
                if !wasReady, case let .posix(code) = error, code == .EADDRINUSE {
                    self.startListener(portIndex: portIndex + 1)
                } else {
                    self.scheduleListenerRetry()
                }
            case .cancelled:
                if self.listener === listener { self.dropListener(listener) }
            default:
                break
            }
        }
        newListener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        listener = newListener
        newListener.start(queue: queue)
    }

    private func dropListener(_ listener: NWListener) {
        listener.stateUpdateHandler = nil
        listener.newConnectionHandler = nil
        listener.cancel()
        if self.listener === listener {
            self.listener = nil
            listenerReadyPort = nil
        }
    }

    private func scheduleListenerRetry() {
        guard running, listenerRetry == nil else { return }
        let work = DispatchWorkItem { [weak self] in
            guard let self else { return }
            self.listenerRetry = nil
            self.startListener(portIndex: 0)
        }
        listenerRetry = work
        queue.asyncAfter(deadline: .now() + config.listenerRetryDelay, execute: work)
    }

    private func accept(_ connection: NWConnection) {
        let pendingInbound = links.values.filter { $0.origin == .usb && !$0.welcomed }.count
        guard running, active == nil, pendingInbound < 2 else {
            connection.cancel()
            return
        }
        startLink(makeLink(.usb, connection))
    }

    // MARK: Links

    private func makeLink(_ origin: Origin, _ connection: NWConnection) -> Link {
        let link = Link(id: nextLinkId, origin: origin, connection: connection)
        nextLinkId += 1
        links[link.id] = link
        return link
    }

    private func startLink(_ link: Link) {
        link.connection.stateUpdateHandler = { [weak self, weak link] state in
            guard let self, let link, !link.closed else { return }
            switch state {
            case .ready:
                link.lastInbound = .now()
                self.sendHello(on: link)
                self.receive(on: link)
            case .waiting, .failed:
                // `.waiting` = refused / unreachable: retry on our own backoff schedule instead.
                self.close(link)
            case .cancelled:
                self.close(link)
            default:
                break
            }
        }
        link.connection.start(queue: queue)
    }

    private func sendHello(on link: Link) {
        let line = JSONWriter.line(callbacks.hello())
        link.connection.send(content: line, completion: .contentProcessed { [weak self, weak link] error in
            guard let self, let link, error != nil else { return }
            self.close(link)
        })
    }

    private func receive(on link: Link) {
        link.connection.receive(minimumIncompleteLength: 1, maximumLength: 256 * 1024) { [weak self, weak link] data, _, isComplete, error in
            guard let self, let link, !link.closed else { return }
            if let data, !data.isEmpty {
                link.lastInbound = .now()
                let lines: [Data]
                do {
                    lines = try link.framer.push(data)
                } catch {
                    self.close(link)
                    return
                }
                for line in lines {
                    self.handle(line: line, from: link)
                    if link.closed { return }
                }
            }
            if isComplete || error != nil {
                self.close(link)
                return
            }
            self.receive(on: link)
        }
    }

    private func handle(line: Data, from link: Link) {
        guard let message = ServerMessage.parse(line) else { return }
        switch message {
        case let .welcome(welcome):
            if link.welcomed {
                // A repeated welcome only refreshes config and mocks.
                callbacks.message(.config(welcome.config))
                callbacks.message(.mocks(welcome.mocks))
                return
            }
            if let current = active, current !== link {
                close(link)
                return
            }
            link.welcomed = true
            active = link
            slots[link.origin]?.delay = config.reconnectMinDelay
            for other in Array(links.values) where other !== link { close(other) }
            Diagnostics.info("Dürbün connected to the desktop (\(link.origin.rawValue))")
            callbacks.welcome(welcome, link.origin)
            let dropped = outgoing.takeDroppedCount()
            if dropped > 0 {
                let warning = WireMessage.log(
                    ts: Clock.nowMs(),
                    level: .warning,
                    tag: "durbun",
                    message: "Dürbün: \(dropped) messages were dropped while the desktop was not connected "
                        + "(buffer keeps the last \(outgoing.maxMessages))."
                )
                // Goes after the flushed lines without evicting any of them.
                outgoing.append(JSONWriter.line(warning), evictOldest: false)
            }
            pump()
        case .ping:
            let pong = JSONWriter.line(WireMessage.pong(ts: Clock.nowMs()))
            link.connection.send(content: pong, completion: .contentProcessed { _ in })
        default:
            guard link.welcomed, link === active else { return }
            callbacks.message(message)
        }
    }

    private func pump() {
        guard let link = active, !link.closed else { return }
        while link.inFlightBytes < Self.inFlightLimit, !outgoing.isEmpty {
            var batch = Data()
            while let next = outgoing.peekFirst(), batch.isEmpty || batch.count + next.count <= Self.batchBytes {
                batch.append(next)
                _ = outgoing.popFirst()
            }
            let size = batch.count
            link.inFlightBytes += size
            link.connection.send(content: batch, completion: .contentProcessed { [weak self, weak link] error in
                guard let self, let link else { return }
                link.inFlightBytes -= size
                if error != nil {
                    self.close(link)
                    return
                }
                self.pump()
                if self.outgoing.isEmpty && link.inFlightBytes == 0 { self.signalFlushWaiters(drained: true) }
            })
        }
    }

    private func signalFlushWaiters(drained: Bool) {
        let waiters = flushWaiters
        flushWaiters.removeAll()
        for waiter in waiters { waiter.finish(drained) }
    }

    /// Closes a link and, for clients, schedules the next attempt. Safe to call repeatedly.
    private func close(_ link: Link) {
        guard !link.closed else { return }
        closeQuietly(link)
        links[link.id] = nil
        let wasActive = active === link
        if wasActive {
            active = nil
            signalFlushWaiters(drained: false)
            Diagnostics.info("Dürbün disconnected from the desktop (\(link.origin.rawValue))")
            callbacks.disconnected()
        }
        guard running else { return }
        if link.origin != .usb, slots[link.origin]?.link === link {
            slots[link.origin]?.link = nil
        }
        if wasActive {
            // Every idle client starts again quickly once the active link is gone.
            for origin in Array(slots.keys) {
                slots[origin]?.delay = config.reconnectMinDelay
                scheduleReconnect(origin)
            }
        } else if link.origin != .usb {
            scheduleReconnect(link.origin)
        }
    }

    private func closeQuietly(_ link: Link) {
        link.closed = true
        link.connection.stateUpdateHandler = nil
        link.connection.cancel()
    }

    private func startWatchdog() {
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 2, repeating: 2, leeway: .milliseconds(500))
        timer.setEventHandler { [weak self] in self?.checkTimeouts() }
        watchdog = timer
        timer.resume()
    }

    private func checkTimeouts() {
        let now = DispatchTime.now().uptimeNanoseconds
        for link in Array(links.values) {
            if link.welcomed {
                let idle = Double(now - link.lastInbound.uptimeNanoseconds) / 1e9
                if idle > config.idleTimeout { close(link) }
            } else {
                let age = Double(now - link.createdAt.uptimeNanoseconds) / 1e9
                if age > config.handshakeTimeout { close(link) }
            }
        }
    }
}

/// One-shot result + semaphore for `Transport.flush(timeout:)`.
final class FlushWaiter {
    private let semaphore = DispatchSemaphore(value: 0)
    private let lock = UnfairLock()
    private var result: Bool?

    func finish(_ drained: Bool) {
        let first: Bool = lock.withLock {
            guard result == nil else { return false }
            result = drained
            return true
        }
        if first { semaphore.signal() }
    }

    func wait(timeout: TimeInterval) -> Bool {
        guard semaphore.wait(timeout: .now() + timeout) == .success else { return false }
        return lock.withLock { result ?? false }
    }
}
