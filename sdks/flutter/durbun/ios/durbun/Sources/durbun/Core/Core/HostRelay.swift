import Foundation

/// Hosted mode: another SDK in the same process — the Flutter plugin (`package:durbun`) — owns the
/// only desktop connection. The core then opens no socket: its encoded messages are handed to the host,
/// which sends them on its connection (same app session), and the desktop state (config, mock rules,
/// connection) comes back through `DurbunCore.applyHostState`.
protocol HostLink: AnyObject {
    /// A batch of encoded messages (one JSON object each, no newline). Called on the relay queue.
    func deliver(_ lines: [String])
    /// A batch of this app's own os_log lines, encoded like `deliver`'s. The host shows them in its
    /// in-app panel and sends them to the desktop only when the desktop cannot read the device's logs.
    func deliverDeviceLogs(_ lines: [String])
    /// The native action list changed (JSON array of `AppAction` descriptors).
    func actionsChanged(_ descriptorsJSON: String)
    /// Waits until the host handed everything it received to the desktop's socket. Called off the
    /// main thread only (the host needs the main thread to answer); false on timeout.
    func flush(timeout: TimeInterval) -> Bool
}

extension HostLink {
    func deliverDeviceLogs(_ lines: [String]) { deliver(lines) }
}

/// Hosted mode: what the host wants of this app's own os_log lines (`state.deviceLogs`).
struct HostDeviceLogs: Equatable {
    /// Read them: the in-app panel shows them, or the desktop gets them.
    var read = false
    /// Someone is looking (panel open, or a desktop without device logs): read often.
    var fast = false
    /// The host sends these lines on to the desktop (it cannot read the device's logs itself).
    var desktop = false

    init() {}

    init(json: [String: Any], fallback: HostDeviceLogs) {
        read = json["read"] as? Bool ?? fallback.read
        fast = json["fast"] as? Bool ?? fallback.fast
        desktop = json["desktop"] as? Bool ?? fallback.desktop
    }
}

/// Batches encoded lines on a serial queue and hands them to the `HostLink` (bounded buffer: the
/// oldest lines are dropped first, like the transport's offline buffer).
final class HostRelay {
    private let link: HostLink
    private let queue = DispatchQueue(label: "dev.durbun.relay", qos: .utility)
    private var buffer: OutgoingBuffer
    private var scheduled = false
    private var stopped = false
    private let interval: DispatchTimeInterval

    init(link: HostLink, maxMessages: Int, maxBytes: Int = 16 * 1024 * 1024, interval: DispatchTimeInterval = .milliseconds(40)) {
        self.link = link
        self.buffer = OutgoingBuffer(maxMessages: maxMessages, maxBytes: maxBytes)
        self.interval = interval
    }

    func enqueue(_ line: Data) {
        queue.async {
            guard !self.stopped else { return }
            self.buffer.append(line)
            self.scheduleDrain()
        }
    }

    func stop() {
        queue.async {
            self.stopped = true
            self.buffer.removeAll()
        }
    }

    /// Delivers everything buffered now, then asks the host to flush. Never call it on the main
    /// thread: the host answers there (on the main thread only the buffered lines are delivered).
    func flush(timeout: TimeInterval) -> Bool {
        queue.sync { self.drain() }
        if Thread.isMainThread { return false }
        return link.flush(timeout: timeout)
    }

    private func scheduleDrain() {
        guard !scheduled else { return }
        scheduled = true
        queue.asyncAfter(deadline: .now() + interval) {
            self.scheduled = false
            self.drain()
        }
    }

    /// Runs on `queue`: hands everything buffered to the host, in batches.
    private func drain() {
        guard !stopped else { return }
        while true {
            var lines: [String] = []
            var bytes = 0
            while lines.count < 256 && bytes < 512 * 1024, let line = buffer.popFirst() {
                bytes += line.count
                let body = line.last == 0x0A ? line.dropLast() : line[...]
                lines.append(String(decoding: body, as: UTF8.self))
            }
            if lines.isEmpty { break }
            let dropped = buffer.takeDroppedCount()
            if dropped > 0 {
                Diagnostics.debug("Dürbün relay dropped \(dropped) old messages (Flutter side busy)")
            }
            link.deliver(lines)
        }
    }
}
