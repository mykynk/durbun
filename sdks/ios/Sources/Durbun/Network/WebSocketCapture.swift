import Foundation
import ObjectiveC

/// Captures `URLSessionWebSocketTask` connections (SPEC §6.1.1). A `URLProtocol` never sees WebSocket
/// tasks, so the task class itself is hooked, once per process, on the concrete class URLSession creates
/// (`__NSURLSessionWebSocketTask` today, found by creating one task that is never resumed):
///  - `resume` (first call): the task is tracked; its handshake request (`ws(s)://` URL, the upgrade
///    headers URLSession put on the request) goes out as `net.request` once the desktop asks for
///    streams (`config.captureStreams`); until then nothing about the task is reported;
///  - `sendMessage:completionHandler:`, `receiveMessageWithCompletionHandler:` (the completion-handler
///    and the async Swift API both end there), `sendPingWithPongReceiveHandler:`: the completion is
///    wrapped; the wrapper hands the message to the stream queue, then calls the app's block with the
///    same arguments on the same thread;
///  - `cancelWithCloseCode:reason:` and `cancel`: noted, then passed on.
/// The handshake response (101 with its headers, or the failed upgrade's status) and the end of the
/// connection (close frame from the server, failure) are read from the task's own properties
/// (`response`, `state`, `closeCode`, `closeReason`, `error`) by a watcher on the stream queue, and
/// again right before each message, so the 101 always comes first.
///
/// Safety: every hook calls the implementation that was in place before it (Apple's, or another
/// tool's that hooked earlier), with the same arguments; a tool that hooks later calls ours. A task
/// started while capture was off (SDK stopped, `captureNetwork` false, an ignored host) is never
/// tracked: its calls pass straight through, with the app's own blocks. Nothing is hooked unless every
/// method exists with the expected shape. The app's delegate, its blocks' threads and the task object
/// it sees stay the same (the state is an associated object).
enum WebSocketCapture {
    private static let lock = UnfairLock()
    private static var attempted = false
    private static var hookedClass: AnyClass?

    /// The hooked task class, nil when hooking was not possible (tests and diagnostics).
    static var installedClass: AnyClass? { lock.withLock { hookedClass } }

    /// Idempotent; called before the configuration swizzles are installed (the probe task must not
    /// bind a session).
    static func install() {
        lock.withLock {
            guard !attempted else { return }
            attempted = true
            guard let cls = concreteTaskClass(), canHook(cls) else {
                Diagnostics.info("Dürbün: URLSessionWebSocketTask cannot be hooked here; WebSocket messages are not captured.")
                return
            }
            hookAll(cls)
            hookedClass = cls
        }
    }

    /// The SDK stopped: tracked connections are forgotten (their calls pass straight through).
    static func forgetAll() {
        WebSocketWatch.shared.forgetAll()
    }

    // MARK: Tracking

    private static var associationKey: UInt8 = 0

    static func connection(of task: AnyObject) -> WebSocketConnection? {
        objc_getAssociatedObject(task, &associationKey) as? WebSocketConnection
    }

    /// A connection that still reports, or nil (pass straight through).
    static func live(_ task: AnyObject) -> WebSocketConnection? {
        guard let connection = connection(of: task), connection.isLive else { return nil }
        return connection
    }

    /// First `resume` of a task of the hooked class: starts tracking it when network capture is on for
    /// its host.
    static func taskWillResume(_ object: AnyObject) {
        guard connection(of: object) == nil else { return }
        // The hooked class is what `webSocketTask(with:)` returns, but not an ObjC subclass of
        // NSURLSessionWebSocketTask, so `as?` would fail.
        let task = unsafeBitCast(object, to: URLSessionWebSocketTask.self)
        let core = DurbunCore.shared
        let policy = core.networkPolicy
        guard policy.active, core.isRunning,
              let request = task.originalRequest ?? task.currentRequest, let url = request.url
        else { return }
        if let host = url.host, policy.ignores(host: host) { return }
        let connection = WebSocketConnection(id: core.nextRequestId(), task: task, request: request)
        objc_setAssociatedObject(task, &associationKey, connection, .OBJC_ASSOCIATION_RETAIN)
        connection.started()
        WebSocketWatch.shared.add(connection)
    }

    /// `ws://` / `wss://` for the URL URLSession keeps as http(s).
    static func webSocketURL(_ url: URL) -> String {
        guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url.absoluteString }
        switch components.scheme?.lowercased() {
        case "http": components.scheme = "ws"
        case "https": components.scheme = "wss"
        default: break
        }
        return components.url?.absoluteString ?? url.absoluteString
    }

    // MARK: Hooks

    private typealias VoidIMP = @convention(c) (AnyObject, Selector) -> Void
    private typealias OneObjectIMP = @convention(c) (AnyObject, Selector, AnyObject?) -> Void
    private typealias TwoObjectsIMP = @convention(c) (AnyObject, Selector, AnyObject?, AnyObject?) -> Void
    private typealias CloseIMP = @convention(c) (AnyObject, Selector, Int, AnyObject?) -> Void
    private typealias ErrorBlock = @convention(block) (AnyObject?) -> Void
    private typealias MessageBlock = @convention(block) (AnyObject?, AnyObject?) -> Void

    private static let resumeSelector = NSSelectorFromString("resume")
    private static let cancelSelector = NSSelectorFromString("cancel")
    private static let sendSelector = NSSelectorFromString("sendMessage:completionHandler:")
    private static let receiveSelector = NSSelectorFromString("receiveMessageWithCompletionHandler:")
    private static let pingSelector = NSSelectorFromString("sendPingWithPongReceiveHandler:")
    private static let closeSelector = NSSelectorFromString("cancelWithCloseCode:reason:")

    /// One task of the class URLSession really creates, never resumed.
    private static func concreteTaskClass() -> AnyClass? {
        guard let url = URL(string: "ws://127.0.0.1:9/") else { return nil }
        let probe = URLSession.shared.webSocketTask(with: url)
        defer { probe.cancel() }
        // Not a subclass of NSURLSessionWebSocketTask at run time (it derives from the private local task
        // class): `canHook` checks the methods instead, and tasks are never cast with `as?`.
        guard let cls = object_getClass(probe), cls.isSubclass(of: URLSessionTask.self) else { return nil }
        return cls
    }

    /// Every hooked method exists, returns void and takes the expected number of arguments.
    private static func canHook(_ cls: AnyClass) -> Bool {
        let expected: [(Selector, UInt32)] = [
            (resumeSelector, 2), (cancelSelector, 2), (sendSelector, 4), (receiveSelector, 3), (pingSelector, 3), (closeSelector, 4),
        ]
        for (selector, arguments) in expected {
            guard let method = class_getInstanceMethod(cls, selector),
                  method_getNumberOfArguments(method) == arguments,
                  returnsVoid(method)
            else { return false }
        }
        guard let close = class_getInstanceMethod(cls, closeSelector), let code = method_copyArgumentType(close, 2) else { return false }
        defer { free(code) }
        let type = String(cString: code)
        return type == "q" || type == "l"
    }

    private static func returnsVoid(_ method: Method) -> Bool {
        let type = method_copyReturnType(method)
        defer { free(type) }
        return String(cString: type) == "v"
    }

    private static func hookAll(_ cls: AnyClass) {
        replace(cls, resumeSelector) { previous in
            let block: @convention(block) (AnyObject) -> Void = { task in
                WebSocketCapture.taskWillResume(task)
                unsafeBitCast(previous.imp, to: VoidIMP.self)(task, resumeSelector)
            }
            return unsafeBitCast(block, to: AnyObject.self)
        }

        replace(cls, cancelSelector) { previous in
            let block: @convention(block) (AnyObject) -> Void = { task in
                WebSocketCapture.live(task)?.appCancelled()
                unsafeBitCast(previous.imp, to: VoidIMP.self)(task, cancelSelector)
            }
            return unsafeBitCast(block, to: AnyObject.self)
        }

        replace(cls, closeSelector) { previous in
            let block: @convention(block) (AnyObject, Int, AnyObject?) -> Void = { task, code, reason in
                WebSocketCapture.live(task)?.appClosed(code: code, reason: reason as? Data)
                unsafeBitCast(previous.imp, to: CloseIMP.self)(task, closeSelector, code, reason)
            }
            return unsafeBitCast(block, to: AnyObject.self)
        }

        replace(cls, sendSelector) { previous in
            let block: @convention(block) (AnyObject, AnyObject?, AnyObject?) -> Void = { task, message, completion in
                let call = unsafeBitCast(previous.imp, to: TwoObjectsIMP.self)
                guard let connection = WebSocketCapture.live(task), let message, let completion else {
                    return call(task, sendSelector, message, completion)
                }
                let original = unsafeBitCast(completion, to: ErrorBlock.self)
                let wrapper: ErrorBlock = { error in
                    if error == nil { connection.message(message, dir: "out") }
                    original(error)
                }
                call(task, sendSelector, message, unsafeBitCast(wrapper, to: AnyObject.self))
            }
            return unsafeBitCast(block, to: AnyObject.self)
        }

        replace(cls, receiveSelector) { previous in
            let block: @convention(block) (AnyObject, AnyObject?) -> Void = { task, completion in
                let call = unsafeBitCast(previous.imp, to: OneObjectIMP.self)
                guard let connection = WebSocketCapture.live(task), let completion else {
                    return call(task, receiveSelector, completion)
                }
                let original = unsafeBitCast(completion, to: MessageBlock.self)
                let wrapper: MessageBlock = { message, error in
                    if let message {
                        connection.message(message, dir: "in")
                    } else {
                        connection.receiveFailed(error as? Error)
                    }
                    original(message, error)
                }
                call(task, receiveSelector, unsafeBitCast(wrapper, to: AnyObject.self))
            }
            return unsafeBitCast(block, to: AnyObject.self)
        }

        replace(cls, pingSelector) { previous in
            let block: @convention(block) (AnyObject, AnyObject?) -> Void = { task, handler in
                let call = unsafeBitCast(previous.imp, to: OneObjectIMP.self)
                guard let connection = WebSocketCapture.live(task), let handler else {
                    return call(task, pingSelector, handler)
                }
                let pending = connection.pingSent()
                let original = unsafeBitCast(handler, to: ErrorBlock.self)
                let wrapper: ErrorBlock = { error in
                    if error == nil { connection.pongReceived(unreportedPingTs: pending) }
                    original(error)
                }
                call(task, pingSelector, unsafeBitCast(wrapper, to: AnyObject.self))
            }
            return unsafeBitCast(block, to: AnyObject.self)
        }
    }

    /// The implementation a hook calls on: the one it replaced, or (for a method the class inherits)
    /// whatever its superclass has at the time of the call.
    private final class Previous {
        private var fixed: IMP?
        private let superclass: AnyClass?
        private let selector: Selector

        init(fixed: IMP?, superclass: AnyClass?, selector: Selector) {
            self.fixed = fixed
            self.superclass = superclass
            self.selector = selector
        }

        var imp: IMP {
            if let fixed { return fixed }
            return class_getMethodImplementation(superclass, selector)!
        }

        func replaced(by imp: IMP) {
            fixed = imp
        }
    }

    /// Installs `make`'s block as `selector` of `cls`: replaces the class's own implementation, or adds
    /// an override when the class inherits it (the superclass and its other subclasses stay untouched).
    private static func replace(_ cls: AnyClass, _ selector: Selector, _ make: (Previous) -> AnyObject) {
        guard let method = class_getInstanceMethod(cls, selector) else { return }
        if definesItself(cls, selector) {
            let original = method_getImplementation(method)
            let previous = Previous(fixed: original, superclass: nil, selector: selector)
            let replaced = method_setImplementation(method, imp_implementationWithBlock(make(previous)))
            if replaced != original { previous.replaced(by: replaced) }
        } else {
            let previous = Previous(fixed: nil, superclass: class_getSuperclass(cls), selector: selector)
            let imp = imp_implementationWithBlock(make(previous))
            if !class_addMethod(cls, selector, imp, method_getTypeEncoding(method)), let own = class_getInstanceMethod(cls, selector) {
                previous.replaced(by: method_setImplementation(own, imp))
            }
        }
    }

    private static func definesItself(_ cls: AnyClass, _ selector: Selector) -> Bool {
        var count: UInt32 = 0
        guard let methods = class_copyMethodList(cls, &count) else { return false }
        defer { free(methods) }
        for index in 0..<Int(count) where method_getName(methods[index]) == selector { return true }
        return false
    }
}

/// One tracked WebSocket task: its network entry id and what was reported. Calls come from the app's
/// threads (send, ping, close), the session's delegate queue (completions) and the stream queue (the
/// watcher); every report is handed to `StreamPipeline` under `lock`, so they go out in that order.
///
/// Nothing is reported while the desktop does not ask for streams (`config.captureStreams`): the task
/// is only watched. Once it asks, the handshake goes out with its real times (the request at `resume`,
/// the response when the 101 was seen), then the messages from then on. A connection that was reported
/// is always finished (close frame or `net.error`), also after the desktop stopped asking.
final class WebSocketConnection {
    let id: String
    private weak var task: URLSessionWebSocketTask?
    private let lock = UnfairLock()

    private let requestMessage: JSONValue
    private var responseMessage: JSONValue?
    /// The handshake went out: messages may follow, and the end is always reported.
    private var reporting = false
    private var opened = false
    private var finished = false
    /// `cancel(with:reason:)`: code, reason and when.
    private var closeRequest: (code: Int, reason: Data?, ts: Double)?
    private var closeHandled = false
    /// The app's close frame went out (the task's closeCode is then the app's own).
    private var closeSent = false
    /// `cancel()`.
    private var cancelTs: Double?
    /// A receive failed: the connection is ending (when, and the error).
    private var endingTs: Double?
    private var receiveError: Error?
    /* stream queue only */
    private var checks = 0
    private var waitingSince: Double?

    init(id: String, task: URLSessionWebSocketTask, request: URLRequest) {
        self.id = id
        self.task = task
        let core = DurbunCore.shared
        let url = request.url.map(WebSocketCapture.webSocketURL) ?? ""
        let headers = core.redacting(HTTPHeaders.sorted(request.allHTTPHeaderFields))
        requestMessage = WireMessage.netRequest(
            id: id, ts: Clock.nowMs(), method: request.httpMethod ?? "GET", url: url, headers: headers, body: nil
        )
    }

    var isLive: Bool { lock.withLock { !finished } }

    /// Tests: the handshake was reported.
    var isReporting: Bool { lock.withLock { reporting } }

    /// Forgotten (the SDK stopped): no more reports.
    func forget() {
        lock.withLock { finished = true }
    }

    // MARK: Events (app threads, delegate queue)

    /// Right after `resume`.
    func started() {
        let asked = DurbunCore.shared.streamMessageCap != nil
        lock.withLock { if asked { beginReportingLocked() } }
    }

    /// A message the app sent (completion without error) or received.
    func message(_ message: AnyObject, dir: String) {
        let ts = Clock.nowMs()
        noteResponse(task?.response)
        guard DurbunCore.shared.streamMessageCap != nil else { return }
        let weight = WebSocketPayload.weight(of: message)
        let id = self.id
        lock.withLock {
            guard !finished else { return }
            beginReportingLocked()
            StreamPipeline.shared.submit(droppable: true, weight: weight) {
                guard let cap = DurbunCore.shared.streamMessageCap,
                      let payload = WebSocketPayload.describe(message, cap: cap)
                else { return }
                DurbunCore.shared.sendStream(WireMessage.netWs(
                    id: id, ts: ts, dir: dir, opcode: payload.opcode, size: payload.size, body: payload.body
                ))
            }
        }
    }

    /// `sendPing`: reported at once when the connection is known to be open; otherwise its time is
    /// returned and it is reported with the pong. nil: not reported at all.
    func pingSent() -> Double? {
        let ts = Clock.nowMs()
        noteResponse(task?.response)
        guard DurbunCore.shared.streamMessageCap != nil else { return nil }
        return lock.withLock { () -> Double? in
            guard !finished else { return nil }
            guard opened else { return ts }
            beginReportingLocked()
            submitControl(dir: "out", opcode: "ping", ts: ts)
            return nil
        }
    }

    func pongReceived(unreportedPingTs: Double?) {
        let ts = Clock.nowMs()
        noteResponse(task?.response)
        guard DurbunCore.shared.streamMessageCap != nil else { return }
        lock.withLock {
            guard !finished else { return }
            beginReportingLocked()
            if let unreportedPingTs { submitControl(dir: "out", opcode: "ping", ts: unreportedPingTs) }
            submitControl(dir: "in", opcode: "pong", ts: ts)
        }
    }

    func appClosed(code: Int, reason: Data?) {
        let ts = Clock.nowMs()
        let soon: Bool = lock.withLock {
            guard !finished, closeRequest == nil, cancelTs == nil else { return false }
            closeRequest = (code, reason, ts)
            return true
        }
        if soon { WebSocketWatch.shared.checkSoon() }
    }

    func appCancelled() {
        let ts = Clock.nowMs()
        let soon: Bool = lock.withLock {
            guard !finished, cancelTs == nil else { return false }
            cancelTs = ts
            return true
        }
        if soon { WebSocketWatch.shared.checkSoon() }
    }

    func receiveFailed(_ error: Error?) {
        let ts = Clock.nowMs()
        let soon: Bool = lock.withLock {
            guard !finished, endingTs == nil else { return false }
            endingTs = ts
            receiveError = error
            return true
        }
        if soon { WebSocketWatch.shared.checkSoon() }
    }

    // MARK: Watcher (stream queue)

    /// Reads the task's state and reports what changed. Returns the delay until the next check, or nil
    /// when the connection is done.
    func poll() -> TimeInterval? {
        guard let task else {
            forget()
            return nil
        }
        checks += 1
        noteResponse(task.response)
        let asked = DurbunCore.shared.streamMessageCap != nil
        let state = task.state
        let closeCode = task.closeCode.rawValue
        let closeReason = task.closeReason
        let error = task.error
        let now = Clock.nowMs()
        return lock.withLock { () -> TimeInterval? in
            if finished { return nil }
            if asked { beginReportingLocked() }
            let peerFirst = endingTs.map { ending in
                (closeRequest.map { ending < $0.ts } ?? true) && (cancelTs.map { ending < $0 } ?? true)
            } ?? false
            if let request = closeRequest, !closeHandled, !peerFirst {
                closeHandled = true
                if opened {
                    closeSent = true
                    if reporting { submitClose(dir: "out", code: request.code, reason: request.reason, ts: request.ts) }
                } else {
                    // Before the 101 there is no connection to close: the handshake was cancelled.
                    if reporting { submitError(URLError(.cancelled), cancelled: true, ts: request.ts) }
                    finished = true
                    return nil
                }
            }
            let waitingForEnd = endingTs != nil || cancelTs != nil || closeRequest != nil
            if waitingForEnd, waitingSince == nil { waitingSince = now }
            let gaveUp = waitingSince.map { now - $0 > 2000 } ?? false
            guard state == .completed || gaveUp else {
                if waitingForEnd { return 0.02 }
                if opened { return 1 }
                return min(0.25, 0.005 * pow(2, Double(min(checks, 6))))
            }
            finished = true
            if closeSent || !reporting { return nil }
            let endTs = endingTs ?? now
            if opened, closeCode != 0, peerFirst || cancelTs == nil {
                submitClose(dir: "in", code: closeCode, reason: closeReason, ts: endTs)
            } else if let cancelTs, !peerFirst {
                submitError(URLError(.cancelled), cancelled: true, ts: cancelTs)
            } else {
                let failure = error ?? receiveError
                let text = failure.map(NetworkErrorText.describe) ?? "The connection closed without a close frame."
                let id = self.id
                StreamPipeline.shared.submit(droppable: false) {
                    DurbunCore.shared.send(WireMessage.netError(id: id, ts: endTs, error: text))
                }
            }
            return nil
        }
    }

    // MARK: Reports (under `lock`)

    /// The handshake as it is known now (request, and the response once seen), the first time the
    /// desktop asks for streams. Under `lock`.
    private func beginReportingLocked() {
        guard !reporting, !finished else { return }
        reporting = true
        let request = requestMessage
        StreamPipeline.shared.submit(droppable: false) { DurbunCore.shared.send(request) }
        if let response = responseMessage {
            StreamPipeline.shared.submit(droppable: false) { DurbunCore.shared.send(response) }
        }
    }

    /// The handshake response, once: a 101 opens the connection; any other status is a failed upgrade
    /// (a normal response, nothing follows; not reported at all while the desktop does not ask).
    private func noteResponse(_ response: URLResponse?) {
        guard let http = response as? HTTPURLResponse else { return }
        let ts = Clock.nowMs()
        let asked = DurbunCore.shared.streamMessageCap != nil
        lock.withLock {
            guard !opened, !finished, responseMessage == nil else { return }
            let core = DurbunCore.shared
            let message = WireMessage.netResponse(
                id: id,
                ts: ts,
                status: http.statusCode,
                statusText: HTTPStatusText.text(for: http.statusCode),
                headers: core.redacting(HTTPHeaders.sorted(http.allHeaderFields)),
                body: nil
            )
            responseMessage = message
            if reporting {
                StreamPipeline.shared.submit(droppable: false) { DurbunCore.shared.send(message) }
            } else if asked {
                beginReportingLocked() // the request, then this response
            }
            if http.statusCode == 101 {
                opened = true
            } else {
                finished = true
            }
        }
    }

    private func submitControl(dir: String, opcode: String, ts: Double) {
        let id = self.id
        StreamPipeline.shared.submit(droppable: true) {
            guard DurbunCore.shared.streamMessageCap != nil else { return }
            DurbunCore.shared.sendStream(WireMessage.netWs(id: id, ts: ts, dir: dir, opcode: opcode, size: 0, body: nil))
        }
    }

    /// Ends a reported connection: sent even when the desktop no longer asks for streams.
    private func submitClose(dir: String, code: Int, reason: Data?, ts: Double) {
        let id = self.id
        let reasonBytes = reason?.count ?? 0
        let text = reason.flatMap { $0.isEmpty ? nil : String(decoding: $0, as: UTF8.self) }
        let size = (code != 0 ? 2 : 0) + reasonBytes
        StreamPipeline.shared.submit(droppable: false) {
            DurbunCore.shared.sendStream(WireMessage.netWs(
                id: id, ts: ts, dir: dir, opcode: "close", size: size, body: nil,
                closeCode: code != 0 ? code : nil, closeReason: text
            ))
        }
    }

    private func submitError(_ error: Error, cancelled: Bool, ts: Double) {
        let id = self.id
        let text = cancelled ? "Cancelled" : NetworkErrorText.describe(error)
        StreamPipeline.shared.submit(droppable: false) {
            DurbunCore.shared.send(WireMessage.netError(id: id, ts: ts, error: text, cancelled: cancelled))
        }
    }
}

/// Reads an `NSURLSessionWebSocketMessage` through its public properties.
enum WebSocketPayload {
    private static let typeSelector = NSSelectorFromString("type")
    private static let dataSelector = NSSelectorFromString("data")
    private static let stringSelector = NSSelectorFromString("string")
    /// `NSURLSessionWebSocketMessageTypeData` / `NSURLSessionWebSocketMessageTypeString`.
    private static let dataType = 0
    private static let stringType = 1

    /// Bytes the message keeps alive (cheap: no conversion).
    static func weight(of message: AnyObject) -> Int {
        guard let object = message as? NSObject else { return 0 }
        if object.responds(to: dataSelector), let data = object.value(forKey: "data") as? NSData { return data.length }
        if object.responds(to: stringSelector), let string = object.value(forKey: "string") as? NSString { return string.length * 2 }
        return 0
    }

    static func describe(_ message: AnyObject, cap: Int) -> (opcode: String, size: Int, body: WireBody?)? {
        guard let object = message as? NSObject, object.responds(to: typeSelector),
              let type = (object.value(forKey: "type") as? NSNumber)?.intValue
        else { return nil }
        switch type {
        case dataType:
            guard object.responds(to: dataSelector) else { return nil }
            let data = object.value(forKey: "data") as? Data ?? Data()
            let payload = StreamPayload.binary(data, cap: cap)
            return ("binary", payload.size, payload.body)
        case stringType:
            guard object.responds(to: stringSelector) else { return nil }
            let string = object.value(forKey: "string") as? String ?? ""
            let payload = StreamPayload.text(string, cap: cap)
            return ("text", payload.size, payload.body)
        default:
            return nil
        }
    }
}

/// Polls the tracked tasks on the stream queue: quickly until the 101 arrives (5 ms doubling to 250 ms),
/// every 20 ms while a connection is ending, once a second while it is open. Runs only while a tracked
/// connection exists.
final class WebSocketWatch {
    static let shared = WebSocketWatch()

    private var queue: DispatchQueue { StreamPipeline.shared.queue }
    /* queue only */
    private var connections: [WebSocketConnection] = []
    private var timer: DispatchSourceTimer?
    private var due: DispatchTime?

    func add(_ connection: WebSocketConnection) {
        queue.async {
            self.connections.append(connection)
            self.schedule(after: 0.005)
        }
    }

    func checkSoon() {
        queue.async { self.schedule(after: 0) }
    }

    func forgetAll() {
        queue.async {
            for connection in self.connections { connection.forget() }
            self.connections.removeAll()
            self.timer?.cancel()
            self.timer = nil
            self.due = nil
        }
    }

    /// Tests: the number of connections watched.
    var count: Int { queue.sync { connections.count } }

    private func schedule(after delay: TimeInterval) {
        guard !connections.isEmpty else { return }
        let deadline = DispatchTime.now() + delay
        if let due, due <= deadline { return }
        due = deadline
        if timer == nil {
            let source = DispatchSource.makeTimerSource(queue: queue)
            source.setEventHandler { [weak self] in self?.tick() }
            source.schedule(deadline: deadline, leeway: .milliseconds(2))
            source.resume()
            timer = source
        } else {
            timer?.schedule(deadline: deadline, leeway: .milliseconds(2))
        }
    }

    private func tick() {
        due = nil
        var next: TimeInterval?
        connections = connections.filter { connection in
            guard let delay = connection.poll() else { return false }
            next = min(next ?? delay, delay)
            return true
        }
        if let next {
            schedule(after: next)
        } else {
            timer?.cancel()
            timer = nil
        }
    }
}
